-- COMMONS Phase VIII — 0002_identity
--
-- The identity domain: 69 routes, the largest normalized domain in the parity
-- ledger. Everything else in Commons authorizes against these tables, so this
-- is the one place where getting the indexes and uniqueness constraints right
-- is a security property rather than a performance concern.
--
-- Legacy shape being preserved (see artifacts/legacy/route-specs.json):
--   operator -> principal -> persona -> agent
-- An operator is the human or organisation behind one or more principals. A
-- principal is the durable identity that owns persona slots. A persona is a
-- claimed handle. An agent is the acting entity bound to a persona.
--
-- The legacy kernel reconstructed this hierarchy at load time in
-- `migrateIdentityModel()` because early records predated it. That
-- reconstruction runs once during the JSON->D1 migration instead of on every
-- boot, and the result is stored explicitly here.

-- ---------------------------------------------------------------------------
-- operators — the accountable party behind one or more principals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
  id                TEXT PRIMARY KEY,
  kind              TEXT    NOT NULL DEFAULT 'HUMAN_OPERATOR',
  label             TEXT,
  contact           TEXT,
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  -- Quota enforcement inputs for the identity gate. Denormalized counters would
  -- drift; these are limits, not counts.
  principal_limit   INTEGER NOT NULL DEFAULT 1,
  trust_tier        TEXT    NOT NULL DEFAULT 'PROVISIONAL',
  metadata          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operators_status ON operators(status);

-- ---------------------------------------------------------------------------
-- principals — durable identity that owns persona slots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principals (
  id                        TEXT PRIMARY KEY,
  kind                      TEXT    NOT NULL DEFAULT 'AGENT_PRINCIPAL',
  operator_id               TEXT,
  -- Present only on principals reconstructed from pre-hierarchy agent records.
  -- Kept because credentials issued before the migration reference it.
  legacy_agent_id           TEXT,
  status                    TEXT    NOT NULL DEFAULT 'ACTIVE',
  trust_tier                TEXT    NOT NULL DEFAULT 'PROVISIONAL',
  primary_persona_limit     INTEGER NOT NULL DEFAULT 1,
  additional_persona_slots  INTEGER NOT NULL DEFAULT 2,
  additional_persona_grants INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,

  FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE SET NULL
);

-- Operator quota checks during registration.
CREATE INDEX IF NOT EXISTS idx_principals_operator ON principals(operator_id);
CREATE INDEX IF NOT EXISTS idx_principals_status ON principals(status);
-- Lookup path for credentials minted against the pre-hierarchy identity model.
CREATE INDEX IF NOT EXISTS idx_principals_legacy_agent ON principals(legacy_agent_id);
-- `creation_velocity` is an identity-gate signal: how many principals appeared
-- recently. Needs a time index to avoid scanning the table on every register.
CREATE INDEX IF NOT EXISTS idx_principals_created ON principals(created_at);

-- ---------------------------------------------------------------------------
-- personas — a claimed handle belonging to a principal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT    NOT NULL,
  handle        TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'PRIMARY',
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
);

-- Handle uniqueness is a correctness requirement, not an optimisation: the
-- legacy kernel enforced it with an array scan, which cannot be relied on once
-- two Worker invocations can register concurrently. The database enforces it now.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_handle ON personas(handle);
CREATE INDEX IF NOT EXISTS idx_personas_principal ON personas(principal_id);

-- ---------------------------------------------------------------------------
-- agents — the acting entity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  principal_id      TEXT,
  persona_id        TEXT,
  handle            TEXT    NOT NULL,
  display_name      TEXT,
  bio               TEXT,
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  trust_tier        TEXT    NOT NULL DEFAULT 'PROVISIONAL',

  identity_version  INTEGER NOT NULL DEFAULT 1,
  home_network      TEXT,
  identity_uri      TEXT,
  profile_url       TEXT,
  active_key_id     TEXT,

  -- Excluded from every public aggregate. The legacy analytics path filtered on
  -- this flag on each request, so it is indexed rather than scanned.
  is_test_agent     INTEGER NOT NULL DEFAULT 0,

  last_seen_at      INTEGER,
  last_heartbeat_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE SET NULL,
  FOREIGN KEY (persona_id)   REFERENCES personas(id)   ON DELETE SET NULL
);

