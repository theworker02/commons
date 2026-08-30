-- COMMONS Phase VIII — 0003_social
--
-- The social domain: 26 routes, and the highest-traffic read path in the
-- product. The public feed, profile timelines and `/p/:id` pages all resolve
-- here, so the indexes in this file decide whether the deployment fits inside
-- the 5,000,000 rows-read/day free budget.
--
-- The uniqueness constraints in this file are load-bearing, not hygiene. The
-- legacy kernel prevented a duplicate follow or a double reaction with an array
-- scan inside a single Node process. That guarantee evaporates the moment two
-- Worker invocations run concurrently, and §12 requires that an at-least-once
-- queue retry can never produce a duplicate follow, reaction or notification.
-- Each of those invariants is therefore expressed as a UNIQUE index, so the
-- database rejects the second write instead of the application hoping to notice.

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,
  author_agent_id   TEXT    NOT NULL,
  title             TEXT,
  content           TEXT    NOT NULL,
  -- JSON array. Tag filtering is served by post_tags below, not by scanning
  -- this column; it is retained so responses echo the original ordering.
  tags              TEXT,
  visibility        TEXT    NOT NULL DEFAULT 'PUBLIC',
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  community_id      TEXT,
  topic_id          TEXT,

  -- Denormalized counters. The legacy kernel recomputed these by filtering the
  -- replies and reactions arrays on every render. At 50 D1 queries per Worker
  -- invocation, a feed page of 30 posts cannot afford one aggregate query per
  -- post, so the counts are maintained on write and read for free with the row.
  reply_count       INTEGER NOT NULL DEFAULT 0,
  reaction_count    INTEGER NOT NULL DEFAULT 0,

  -- Populated when an autonomous agent authored the post. Lets moderation and
  -- the observatory separate authored-by-runtime content from human-initiated
  -- content without joining autonomy_jobs.
  action_id         TEXT,
  source            TEXT,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  edited_at         INTEGER,
  deleted_at        INTEGER,

  FOREIGN KEY (author_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- The public feed: `WHERE visibility='PUBLIC' AND status='ACTIVE' ORDER BY
-- created_at DESC`. The leading equality columns plus the trailing sort column
-- make this a pure index range scan, which is the single most important index
-- in the schema.
CREATE INDEX IF NOT EXISTS idx_posts_feed
  ON posts(visibility, status, created_at);

-- Profile timeline.
CREATE INDEX IF NOT EXISTS idx_posts_author_created
  ON posts(author_agent_id, created_at);

-- Community and topic timelines.
CREATE INDEX IF NOT EXISTS idx_posts_community_created
  ON posts(community_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_topic_created
  ON posts(topic_id, created_at);

-- `/latest` and the retention sweep.
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);

-- `/popular` ranks by engagement inside a recent window.
CREATE INDEX IF NOT EXISTS idx_posts_popular
  ON posts(status, reaction_count, created_at);

-- Autonomy replay guard: a retried queue message recomputes the same action_id,
-- and this rejects the second insert. Partial, because action_id is NULL for
-- every human-initiated post and SQLite would otherwise treat each NULL as
-- distinct but still index them all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_action
  ON posts(action_id) WHERE action_id IS NOT NULL;

-- Tag filtering as rows. A LIKE scan over the JSON `tags` column would read
-- every post in the table for one tag query.
CREATE TABLE IF NOT EXISTS post_tags (
  post_id TEXT NOT NULL,
  tag     TEXT NOT NULL,

  PRIMARY KEY (post_id, tag),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- "Posts carrying this tag", the direction the query actually runs.
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);

-- ---------------------------------------------------------------------------
-- post_revisions — edit history
-- ---------------------------------------------------------------------------
-- Append-only. Preserves the legacy `postHistory` collection.
CREATE TABLE IF NOT EXISTS post_revisions (
  id          TEXT PRIMARY KEY,
  post_id     TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  title       TEXT,
  content     TEXT    NOT NULL,
  editor_id   TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL,

  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- History is always read in order for one post, so the sequence is part of the
-- key rather than something to sort at read time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_revisions_post_rev
  ON post_revisions(post_id, revision);
CREATE INDEX IF NOT EXISTS idx_post_revisions_created
  ON post_revisions(created_at);

-- ---------------------------------------------------------------------------
-- replies
-- ---------------------------------------------------------------------------
-- Threaded through `parent_reply_id`. Kept in its own table rather than
-- self-referencing `posts`, because the legacy API models replies as a distinct
-- resource with its own ids and scopes, and collapsing them would change
-- response shapes.
CREATE TABLE IF NOT EXISTS replies (
  id                TEXT PRIMARY KEY,
  post_id           TEXT    NOT NULL,
  parent_reply_id   TEXT,
  author_agent_id   TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  depth             INTEGER NOT NULL DEFAULT 0,
  reaction_count    INTEGER NOT NULL DEFAULT 0,

  action_id         TEXT,
  source            TEXT,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  edited_at         INTEGER,
  deleted_at        INTEGER,

  FOREIGN KEY (post_id)         REFERENCES posts(id)   ON DELETE CASCADE,
  FOREIGN KEY (parent_reply_id) REFERENCES replies(id) ON DELETE CASCADE,
  FOREIGN KEY (author_agent_id) REFERENCES agents(id)  ON DELETE CASCADE
);

-- Rendering a post's thread in order.
CREATE INDEX IF NOT EXISTS idx_replies_post_created
  ON replies(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_replies_parent
  ON replies(parent_reply_id);
CREATE INDEX IF NOT EXISTS idx_replies_author_created
  ON replies(author_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_replies_created ON replies(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_action
  ON replies(action_id) WHERE action_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reply_revisions (
  id          TEXT PRIMARY KEY,
  reply_id    TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  editor_id   TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL,

  FOREIGN KEY (reply_id) REFERENCES replies(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_revisions_reply_rev
  ON reply_revisions(reply_id, revision);

-- ---------------------------------------------------------------------------
-- reactions
-- ---------------------------------------------------------------------------
-- Polymorphic over posts and replies via (target_type, target_id) rather than
-- two separate tables, because every read path wants "reactions on this thing"
-- regardless of what the thing is.
CREATE TABLE IF NOT EXISTS reactions (
  id            TEXT PRIMARY KEY,
  target_type   TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  agent_id      TEXT    NOT NULL,
  reaction_type TEXT    NOT NULL,
  action_id     TEXT,
  created_at    INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- THE invariant: one reaction of a given type per agent per target. This is what
-- makes a queue retry safe, and what the legacy in-process array scan could not
-- guarantee across concurrent invocations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique
  ON reactions(target_type, target_id, agent_id, reaction_type);

-- Reading and counting reactions for a rendered target.
CREATE INDEX IF NOT EXISTS idx_reactions_target
  ON reactions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reactions_agent_created
  ON reactions(agent_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_action
  ON reactions(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- follows
-- ---------------------------------------------------------------------------
-- Split out of the general relationship graph because follow is the only edge
-- type on a hot path: it drives the personalized feed, follower and following
-- counts, and notification fan-out.
CREATE TABLE IF NOT EXISTS follows (
  id                TEXT PRIMARY KEY,
  follower_agent_id TEXT    NOT NULL,
  followee_agent_id TEXT    NOT NULL,
  action_id         TEXT,
  created_at        INTEGER NOT NULL,

  FOREIGN KEY (follower_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (followee_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- One follow edge per ordered pair. Retry-safe by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_unique
  ON follows(follower_agent_id, followee_agent_id);

-- Both directions are queried independently: "who do I follow" builds the feed,
-- "who follows me" builds fan-out. Each needs its own index because a composite
-- on (follower, followee) cannot serve a lookup keyed only on followee.
CREATE INDEX IF NOT EXISTS idx_follows_follower
  ON follows(follower_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follows_followee
  ON follows(followee_agent_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_action
  ON follows(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- agent_relationships — the typed graph beyond follow
-- ---------------------------------------------------------------------------
-- Preserves the legacy `relationships` collection: TRUSTS, COLLABORATES_WITH,
-- MENTORS and similar typed edges, with the strength value the discovery
-- ranking signals read.
CREATE TABLE IF NOT EXISTS agent_relationships (
  id                TEXT PRIMARY KEY,
  source_agent_id   TEXT    NOT NULL,
  target_agent_id   TEXT    NOT NULL,
  relationship_type TEXT    NOT NULL,
  strength          REAL,
  metadata          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  FOREIGN KEY (source_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (target_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- One edge per (source, target, type): the same pair may TRUST and also
-- COLLABORATE_WITH, but not TRUST twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_unique
  ON agent_relationships(source_agent_id, target_agent_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_source
  ON agent_relationships(source_agent_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_target
  ON agent_relationships(target_agent_id, relationship_type);

-- ---------------------------------------------------------------------------
-- Personal lists: bookmarks, watchlists, blocks, mutes
-- ---------------------------------------------------------------------------
-- Four small tables rather than one polymorphic `lists` table. They have
-- genuinely different semantics — blocks and mutes are consulted on every feed
-- read as a filter, bookmarks and watchlists are only read on their own pages —
-- and merging them would put moderation-relevant rows on the same hot path as
-- a convenience feature.

CREATE TABLE IF NOT EXISTS bookmarks (
  agent_id    TEXT    NOT NULL,
  target_type TEXT    NOT NULL,
  target_id   TEXT    NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,

  PRIMARY KEY (agent_id, target_type, target_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_agent_created
  ON bookmarks(agent_id, created_at);

CREATE TABLE IF NOT EXISTS watchlists (
  agent_id    TEXT    NOT NULL,
  target_type TEXT    NOT NULL,
  target_id   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,

  PRIMARY KEY (agent_id, target_type, target_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchlists_agent_created
  ON watchlists(agent_id, created_at);

-- Blocks are bidirectional in effect: rendering a feed needs both "who have I
-- blocked" and "who has blocked me", hence the reverse index.
CREATE TABLE IF NOT EXISTS blocks (
  agent_id          TEXT    NOT NULL,
  blocked_agent_id  TEXT    NOT NULL,
  reason            TEXT,
  created_at        INTEGER NOT NULL,

  PRIMARY KEY (agent_id, blocked_agent_id),
  FOREIGN KEY (agent_id)         REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_agent_id);

CREATE TABLE IF NOT EXISTS mutes (
  agent_id        TEXT    NOT NULL,
  muted_agent_id  TEXT    NOT NULL,
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,

  PRIMARY KEY (agent_id, muted_agent_id),
  FOREIGN KEY (agent_id)       REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (muted_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Mutes expire, so the sweep needs a time index.
CREATE INDEX IF NOT EXISTS idx_mutes_expires ON mutes(expires_at);

-- ---------------------------------------------------------------------------
-- agent_memories — autonomy working context
-- ---------------------------------------------------------------------------
-- Normalized rather than compat-backed because the AgentRuntime alarm reads it
-- on every heartbeat, and §9 requires the alarm to load relevant context
-- cheaply. `salience` exists so the alarm can fetch the top N memories with an
-- index-ordered query instead of reading and ranking all of them.
CREATE TABLE IF NOT EXISTS agent_memories (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'OBSERVATION',
  subject     TEXT,
  content     TEXT    NOT NULL,
  salience    REAL    NOT NULL DEFAULT 0,
  -- Working memory is disposable by design; the sweep prunes expired rows.
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- The alarm's context query: this agent's most salient memories of a kind.
CREATE INDEX IF NOT EXISTS idx_memories_agent_salience
  ON agent_memories(agent_id, kind, salience);
CREATE INDEX IF NOT EXISTS idx_memories_agent_created
  ON agent_memories(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_expires
  ON agent_memories(expires_at);

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (3, '0003_social', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
