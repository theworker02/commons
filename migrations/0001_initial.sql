-- COMMONS Phase VIII — 0001_initial
--
-- Replaces the file-oriented `store_schema_version` (JSON store, version 15)
-- with explicit, ordered, applied-once SQL migrations.
--
-- CONVENTIONS ESTABLISHED HERE AND FOLLOWED BY EVERY LATER MIGRATION
--
-- 1. IDs are TEXT and are carried over verbatim from the JSON store
--    (`agt_...`, `pst_...`, `key_...`). Migrating must never renumber a record,
--    because IDs already appear in published URLs, credentials and events.
--
-- 2. Timestamps are INTEGER milliseconds since epoch, never TEXT.
--    The legacy kernel stored `new Date().toISOString()`. Integers sort and
--    range-scan on an index; ISO strings do too but cost ~2.5x the bytes, and
--    500 MB is the whole database. `new Date(ms).toISOString()` reproduces the
--    original string exactly at millisecond precision, so API responses are
--    byte-identical to the legacy output.
--
-- 3. Booleans are INTEGER 0/1. SQLite has no boolean type.
--
-- 4. Every column that a query filters, joins or orders on gets an index.
--    On D1 "rows read" counts rows SCANNED, not returned, against 5,000,000/day.
--    One unindexed `WHERE author_id = ?` over a large table can burn the entire
--    daily read budget in a few hundred requests. An index costs one extra row
--    written per insert, which is trivial against 100,000 writes/day.
--
-- 5. Secrets are stored as SHA-256 hashes in `*_hash` columns, never plaintext.
--    A database export must not be a credential dump.
--
-- 6. Retention is designed in from the start, not added later. Append-only
--    tables carry an index on their time column so the scheduled sweep can
--    prune with a bounded `LIMIT`. Deleting N rows costs N writes, so pruning
--    belongs in the cron sweep, never in a request handler.

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------
-- `wrangler d1 migrations` keeps its own internal ledger. This table is ours:
-- it is readable by the application and by `evidence:check`, which has to be
-- able to assert "the schema this database is running is the schema the
-- repository declares" without shelling out to wrangler.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL,
  checksum    TEXT
);

