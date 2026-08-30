-- COMMONS Phase VIII — 0007_oauth
--
-- OAuth 2.1 authorization server (14 routes) and the MCP pairing console.
--
-- §18 requires the security posture to survive the migration unchanged:
-- dynamic client registration, pairing-console consent, PKCE S256, exact
-- redirect URI matching, short-lived single-use authorization codes, narrow
-- default MCP scopes, audience-bound access tokens, refresh rotation,
-- revocation, and rate-limited registration.
--
-- Several of those are enforced here in the schema rather than left to handler
-- code, because a missed check in a handler is a token-forgery bug:
--
--   * every secret is stored as a SHA-256 hash, so a database dump is not a
--     credential dump and `SELECT *` in a log cannot leak a live token
--   * single-use codes carry `consumed_at` and are claimed with a conditional
--     UPDATE, making replay detectable rather than merely unlikely
--   * refresh rotation is modelled as an explicit `replaced_by` chain, so a
--     replayed old refresh token is provably a reuse and can revoke the family
--   * redirect URIs are rows, not a delimited string, so matching is an equality
--     probe and cannot degrade into a prefix or substring comparison

-- ---------------------------------------------------------------------------
-- oauth_clients — dynamic client registration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                          TEXT PRIMARY KEY,
  client_id                   TEXT    NOT NULL,
  -- NULL for public clients. Public + PKCE is the expected MCP shape; a
  -- confidential client is the exception.
  client_secret_hash          TEXT,
  client_name                 TEXT,
  client_uri                  TEXT,
  logo_uri                    TEXT,
  software_id                 TEXT,
  software_version            TEXT,
  token_endpoint_auth_method  TEXT    NOT NULL DEFAULT 'none',
  grant_types                 TEXT    NOT NULL DEFAULT 'authorization_code,refresh_token',
  response_types              TEXT    NOT NULL DEFAULT 'code',
  -- Space-delimited, mirroring the RFC 7591 registration response. Authorization
  -- narrows the request against this set; it is never widened from it.
  scope                       TEXT,
  -- Registration is DCR-open, so it is rate limited and attributable. The hash
  -- of the registering source is retained instead of the address itself.
  registration_source_hash    TEXT,
  -- Returned once at registration and required to update the registration.
  registration_access_token_hash TEXT,
  status                      TEXT    NOT NULL DEFAULT 'ACTIVE',
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  disabled_at                 INTEGER
);

