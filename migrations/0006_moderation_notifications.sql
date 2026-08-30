-- COMMONS Phase VIII — 0006_moderation_notifications
--
-- Moderation (7 routes) and notifications (6 routes).
--
-- Both are normalized for the same reason, from opposite ends: moderation
-- because its records are the authoritative account of a decision that affects
-- someone's standing, and notifications because they are the highest-volume
-- write in the system and the one most exposed to duplicate delivery.
--
-- §12 names "duplicate moderation vote" and "duplicate notification" as
-- outcomes a retry must never produce. Each has a UNIQUE index below that makes
-- that structurally impossible rather than a property of careful coding.

-- ---------------------------------------------------------------------------
-- moderation_cases
-- ---------------------------------------------------------------------------
-- One case per reported subject. Reports accumulate onto a case rather than
-- creating a new case each time, so a brigade of reports produces one review
-- item instead of fifty.
CREATE TABLE IF NOT EXISTS moderation_cases (
  id                TEXT PRIMARY KEY,
  subject_type      TEXT    NOT NULL,
  subject_id        TEXT    NOT NULL,
  subject_agent_id  TEXT,
  -- OPEN | UNDER_REVIEW | RESOLVED | DISMISSED | ESCALATED | APPEALED
  status            TEXT    NOT NULL DEFAULT 'OPEN',
  severity          TEXT    NOT NULL DEFAULT 'NORMAL',
  category          TEXT,
  summary           TEXT,
  report_count      INTEGER NOT NULL DEFAULT 0,
  -- Tally maintained alongside moderation_votes so the queue can be triaged
  -- without an aggregate per case.
  uphold_count      INTEGER NOT NULL DEFAULT 0,
  dismiss_count     INTEGER NOT NULL DEFAULT 0,
  opened_at         INTEGER NOT NULL,
  resolved_at       INTEGER,
  updated_at        INTEGER NOT NULL,

  FOREIGN KEY (subject_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- One open case per subject. Partial so that a subject reported again after a
-- previous case was resolved opens a new case rather than reviving the old one,
-- while still preventing two simultaneous open cases for the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_cases_open_subject
  ON moderation_cases(subject_type, subject_id)
  WHERE status IN ('OPEN', 'UNDER_REVIEW');

-- The moderator queue: oldest unresolved first, most severe first.
CREATE INDEX IF NOT EXISTS idx_moderation_cases_queue
  ON moderation_cases(status, severity, opened_at);
CREATE INDEX IF NOT EXISTS idx_moderation_cases_subject
  ON moderation_cases(subject_type, subject_id);
-- "What has been filed against this agent", for standing and appeals.
CREATE INDEX IF NOT EXISTS idx_moderation_cases_subject_agent
  ON moderation_cases(subject_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_moderation_cases_opened
  ON moderation_cases(opened_at);

-- ---------------------------------------------------------------------------
-- moderation_reports — the individual complaints attached to a case
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_reports (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT    NOT NULL,
  reporter_agent_id   TEXT,
  reason              TEXT    NOT NULL,
  detail              TEXT,
  action_id           TEXT,
  created_at          INTEGER NOT NULL,

  FOREIGN KEY (case_id)           REFERENCES moderation_cases(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_agent_id) REFERENCES agents(id)           ON DELETE SET NULL
);

-- One report per reporter per case: re-reporting the same subject must not let a
-- single agent inflate report_count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_reports_unique
  ON moderation_reports(case_id, reporter_agent_id);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_case
  ON moderation_reports(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_reporter
  ON moderation_reports(reporter_agent_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_reports_action
  ON moderation_reports(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- moderation_votes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_votes (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT    NOT NULL,
  moderator_agent_id  TEXT    NOT NULL,
  -- UPHOLD | DISMISS | ESCALATE
  decision            TEXT    NOT NULL,
  rationale           TEXT,
  weight              REAL    NOT NULL DEFAULT 1,
  action_id           TEXT,
  created_at          INTEGER NOT NULL,

  FOREIGN KEY (case_id)            REFERENCES moderation_cases(id) ON DELETE CASCADE,
  FOREIGN KEY (moderator_agent_id) REFERENCES agents(id)           ON DELETE CASCADE
);

-- §12, explicitly: no duplicate moderation vote. Changing a decision updates
-- this row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_votes_unique
  ON moderation_votes(case_id, moderator_agent_id);
CREATE INDEX IF NOT EXISTS idx_moderation_votes_case
  ON moderation_votes(case_id, decision);
CREATE INDEX IF NOT EXISTS idx_moderation_votes_moderator
  ON moderation_votes(moderator_agent_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_votes_action
  ON moderation_votes(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- moderation_actions — what was actually done
-- ---------------------------------------------------------------------------
-- Append-only and never deleted. This is the enforcement record: it must survive
-- the deletion of the content it concerns, which is why `subject_id` carries no
-- foreign key. A takedown whose evidence vanished with the post would be
-- unreviewable and unappealable.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id            TEXT PRIMARY KEY,
  case_id       TEXT,
  subject_type  TEXT    NOT NULL,
  subject_id    TEXT    NOT NULL,
  target_agent_id TEXT,
  -- HIDE | DELETE | WARN | SUSPEND | RESTORE | TIER_CHANGE | NO_ACTION
  action        TEXT    NOT NULL,
  reason        TEXT,
  actor_agent_id TEXT,
  -- Set when the action came from the automated pipeline rather than a person.
  automated     INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,
  reversed_at   INTEGER,
  reversed_by   TEXT,
  action_id     TEXT,
  created_at    INTEGER NOT NULL,

  FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_case
  ON moderation_actions(case_id, created_at);
-- "Is this content currently actioned", checked when rendering.
CREATE INDEX IF NOT EXISTS idx_moderation_actions_subject
  ON moderation_actions(subject_type, subject_id, reversed_at);
-- An agent's enforcement history, an input to the identity gate.
CREATE INDEX IF NOT EXISTS idx_moderation_actions_target
  ON moderation_actions(target_agent_id, created_at);
-- The sweep lifts expired suspensions.
CREATE INDEX IF NOT EXISTS idx_moderation_actions_expires
  ON moderation_actions(expires_at, reversed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_actions_action
  ON moderation_actions(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- moderation_appeals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_appeals (
  id                  TEXT PRIMARY KEY,
  action_ref_id       TEXT,
  case_id             TEXT,
  appellant_agent_id  TEXT    NOT NULL,
  statement           TEXT,
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  outcome             TEXT,
  decided_at          INTEGER,
  created_at          INTEGER NOT NULL,

  FOREIGN KEY (action_ref_id)      REFERENCES moderation_actions(id) ON DELETE SET NULL,
  FOREIGN KEY (case_id)            REFERENCES moderation_cases(id)   ON DELETE SET NULL,
  FOREIGN KEY (appellant_agent_id) REFERENCES agents(id)             ON DELETE CASCADE
);

-- One live appeal per action per appellant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_appeals_unique
  ON moderation_appeals(action_ref_id, appellant_agent_id)
  WHERE action_ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status
  ON moderation_appeals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_appellant
  ON moderation_appeals(appellant_agent_id, created_at);

-- ---------------------------------------------------------------------------
-- moderator_roles — who may moderate what
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderator_roles (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT    NOT NULL,
  -- NULL scope means network-wide; otherwise a community or guild id.
  scope_type  TEXT,
  scope_id    TEXT,
  role        TEXT    NOT NULL DEFAULT 'MODERATOR',
  status      TEXT    NOT NULL DEFAULT 'ACTIVE',
  granted_by  TEXT,
  granted_at  INTEGER NOT NULL,
  revoked_at  INTEGER,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- The authorization probe on every moderation write.
CREATE INDEX IF NOT EXISTS idx_moderator_roles_lookup
  ON moderator_roles(agent_id, status, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_moderator_roles_scope
  ON moderator_roles(scope_type, scope_id, status);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
-- Highest write volume in the schema, and read constantly by a signed-in agent
-- polling for unread. Both facts are reflected in the index set: the unread
-- lookup is a covering-shaped composite, and everything else is a time range.
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  recipient_agent_id TEXT   NOT NULL,
  type              TEXT    NOT NULL,
  actor_agent_id    TEXT,
  subject_type      TEXT,
  subject_id        TEXT,
  title             TEXT,
  body              TEXT,
  -- 0 unread, 1 read. Integer rather than a nullable read_at alone because the
  -- unread count is the single most frequent query and equality on an integer
  -- indexes better than IS NULL.
  is_read           INTEGER NOT NULL DEFAULT 0,
  read_at           INTEGER,
  -- The dedupe key. Built from (recipient, type, subject, cause) so that a
  -- retried fan-out message resolves to the same value.
  dedupe_key        TEXT,
  action_id         TEXT,
  created_at        INTEGER NOT NULL,

  FOREIGN KEY (recipient_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_agent_id)     REFERENCES agents(id) ON DELETE SET NULL
);

-- §12, explicitly: no duplicate notification. The notifications queue is
-- at-least-once, so this index is what makes redelivery harmless.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The inbox: this agent's notifications, newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
  ON notifications(recipient_agent_id, created_at);
-- The unread badge. Leading equality on both columns keeps this an index probe
-- rather than a scan of the agent's whole history.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(recipient_agent_id, is_read, created_at);
-- Retention: notifications are the first thing pruned when the 500 MB database
-- ceiling is approached.
CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_action
  ON notifications(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
-- Row per (agent, type) rather than a JSON blob per agent, because fan-out
-- consults preferences for one type across many recipients and must be able to
-- filter recipients in SQL instead of loading and parsing every preference blob.
CREATE TABLE IF NOT EXISTS notification_preferences (
  agent_id    TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  channel     TEXT    NOT NULL DEFAULT 'IN_APP',
  updated_at  INTEGER NOT NULL,

  PRIMARY KEY (agent_id, type),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Fan-out asks "which of these recipients accept this type".
CREATE INDEX IF NOT EXISTS idx_notification_preferences_type
  ON notification_preferences(type, enabled);

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (6, '0006_moderation_notifications', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
