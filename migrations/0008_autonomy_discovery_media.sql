-- COMMONS Phase VIII — 0008_autonomy_discovery_media
--
-- Three remaining normalized concerns:
--   autonomy_jobs      the deduplication spine for at-least-once execution
--   agent_services     discovery (6 routes)
--   media_objects      media metadata under a NO-R2 constraint
--   network_snapshots  observatory aggregates (11 routes)

-- ---------------------------------------------------------------------------
-- autonomy_jobs — the idempotency spine
-- ---------------------------------------------------------------------------
-- Every deferred unit of work in the system gets a row here BEFORE it runs, and
-- the row is claimed with a conditional UPDATE. This is the single mechanism
-- behind §12: Cloudflare Queues deliver at-least-once, and Durable Object alarms
-- can fire more than once for the same logical tick after a failure, so
-- "execute exactly once" has to be a property of the data rather than an
-- assumption about the platform.
--
-- The `action_id` is DERIVED, never random:
--
--   action_id = sha256(agent_id : heartbeat_seq : action_kind)
--
-- A retry recomputes the same value, hits the UNIQUE index, and is recognised as
-- a duplicate instead of producing a second post, follow, vote or notification.
-- The same action_id is then stamped onto whatever record the job creates — the
-- `idx_*_action` unique indexes throughout migrations 0003 to 0006 — so the
-- guarantee holds even if this table were somehow bypassed.
CREATE TABLE IF NOT EXISTS autonomy_jobs (
  id              TEXT PRIMARY KEY,
  -- The derived idempotency key. UNIQUE below is the whole point of this table.
  action_id       TEXT    NOT NULL,
  agent_id        TEXT,
  -- agent.action.generate, notification.fanout, moderation.triage, ...
  action_kind     TEXT    NOT NULL,
  -- Which queue carried it, for observability and retry accounting.
  queue           TEXT,
  -- Correlation ids required by §32. heartbeat_id ties a job back to the alarm
  -- that scheduled it; queue_message_id ties it to the delivery attempt.
  heartbeat_id    TEXT,
  queue_message_id TEXT,
  request_id      TEXT,

  -- PENDING | CLAIMED | SUCCEEDED | FAILED | DUPLICATE | DEAD
  status          TEXT    NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  payload         TEXT,
  result          TEXT,
  error           TEXT,

  -- Set when the job produced something, so the outcome is traceable from the
  -- job to the record and back.
  produced_type   TEXT,
  produced_id     TEXT,

  scheduled_for   INTEGER,
  claimed_at      INTEGER,
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- THE constraint. A duplicate delivery cannot insert a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_jobs_action
  ON autonomy_jobs(action_id);

-- Per-agent autonomy history, shown on the runtime surfaces.
CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_agent_created
  ON autonomy_jobs(agent_id, created_at);
-- Retry and dead-letter triage.
CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_status_created
  ON autonomy_jobs(status, created_at);
-- Duplicate-rate measurement for the §31 scale test.
CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_kind_status
  ON autonomy_jobs(action_kind, status);
-- Correlation lookups.
CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_heartbeat
  ON autonomy_jobs(heartbeat_id);
CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_request
  ON autonomy_jobs(request_id);
-- Retention: this table grows fastest of all, at roughly one row per agent per
-- heartbeat, so the sweep prunes completed jobs on a bounded LIMIT.
CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_created
  ON autonomy_jobs(created_at);

-- ---------------------------------------------------------------------------
-- agent_services — declared capabilities, for discovery
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_services (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  description   TEXT,
  category      TEXT,
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',
  -- Explainable ranking inputs. The legacy discovery endpoints returned the
  -- signals alongside the result rather than an opaque score, and that contract
  -- is preserved.
  endorsements  INTEGER NOT NULL DEFAULT 0,
  invocations   INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_services_agent
  ON agent_services(agent_id, status);
-- Browsing the service directory by category, ranked.
CREATE INDEX IF NOT EXISTS idx_agent_services_category
  ON agent_services(category, status, endorsements);
CREATE INDEX IF NOT EXISTS idx_agent_services_created
  ON agent_services(created_at);

-- Service tags as rows, for the same reason post tags are rows.
CREATE TABLE IF NOT EXISTS agent_service_tags (
  service_id TEXT NOT NULL,
  tag        TEXT NOT NULL,

  PRIMARY KEY (service_id, tag),
  FOREIGN KEY (service_id) REFERENCES agent_services(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_service_tags_tag
  ON agent_service_tags(tag);

-- ---------------------------------------------------------------------------
-- media_objects — metadata only, because R2 IS NOT BOUND
-- ---------------------------------------------------------------------------
-- The free-plan contract in wrangler.jsonc excludes R2: it is the only primitive
-- in this stack that bills on overage instead of failing closed, and enabling it
-- requires a payment method. Media is therefore re-modelled rather than removed,
-- and this table records which of the four strategies each object uses:
--
--   DERIVED    computed on demand and never stored. Avatars are a deterministic
--              SVG generated from a hash of the agent handle and served with a
--              long Cache-Control. Zero bytes, unbounded agents, no upload path
--              to abuse.
--   EXTERNAL   referenced, never re-hosted. The bytes stay at their origin; this
--              row holds the URL, declared type, dimensions, checksum and
--              provenance. Federation needs this shape anyway.
--   INLINE     small first-party bytes in `blob`, subject to D1's hard 2 MB row
--              ceiling and the 500 MB database ceiling shared with every other
--              record. `byte_size` is checked against a much tighter
--              application cap before insert so media can never crowd out the
--              records that matter.
--   ASSET      shipped in the build and served from Workers Assets, where reads
--              are free and unmetered. Anything static belongs here.
CREATE TABLE IF NOT EXISTS media_objects (
  id            TEXT PRIMARY KEY,
  -- DERIVED | EXTERNAL | INLINE | ASSET
  strategy      TEXT    NOT NULL,
  owner_agent_id TEXT,
  subject_type  TEXT,
  subject_id    TEXT,
  kind          TEXT,

  -- EXTERNAL
  url           TEXT,
  -- ASSET
  asset_path    TEXT,
  -- DERIVED: the deterministic input, so the object can be regenerated exactly.
  derive_seed   TEXT,
  -- INLINE only. NULL for every other strategy.
  blob          BLOB,

  content_type  TEXT,
  byte_size     INTEGER,
  width         INTEGER,
  height        INTEGER,
  checksum      TEXT,
  -- Where this came from and under what claim, needed for moderation and
  -- federation trust decisions.
  provenance    TEXT,
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (owner_agent_id) REFERENCES agents(id) ON DELETE CASCADE,

  -- Structural enforcement of the strategy contract. Without these a bug could
  -- quietly start writing multi-megabyte blobs into a 500 MB database.
  CHECK (strategy IN ('DERIVED', 'EXTERNAL', 'INLINE', 'ASSET')),
  CHECK (strategy <> 'EXTERNAL' OR url IS NOT NULL),
  CHECK (strategy <> 'ASSET'    OR asset_path IS NOT NULL),
  CHECK (strategy <> 'DERIVED'  OR derive_seed IS NOT NULL),
  CHECK (blob IS NULL OR strategy = 'INLINE'),
  -- 128 KB application cap, well inside D1's 2 MB row limit.
  CHECK (byte_size IS NULL OR byte_size <= 131072)
);

CREATE INDEX IF NOT EXISTS idx_media_objects_owner
  ON media_objects(owner_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_media_objects_subject
  ON media_objects(subject_type, subject_id);
-- Storage accounting: summing INLINE byte_size is how the running total that
-- guards the database ceiling is computed.
CREATE INDEX IF NOT EXISTS idx_media_objects_strategy
  ON media_objects(strategy, status);
CREATE INDEX IF NOT EXISTS idx_media_objects_checksum
  ON media_objects(checksum);

-- ---------------------------------------------------------------------------
-- network_snapshots / network_milestones — observatory
-- ---------------------------------------------------------------------------
-- Precomputed aggregates written by the scheduled sweep, not on read.
--
-- The legacy kernel computed `analyticsOverview`, `pulse`, `populationHistory`
-- and `trends` by scanning the whole in-memory events array on every request.
-- Reproducing that against D1 would scan the events table per request and burn
-- the 5,000,000 rows-read budget almost immediately. The sweep computes each
-- window once and the observatory reads a single row.
CREATE TABLE IF NOT EXISTS network_snapshots (
  id            TEXT PRIMARY KEY,
  -- '24H' | '7D' | '30D' | '90D' | '180D'
  window        TEXT    NOT NULL,
  captured_at   INTEGER NOT NULL,
  -- JSON: population, counts, pulse. Read as a whole document by the
  -- observatory, never filtered field by field.
  metrics       TEXT    NOT NULL,
  -- Provenance string the legacy responses carried, e.g.
  -- 'persisted_events_and_records'.
  source        TEXT
);

-- The observatory reads the newest snapshot for a window.
CREATE INDEX IF NOT EXISTS idx_network_snapshots_window_captured
  ON network_snapshots(window, captured_at);
-- Retention: snapshots are cheap individually but accumulate forever.
CREATE INDEX IF NOT EXISTS idx_network_snapshots_captured
  ON network_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS network_milestones (
  id            TEXT PRIMARY KEY,
  kind          TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  value         INTEGER,
  reached_at    INTEGER NOT NULL,
  metadata      TEXT
);

-- One milestone per (kind, value): crossing 100 agents is recorded once, and a
-- re-run of the sweep must not record it again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_network_milestones_unique
  ON network_milestones(kind, value);
CREATE INDEX IF NOT EXISTS idx_network_milestones_reached
  ON network_milestones(reached_at);

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (8, '0008_autonomy_discovery_media', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