-- The token and authorize endpoints resolve the client on every call.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_client_id
  ON oauth_clients(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_reg_token
  ON oauth_clients(registration_access_token_hash)
  WHERE registration_access_token_hash IS NOT NULL;
-- Registration rate limiting: how many clients did this source register recently.
CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_created
  ON oauth_clients(registration_source_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_status
  ON oauth_clients(status);

-- Redirect URIs as rows. Exact-match validation becomes
-- `WHERE client_id = ? AND redirect_uri = ?`, which cannot accidentally become
-- a prefix match the way string containment checks do.
CREATE TABLE IF NOT EXISTS oauth_client_redirect_uris (
  client_id     TEXT    NOT NULL,
  redirect_uri  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,

  PRIMARY KEY (client_id, redirect_uri),
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- oauth_authorizations — a durable grant, surviving individual tokens
-- ---------------------------------------------------------------------------
-- The consent record. Distinct from the code and the tokens it produces, so
-- that revoking consent revokes the whole family at once and so the pairing
-- console can show what an agent has actually approved.
CREATE TABLE IF NOT EXISTS oauth_authorizations (
  id            TEXT PRIMARY KEY,
  client_id     TEXT    NOT NULL,
  agent_id      TEXT,
  principal_id  TEXT,
  scope         TEXT    NOT NULL,
  -- The audience this grant is bound to. Access tokens minted from it must
  -- match, which is what stops a token issued for one resource being replayed
  -- against another.
  resource      TEXT,
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',
  -- How consent was obtained: 'pairing_console' for the browser-confirmed flow.
  consent_source TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  revoked_at    INTEGER,

  FOREIGN KEY (client_id)    REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)     REFERENCES agents(id)               ON DELETE CASCADE,
  FOREIGN KEY (principal_id) REFERENCES principals(id)           ON DELETE CASCADE
);

-- One live grant per (client, agent, resource): re-authorizing updates scope
-- rather than accumulating parallel grants that would each need revoking.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_authorizations_live
  ON oauth_authorizations(client_id, agent_id, resource)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_agent
  ON oauth_authorizations(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_client
  ON oauth_authorizations(client_id, status);

-- ---------------------------------------------------------------------------
-- oauth_codes — short-lived, single-use authorization codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_codes (
  id                    TEXT PRIMARY KEY,
  code_hash             TEXT    NOT NULL,
  client_id             TEXT    NOT NULL,
  authorization_id      TEXT,
  agent_id              TEXT,
  -- Must equal the value sent to /authorize, and is re-checked at /token.
  redirect_uri          TEXT    NOT NULL,
  scope                 TEXT    NOT NULL,
  resource              TEXT,
  -- PKCE. S256 only: the method is stored so a downgrade to `plain` is visible
  -- in the data rather than implicit, and the handler rejects anything else.
  code_challenge        TEXT    NOT NULL,
  code_challenge_method TEXT    NOT NULL DEFAULT 'S256',
  -- Single use. Claiming a code is a conditional UPDATE on this column, so a
  -- concurrent second redemption loses the race and is detected as a replay.
  consumed_at           INTEGER,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,

  FOREIGN KEY (client_id)        REFERENCES oauth_clients(client_id)  ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES oauth_authorizations(id)  ON DELETE CASCADE
);

-- Redemption looks the code up by hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_codes_hash
  ON oauth_codes(code_hash);
-- Expiry sweep. Codes are short-lived and high-churn, so this is pruned often.
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires
  ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client
  ON oauth_codes(client_id);

-- ---------------------------------------------------------------------------
-- oauth_access_tokens
-- ---------------------------------------------------------------------------
-- Stored hashed. `audience` is mandatory in practice: MCP tokens are bound to
-- the resource they were issued for, and validation compares the presented
-- token's audience against the requested resource before honouring it.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT    NOT NULL,
  client_id         TEXT    NOT NULL,
  authorization_id  TEXT,
  agent_id          TEXT,
  scope             TEXT    NOT NULL,
  audience          TEXT,
  resource          TEXT,
  -- Links back to the credential row so a token issued through OAuth and one
  -- issued natively authorize through exactly the same code path.
  credential_id     TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  last_used_at      INTEGER,

  FOREIGN KEY (client_id)        REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES oauth_authorizations(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id)    REFERENCES credentials(id)          ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_access_tokens_hash
  ON oauth_access_tokens(token_hash);
-- Revoking a grant revokes its tokens.
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_authorization
  ON oauth_access_tokens(authorization_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_agent
  ON oauth_access_tokens(agent_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_expires
  ON oauth_access_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- oauth_refresh_tokens — with rotation
-- ---------------------------------------------------------------------------
-- Rotation is explicit: redeeming a refresh token marks it consumed and records
-- the id of its successor in `replaced_by`. That turns reuse of an already
-- rotated token into a detectable event rather than a silent re-issue, which is
-- the standard signal that a refresh token has been exfiltrated. On detection
-- the correct response is to revoke the entire `family_id`.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT    NOT NULL,
  client_id         TEXT    NOT NULL,
  authorization_id  TEXT,
  agent_id          TEXT,
  scope             TEXT    NOT NULL,
  audience          TEXT,
  resource          TEXT,
  -- Constant across a rotation chain, so one UPDATE can revoke every descendant
  -- of a compromised token.
  family_id         TEXT    NOT NULL,
  replaced_by       TEXT,
  consumed_at       INTEGER,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  revoked_at        INTEGER,

  FOREIGN KEY (client_id)        REFERENCES oauth_clients(client_id)   ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES oauth_authorizations(id)   ON DELETE CASCADE,
  FOREIGN KEY (replaced_by)      REFERENCES oauth_refresh_tokens(id)   ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_hash
  ON oauth_refresh_tokens(token_hash);
-- Family revocation on detected reuse.
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens(family_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_authorization
  ON oauth_refresh_tokens(authorization_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expires
  ON oauth_refresh_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- pairing_sessions — the MCP device-style pairing flow
-- ---------------------------------------------------------------------------
-- Modelled on the OAuth device authorization grant: a local MCP client requests
-- a pairing, a human confirms it in a browser at /mcp, and only then is a
-- credential minted.
--
-- The credential is created at DELIVERY time, not at approval time, so no usable
-- token is ever stored at rest waiting to be collected. The client proves it is
-- the same client that requested the pairing by presenting the device secret,
-- which is itself only stored hashed.
CREATE TABLE IF NOT EXISTS pairing_sessions (
  id                  TEXT PRIMARY KEY,
  -- Short, human-transcribable code shown in the console.
  user_code           TEXT    NOT NULL,
  device_secret_hash  TEXT    NOT NULL,
  -- PENDING | APPROVED | DENIED | DELIVERED | EXPIRED
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  client_name         TEXT,
  client_version      TEXT,
  -- Space-delimited. Deliberately narrow by default per §18.
  scopes              TEXT    NOT NULL,
  agent_id            TEXT,
  principal_id        TEXT,
  persona_id          TEXT,
  handle              TEXT,
  credential_id       TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  approved_at         INTEGER,
  denied_at           INTEGER,
  delivered_at        INTEGER,

  FOREIGN KEY (agent_id)      REFERENCES agents(id)      ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL
);

-- The console looks a pairing up by the code the human typed. Unique among live
-- sessions only: codes are short and therefore recycled once expired, so a
-- global unique index would eventually collide on legitimately dead rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_sessions_live_code
  ON pairing_sessions(user_code)
  WHERE status IN ('PENDING', 'APPROVED');
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_code
  ON pairing_sessions(user_code);
-- Polling clients check status; the sweep expires abandoned sessions.
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_status_expires
  ON pairing_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_agent
  ON pairing_sessions(agent_id);

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (7, '0007_oauth', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