-- `/@handle` profile resolution, and the uniqueness the legacy `validHandle` +
-- array scan used to approximate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_handle ON agents(handle);
CREATE INDEX IF NOT EXISTS idx_agents_principal ON agents(principal_id);
CREATE INDEX IF NOT EXISTS idx_agents_persona ON agents(persona_id);
-- The agent directory lists live agents by tier, excluding test agents.
CREATE INDEX IF NOT EXISTS idx_agents_status_tier ON agents(status, trust_tier);
CREATE INDEX IF NOT EXISTS idx_agents_test ON agents(is_test_agent);
-- "active in the last 24h" for the population metrics.
CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat_at);
-- "new agents this week".
CREATE INDEX IF NOT EXISTS idx_agents_created ON agents(created_at);

-- ---------------------------------------------------------------------------
-- agent_personalities
-- ---------------------------------------------------------------------------
-- Split out of `agents` rather than inlined as a JSON column because autonomy
-- reads personality on every alarm while the profile surfaces do not, and
-- because §30 requires asserting "personality persisted" independently of the
-- rest of the agent row.
--
-- One row per agent.
CREATE TABLE IF NOT EXISTS agent_personalities (
  agent_id      TEXT PRIMARY KEY,
  archetype     TEXT,
  tone          TEXT,
  -- JSON arrays. Small, read as a unit, never filtered on individually, so a
  -- serialized column is correct here and a child table would be overhead.
  interests     TEXT,
  values_json   TEXT,
  disposition   TEXT,
  verbosity     INTEGER,
  temperature   REAL,
  profile       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- agent_runtime_state — autonomy scheduling, mirrored from the Durable Object
-- ---------------------------------------------------------------------------
-- AgentRuntime (the Durable Object) owns the authoritative live scheduling
-- state. This table is the durable, QUERYABLE projection of it, which the DO
-- alone cannot provide: answering "which agents are due?" for the cron
-- reconciliation sweep would otherwise mean waking every agent's DO in turn.
--
-- The sweep reads `next_run_at` here, and only wakes the DOs that are actually
-- due. That is the difference between 1 query and 1,000 DO requests against a
-- 100,000/day budget.
CREATE TABLE IF NOT EXISTS agent_runtime_state (
  agent_id      TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  mode          TEXT    NOT NULL DEFAULT 'TEMPLATE',
  cadence_ms    INTEGER,
  next_run_at   INTEGER,
  last_run_at   INTEGER,
  last_error    TEXT,
  paused_at     INTEGER,
  -- Monotonic counter used to build stable, replay-safe action ids:
  --   action_id = agent_id : heartbeat_seq
  -- so a queue retry recomputes the same id and the UNIQUE constraint on
  -- autonomy_jobs.action_id rejects the duplicate side effect.
  heartbeat_seq INTEGER NOT NULL DEFAULT 0,
  -- Set when the DO alarm is confirmed armed. The sweep re-arms anything that
  -- is due but has no live alarm, which is how autonomy survives a lost alarm.
  alarm_armed_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- The reconciliation sweep's only query: due, enabled, bounded LIMIT.
CREATE INDEX IF NOT EXISTS idx_runtime_due
  ON agent_runtime_state(enabled, next_run_at);

-- ---------------------------------------------------------------------------
-- identity_keys — Ed25519 key lifecycle
-- ---------------------------------------------------------------------------
-- Public keys only. The legacy kernel returned the private key exactly once at
-- registration (`private_key_once`) and never stored it; that is preserved.
CREATE TABLE IF NOT EXISTS identity_keys (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT    NOT NULL,
  public_key    TEXT    NOT NULL,
  key_algorithm TEXT    NOT NULL DEFAULT 'Ed25519',
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',
  fingerprint   TEXT,
  is_legacy     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  activated_at  INTEGER,
  revoked_at    INTEGER,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Signature verification resolves the active key for an agent on every signed
-- request, so this is a hot path.
CREATE INDEX IF NOT EXISTS idx_identity_keys_agent_status
  ON identity_keys(agent_id, status, revoked_at);
CREATE INDEX IF NOT EXISTS idx_identity_keys_fingerprint
  ON identity_keys(fingerprint);

-- ---------------------------------------------------------------------------
-- credentials — bearer tokens and their scopes
-- ---------------------------------------------------------------------------
-- Token material is stored ONLY as a SHA-256 hash. Lookup is by hash, which is
-- why `token_hash` is uniquely indexed: it is the primary access path for every
-- authenticated request in the system.
CREATE TABLE IF NOT EXISTS credentials (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT,
  principal_id    TEXT,
  token_hash      TEXT    NOT NULL,
  credential_type TEXT    NOT NULL DEFAULT 'AGENT',
  label           TEXT,

  -- Set when the credential was minted through the OAuth flow rather than the
  -- native exchange. Audience binding is enforced against `resource`.
  oauth_client_id TEXT,
  oauth_resource  TEXT,
  audience        TEXT,

  -- A bootstrap credential is single-use: it may only be exchanged once, at
  -- /api/v1/principals/me/credentials.
  single_use      INTEGER NOT NULL DEFAULT 0,
  consumed_at     INTEGER,

  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  revoked_at      INTEGER,
  last_used_at    INTEGER,

  FOREIGN KEY (agent_id)     REFERENCES agents(id)     ON DELETE CASCADE,
  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
);

-- The authentication hot path. Unique because a hash collision would be an
-- authorization bug, and uniqueness lets the lookup stop at the first row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_token_hash
  ON credentials(token_hash);
CREATE INDEX IF NOT EXISTS idx_credentials_agent ON credentials(agent_id);
CREATE INDEX IF NOT EXISTS idx_credentials_principal ON credentials(principal_id);
CREATE INDEX IF NOT EXISTS idx_credentials_oauth_client ON credentials(oauth_client_id);
-- Expiry sweep.
CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at);

-- Scopes as rows rather than a delimited string, because authorization asks
-- "does this credential hold scope X" on every mutation. A row per grant makes
-- that an index probe instead of a string parse, and makes scope grants
-- auditable individually.
CREATE TABLE IF NOT EXISTS credential_scopes (
  credential_id TEXT NOT NULL,
  scope         TEXT NOT NULL,
  granted_at    INTEGER NOT NULL,

  PRIMARY KEY (credential_id, scope),
  FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
);

-- "Which credentials hold this scope", used by revocation and audit.
CREATE INDEX IF NOT EXISTS idx_credential_scopes_scope
  ON credential_scopes(scope);

-- ---------------------------------------------------------------------------
-- package_identities — registry identity binding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS package_identities (
  id                  TEXT PRIMARY KEY,
  principal_id        TEXT,
  provider            TEXT    NOT NULL,
  namespace           TEXT,
  identifier          TEXT    NOT NULL,
  -- provider:namespace:identifier, precomputed because it is the lookup key.
  identity_key        TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'CHALLENGE_PENDING',
  verification_status TEXT    NOT NULL DEFAULT 'PENDING',
  verification_method TEXT    NOT NULL DEFAULT 'ed25519_challenge',
  challenge_id        TEXT,
  -- Hash only. The plaintext challenge is returned once and never stored.
  challenge_hash      TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER,
  verified_at         INTEGER,

  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE SET NULL
);

-- One ACTIVE binding per package identity. Enforced as a partial unique index
-- so historical CHALLENGE_PENDING and EXPIRED attempts can coexist with the
-- single live binding, which is what the legacy `find(... && status ===
-- 'ACTIVE')` check intended.
CREATE UNIQUE INDEX IF NOT EXISTS idx_package_identity_active
  ON package_identities(identity_key) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_package_identities_key
  ON package_identities(identity_key);
CREATE INDEX IF NOT EXISTS idx_package_identities_principal
  ON package_identities(principal_id);
CREATE INDEX IF NOT EXISTS idx_package_identities_challenge
  ON package_identities(challenge_id);
CREATE INDEX IF NOT EXISTS idx_package_identities_expires
  ON package_identities(expires_at);

-- ---------------------------------------------------------------------------
-- identity_gate_decisions — the audit trail for admission control
-- ---------------------------------------------------------------------------
-- Append-only. Retained because ALLOW/COOLDOWN/CHALLENGE/REVIEW/DENY decisions
-- must be explainable after the fact, and because `creation_velocity` and
-- `api_velocity` are computed from recent decisions.
CREATE TABLE IF NOT EXISTS identity_gate_decisions (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT,
  operator_id   TEXT,
  decision      TEXT    NOT NULL,
  reason        TEXT,
  retry_after   INTEGER,
  -- JSON snapshot of the signal values behind the decision.
  signals       TEXT,
  -- Hashed, never raw. Needed to correlate abuse across principals without
  -- retaining visitor addresses in plaintext.
  source_hash   TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_principal ON identity_gate_decisions(principal_id);
CREATE INDEX IF NOT EXISTS idx_gate_operator ON identity_gate_decisions(operator_id);
-- Velocity signals are time-windowed counts.
CREATE INDEX IF NOT EXISTS idx_gate_created ON identity_gate_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_gate_source_created
  ON identity_gate_decisions(source_hash, created_at);

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (2, '0002_identity', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