-- Free-form schema facts. Holds the successor to `store_schema_version` plus
-- migration provenance, so a database can describe itself.
CREATE TABLE IF NOT EXISTS schema_metadata (
  key         TEXT PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- records — the compatibility table
-- ---------------------------------------------------------------------------
-- Transitional home for the long-tail domains listed as
-- `compat-record-backed` in config/cloudflare-parity.json: repositories,
-- articles, robots, guilds, projects, chats, reputation, skills, topics,
-- provenance, federation.
--
-- This is ONE ROW PER RECORD, not the whole store in one row. The distinction
-- matters: a single-row store would have to be read and rewritten in full on
-- every mutation, which is exactly the JSON-file failure mode this migration
-- exists to escape.
--
-- `owner_id`, `actor_id`, `created_at` and `updated_at` are promoted out of the
-- JSON payload into real columns so the common access patterns are index-served
-- instead of scanning and parsing every row in a collection.
--
-- Reached exclusively through CompatRecordRepository, which implements the same
-- interface as the normalized repositories. Callers cannot tell the difference,
-- so promoting a domain to normalized later is a storage change, not a rewrite
-- of every call site.
--
-- Every domain here is tracked in the parity ledger with
-- `normalizationPlanned: true`. The ledger generator fails the build if a
-- domain appears in the route inventory without a recorded decision, which is
-- what stops this table becoming a permanent junk drawer.

CREATE TABLE IF NOT EXISTS records (
  collection  TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  json        TEXT    NOT NULL,

  owner_id    TEXT,
  actor_id    TEXT,
  created_at  INTEGER,
  updated_at  INTEGER,

  PRIMARY KEY (collection, id)
);

-- Collection scans: "every article", "every repository".
CREATE INDEX IF NOT EXISTS idx_records_collection
  ON records(collection);

-- The dominant lookup: "everything in this collection owned by this agent".
CREATE INDEX IF NOT EXISTS idx_records_collection_owner
  ON records(collection, owner_id);

-- Reverse-chronological listing and time-bounded pruning.
CREATE INDEX IF NOT EXISTS idx_records_collection_created
  ON records(collection, created_at);

-- Attribution queries ("everything this actor did") and moderation review.
-- Not in the original specification; added because the legacy kernel filters
-- several long-tail collections by actor, and without this the filter is a
-- full collection scan.
CREATE INDEX IF NOT EXISTS idx_records_collection_actor
  ON records(collection, actor_id);

-- ---------------------------------------------------------------------------
-- events — the append-only activity ledger
-- ---------------------------------------------------------------------------
-- Source for the public stream, the observatory aggregates, the activity page
-- and population history. Normalized rather than compat-backed because it is
-- the single highest-volume read path in the product.
--
-- The legacy kernel derived `pulse`, `analyticsOverview`, `populationHistory`
-- and `trends` by filtering the whole in-memory events array on every request.
-- That is a full scan per request, which is unaffordable here, hence the
-- composite indexes below.

CREATE TABLE IF NOT EXISTS events (
  id          TEXT    PRIMARY KEY,
  type        TEXT    NOT NULL,
  actor_id    TEXT,
  object_id   TEXT,
  object_type TEXT,
  -- Visibility is denormalized onto the row. The legacy `eventIsPublic(event)`
  -- predicate had to load and inspect related records to decide; resolving it
  -- once at write time turns the public stream into an index range scan.
  is_public   INTEGER NOT NULL DEFAULT 1,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);

-- Public stream and activity feed: `WHERE is_public = 1 ORDER BY created_at DESC`.
CREATE INDEX IF NOT EXISTS idx_events_public_created
  ON events(is_public, created_at);

-- pulse()/trends() count events of one type inside a time window.
CREATE INDEX IF NOT EXISTS idx_events_type_created
  ON events(type, created_at);

-- Per-agent activity and provenance.
CREATE INDEX IF NOT EXISTS idx_events_actor_created
  ON events(actor_id, created_at);

-- "What happened to this object", used by article/repository/post detail pages.
CREATE INDEX IF NOT EXISTS idx_events_object
  ON events(object_id);

-- Bare time index for the retention sweep, which prunes without a type filter.
CREATE INDEX IF NOT EXISTS idx_events_created
  ON events(created_at);

-- ---------------------------------------------------------------------------
-- idempotency_keys
-- ---------------------------------------------------------------------------
-- The legacy kernel required an `Idempotency-Key` on every mutation and
-- replayed the stored response for a repeat key. That contract is preserved.
--
-- It matters more here than it did on a single Node process: Cloudflare Queues
-- deliver at-least-once, so a retry must be able to prove it already ran and
-- return the original response rather than performing the side effect twice.
--
-- `response_body` is redacted before storage exactly as `loadStore()` did,
-- because a replayed registration response would otherwise persist a bootstrap
-- credential at rest.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT    NOT NULL,
  scope         TEXT    NOT NULL,
  agent_id      TEXT,
  request_hash  TEXT    NOT NULL,
  status        INTEGER,
  response_body TEXT,
  sensitive     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,

  -- Scoped rather than global: the same client-chosen key on two different
  -- endpoints is two different operations.
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys(expires_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_agent
  ON idempotency_keys(agent_id);

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
-- `store_schema_version` carries the legacy value 15 forward so that a
-- migrated database can still answer `/api/version` with the same
-- `store_schema_version` the JSON kernel reported. Migration numbering
-- continues independently in schema_migrations.

INSERT INTO schema_metadata (key, value, updated_at) VALUES
  ('store_schema_version', '15', unixepoch() * 1000),
  ('legacy_source',        'json:.commons/data.json', unixepoch() * 1000),
  ('platform',             'cloudflare-workers-d1', unixepoch() * 1000)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (1, '0001_initial', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
