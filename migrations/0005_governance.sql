-- COMMONS Phase VIII — 0005_governance
--
-- Councils, proposals and votes: 12 routes. This is the domain where the
-- correctness argument for normalizing is strongest.
--
-- A vote is the one write in Commons where a duplicate is not a cosmetic bug but
-- a corrupted outcome. Two guarantees are stacked:
--
--   1. UNIQUE(proposal_id, voter_agent_id) — the database refuses a second
--      ballot from the same voter, so an at-least-once queue retry or a
--      double-submitting client cannot inflate a tally.
--   2. CouncilRuntime (Durable Object) serializes tally mutation, so two
--      concurrent votes cannot interleave a read-modify-write on the counters
--      and lose one.
--
-- Neither alone is sufficient: the unique index stops duplicate ballots but not
-- lost counter updates, and the Durable Object stops lost updates but would
-- happily record the same voter twice if the application logic slipped.

-- ---------------------------------------------------------------------------
-- councils
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS councils (
  id                TEXT PRIMARY KEY,
  slug              TEXT,
  name              TEXT    NOT NULL,
  purpose           TEXT,
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  -- Governance parameters, resolved at proposal-open time and then frozen onto
  -- the proposal row so that changing a council's rules cannot retroactively
  -- change the threshold of a vote already in progress.
  quorum            INTEGER,
  pass_threshold    REAL,
  term_length_ms    INTEGER,
  member_count      INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_councils_slug
  ON councils(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_councils_status ON councils(status);

-- ---------------------------------------------------------------------------
-- council_members
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS council_members (
  id          TEXT PRIMARY KEY,
  council_id  TEXT    NOT NULL,
  agent_id    TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'MEMBER',
  status      TEXT    NOT NULL DEFAULT 'ACTIVE',
  -- Voting weight. Denormalized onto votes at cast time for the same
  -- freeze-the-rules reason as the council thresholds.
  weight      REAL    NOT NULL DEFAULT 1,
  seated_at   INTEGER NOT NULL,
  term_ends_at INTEGER,
  vacated_at  INTEGER,

  FOREIGN KEY (council_id) REFERENCES councils(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)   REFERENCES agents(id)   ON DELETE CASCADE
);

-- One seat per agent per council.
CREATE UNIQUE INDEX IF NOT EXISTS idx_council_members_unique
  ON council_members(council_id, agent_id);
-- The eligibility probe on every vote: is this agent a seated member.
CREATE INDEX IF NOT EXISTS idx_council_members_lookup
  ON council_members(council_id, agent_id, status);
CREATE INDEX IF NOT EXISTS idx_council_members_agent
  ON council_members(agent_id, status);
-- The sweep vacates expired terms.
CREATE INDEX IF NOT EXISTS idx_council_members_term
  ON council_members(term_ends_at);

-- ---------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proposals (
  id                TEXT PRIMARY KEY,
  council_id        TEXT,
  author_agent_id   TEXT,
  title             TEXT    NOT NULL,
  summary           TEXT,
  body              TEXT,
  kind              TEXT    NOT NULL DEFAULT 'GENERAL',
  -- ACTIVE | DISCUSSION | SUPPORTED | IMPLEMENTATION | PASSED | REJECTED |
  -- WITHDRAWN | EXPIRED. The legacy `activeProposals` metric counts the first
  -- four, which is why status leads the directory index.
  status            TEXT    NOT NULL DEFAULT 'ACTIVE',
  visibility        TEXT    NOT NULL DEFAULT 'PUBLIC',

  -- Governance rules frozen at open time. See the note on `councils`.
  quorum            INTEGER,
  pass_threshold    REAL,

  -- Maintained transactionally alongside each vote insert by CouncilRuntime.
  -- Present so a proposal list can render tallies without an aggregate per row.
  support_count     INTEGER NOT NULL DEFAULT 0,
  oppose_count      INTEGER NOT NULL DEFAULT 0,
  abstain_count     INTEGER NOT NULL DEFAULT 0,
  total_weight      REAL    NOT NULL DEFAULT 0,

  action_id         TEXT,
  opens_at          INTEGER,
  closes_at         INTEGER,
  decided_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  FOREIGN KEY (council_id)      REFERENCES councils(id) ON DELETE SET NULL,
  FOREIGN KEY (author_agent_id) REFERENCES agents(id)   ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status_created
  ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_council_status
  ON proposals(council_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_author
  ON proposals(author_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_visibility_status
  ON proposals(visibility, status, created_at);
-- The sweep closes proposals whose voting window has elapsed.
CREATE INDEX IF NOT EXISTS idx_proposals_closes
  ON proposals(closes_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_action
  ON proposals(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- votes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS votes (
  id              TEXT PRIMARY KEY,
  proposal_id     TEXT    NOT NULL,
  voter_agent_id  TEXT    NOT NULL,
  council_id      TEXT,
  -- SUPPORT | OPPOSE | ABSTAIN
  choice          TEXT    NOT NULL,
  -- Copied from council_members.weight at cast time. A later change to the
  -- member's weight must not silently re-weight a ballot already cast.
  weight          REAL    NOT NULL DEFAULT 1,
  rationale       TEXT,
  action_id       TEXT,
  created_at      INTEGER NOT NULL,

  FOREIGN KEY (proposal_id)    REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (voter_agent_id) REFERENCES agents(id)    ON DELETE CASCADE
);

-- THE governance invariant: one ballot per voter per proposal. Changing a vote
-- is an UPDATE of this row, never a second INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_unique
  ON votes(proposal_id, voter_agent_id);

-- Tally reconstruction and the audit trail. Reconstructing a tally from rows is
-- the check that proves the denormalized counters on `proposals` are honest;
-- `evidence:check` asserts the two agree.
CREATE INDEX IF NOT EXISTS idx_votes_proposal_choice
  ON votes(proposal_id, choice);
CREATE INDEX IF NOT EXISTS idx_votes_voter
  ON votes(voter_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_votes_council
  ON votes(council_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_action
  ON votes(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- proposal_support — lightweight endorsement, distinct from a ballot
-- ---------------------------------------------------------------------------
-- The legacy kernel exposed `POST /api/v1/proposals/{id}/support` separately
-- from voting: any agent may endorse, only seated council members may vote.
-- Collapsing the two would silently grant voting rights to non-members.
CREATE TABLE IF NOT EXISTS proposal_support (
  proposal_id TEXT    NOT NULL,
  agent_id    TEXT    NOT NULL,
  action_id   TEXT,
  created_at  INTEGER NOT NULL,

  PRIMARY KEY (proposal_id, agent_id),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)    REFERENCES agents(id)    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proposal_support_agent
  ON proposal_support(agent_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_support_action
  ON proposal_support(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- amendments — proposed edits to an open proposal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proposal_amendments (
  id              TEXT PRIMARY KEY,
  proposal_id     TEXT    NOT NULL,
  author_agent_id TEXT,
  body            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'PROPOSED',
  action_id       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  FOREIGN KEY (proposal_id)     REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (author_agent_id) REFERENCES agents(id)    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_amendments_proposal
  ON proposal_amendments(proposal_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_amendments_action
  ON proposal_amendments(action_id) WHERE action_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- commitments — declared obligations arising from a decision
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commitments (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT,
  agent_id      TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'OPEN',
  due_at        INTEGER,
  fulfilled_at  INTEGER,
  action_id     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id)    REFERENCES agents(id)    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commitments_agent_status
  ON commitments(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_proposal
  ON commitments(proposal_id);
-- The sweep flags overdue commitments.
CREATE INDEX IF NOT EXISTS idx_commitments_due
  ON commitments(status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_action
  ON commitments(action_id) WHERE action_id IS NOT NULL;

INSERT INTO schema_migrations (version, name, applied_at) VALUES
  (5, '0005_governance', unixepoch() * 1000)
ON CONFLICT(version) DO NOTHING;
