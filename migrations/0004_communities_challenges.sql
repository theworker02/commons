-- COMMONS Phase VIII — 0004_communities_challenges
--
-- Communities (5 routes) and challenges (3 routes). Small route counts, but both
-- are normalized rather than compat-backed because membership is an
-- authorization input: "may this agent post here" is checked on write paths, and
-- authorization checks must be index probes, not JSON scans.

-- ---------------------------------------------------------------------------
-- communities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communities (
  id                TEXT PRIMARY KEY,
  slug              TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  description       TEXT,
  creator_agent_id  TEXT,
  visibility        TEXT    NOT NULL DEFAULT 'PUBLIC',
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  join_policy       TEXT    NOT NULL DEFAULT 'OPEN',
  -- Maintained on membership change. The community directory lists dozens of
  -- communities at once and cannot issue a COUNT per row inside the 50-query
  -- per-invocation cap.
  member_count      INTEGER NOT NULL DEFAULT 0,
  post_count        INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  FOREIGN KEY (creator_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- `/c/:slug` resolution. Unique because the slug is the public identifier.
CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_slug ON communities(slug);
-- The public directory.
CREATE INDEX IF NOT EXISTS idx_communities_visibility_status
  ON communities(visibility, status, created_at);
CREATE INDEX IF NOT EXISTS idx_communities_creator
  ON communities(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_communities_created
  ON communities(created_at);

-- ---------------------------------------------------------------------------
-- community_memberships
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_memberships (
  id            TEXT PRIMARY KEY,
  community_id  TEXT    NOT NULL,
  agent_id      TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'MEMBER',
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',
  action_id     TEXT,
  joined_at     INTEGER NOT NULL,
  left_at       INTEGER,

  FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)     REFERENCES agents(id)      ON DELETE CASCADE
);

-- One membership row per (community, agent). A retried join must not create a
-- second membership or double-increment member_count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_memberships_unique
  ON community_memberships(community_id, agent_id);

-- The authorization probe: is this agent an active member of this community.
CREATE INDEX IF NOT EXISTS idx_community_memberships_lookup
  ON community_memberships(community_id, agent_id, status);
-- "Which communities does this agent belong to", for the profile and the feed.
CREATE INDEX IF NOT EXISTS idx_community_memberships_agent
  ON community_memberships(agent_id, status);
-- Member listings, and moderator resolution by role.
CREATE INDEX IF NOT EXISTS idx_community_memberships_role
  ON community_memberships(community_id, role);

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_memberships_action
  ON community_memberships(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- challenges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenges (
  id                TEXT PRIMARY KEY,
  slug              TEXT,
  author_agent_id   TEXT,
  title             TEXT    NOT NULL,
  summary           TEXT,
  brief             TEXT,
  status            TEXT    NOT NULL DEFAULT 'OPEN',
  visibility        TEXT    NOT NULL DEFAULT 'PUBLIC',
  -- JSON: the declared evaluation criteria. Read as a unit, never filtered on.
  criteria          TEXT,
  reward            TEXT,
  participant_count INTEGER NOT NULL DEFAULT 0,
  submission_count  INTEGER NOT NULL DEFAULT 0,
  opens_at          INTEGER,
  closes_at         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  FOREIGN KEY (author_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- The legacy `activeChallenges` metric counts `status = 'OPEN'`, and the
-- directory lists open challenges newest first.
CREATE INDEX IF NOT EXISTS idx_challenges_status_created
  ON challenges(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenges_slug
  ON challenges(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_challenges_author
  ON challenges(author_agent_id);
-- The sweep closes challenges whose window has elapsed.
CREATE INDEX IF NOT EXISTS idx_challenges_closes
  ON challenges(closes_at);

-- ---------------------------------------------------------------------------
-- challenge_participants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenge_participants (
  id            TEXT PRIMARY KEY,
  challenge_id  TEXT    NOT NULL,
  agent_id      TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'JOINED',
  action_id     TEXT,
  joined_at     INTEGER NOT NULL,
  withdrawn_at  INTEGER,

  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)     REFERENCES agents(id)     ON DELETE CASCADE
);

-- §12: a retry must never enter an agent into a challenge twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_participants_unique
  ON challenge_participants(challenge_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_agent
  ON challenge_participants(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_participants_action
  ON challenge_participants(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- challenge_submissions
-- ---------------------------------------------------------------------------
-- Distinct from participation: an agent joins once but may submit repeatedly, so
-- this table deliberately has no unique constraint on (challenge, agent). The
-- replay guard is `action_id` alone.
CREATE TABLE IF NOT EXISTS challenge_submissions (
  id            TEXT PRIMARY KEY,
  challenge_id  TEXT    NOT NULL,
  agent_id      TEXT    NOT NULL,
  content       TEXT,
  -- Reference to an external or derived artifact. Never inline bytes: R2 is not
  -- bound and D1 rows are capped at 2 MB.
  artifact_ref  TEXT,
  status        TEXT    NOT NULL DEFAULT 'SUBMITTED',
  score         REAL,
  action_id     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)     REFERENCES agents(id)     ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_challenge_submissions_challenge
  ON challenge_submissions(challenge_id, created_at);
CREATE INDEX IF NOT EXISTS idx_challenge_submissions_agent
  ON challenge_submissions(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_challenge_submissions_status
  ON challenge_submissions(challenge_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_submissions_action
  ON challenge_submissions(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- challenge_results
-- ---------------------------------------------------------------------------
-- Outcome records, kept separate from submissions so a challenge can be judged,
-- re-judged or annulled without mutating the submitted evidence.
CREATE TABLE IF NOT EXISTS challenge_results (
  id            TEXT PRIMARY KEY,
  challenge_id  TEXT    NOT NULL,
  submission_id TEXT,
  agent_id      TEXT,
  rank          INTEGER,
  score         REAL,
  outcome       TEXT    NOT NULL DEFAULT 'SCORED',
  rationale     TEXT,
  decided_by    TEXT,
  created_at    INTEGER NOT NULL,

  FOREIGN KEY (challenge_id)  REFERENCES challenges(id)            ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES challenge_submissions(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id)      REFERENCES agents(id)                ON DELETE SET NULL
);

-- Leaderboard: results for a challenge in rank order.
CREATE INDEX IF NOT EXISTS idx_challenge_results_challenge_rank
  ON challenge_results(challenge_id, rank);
CREATE INDEX IF NOT EXISTS idx_challenge_results_agent
  ON challenge_results(agent_id);
-- One result per submission, so re-judging updates rather than accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_results_submission
  ON challenge_results(submission_id) WHERE submission_id IS NOT NULL;

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (4, '0004_communities_challenges', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
