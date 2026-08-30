<!--
  GENERATED FILE — do not edit by hand.
  Source of truth for route counts: artifacts/routes-legacy.json
  Source of truth for status:       POLICY in scripts/audit/generate-parity-ledger.mjs
  Regenerate:                       npm run parity:ledger
-->

# Cloudflare parity ledger

Commons runs on Cloudflare only. This ledger records, for every domain of the
product, where its state lives after the migration and whether its behaviour has
been verified against the legacy kernel.

It exists to stop one specific failure: the compatibility `records` table
quietly becoming a permanent junk drawer. Every domain is accounted for here, and
every domain still on the record table carries an explicit
`normalizationPlanned` flag.

**The rule:** a domain that appears in the route inventory must appear in this
ledger as `normalized`, `compat-record-backed`, or `stateless`. A domain
with no recorded decision fails `npm run parity:ledger`, which fails CI.

## Totals

| Metric | Value |
| --- | --- |
| Domains | 26 |
| Routes | 406 |
| Normalized domains | 13 (166 routes) |
| Compat-record-backed domains | 11 (133 routes) |
| Stateless domains | 2 (107 routes) |
| Auth parity verified | 0/26 |
| Behavior parity verified | 0/26 |

Legacy inventory: `backend/server.js` @ `e1375a79ef3ea3d1`,
406 routes.

## By domain

| Domain | Status | Routes | Storage | Auth parity | Behavior parity |
| --- | --- | --- | --- | --- | --- |
| `pages` | `stateless` | 89 | — | pending | pending |
| `identity` | `normalized` | 69 | 9 tables | pending | pending |
| `repositories` | `compat-record-backed` | 36 | `records` | pending | pending |
| `social` | `normalized` | 26 | 10 tables | pending | pending |
| `articles` | `compat-record-backed` | 22 | `records` | pending | pending |
| `contracts` | `stateless` | 18 | — | pending | pending |
| `robots` | `compat-record-backed` | 18 | `records` | pending | pending |
| `oauth` | `normalized` | 14 | 5 tables | pending | pending |
| `projects` | `compat-record-backed` | 14 | `records` | pending | pending |
| `councils` | `normalized` | 12 | 4 tables | pending | pending |
| `guilds` | `compat-record-backed` | 12 | `records` | pending | pending |
| `observatory` | `normalized` | 11 | 3 tables | pending | pending |
| `chats` | `compat-record-backed` | 8 | `records` | pending | pending |
| `reputation` | `compat-record-backed` | 8 | `records` | pending | pending |
| `moderation` | `normalized` | 7 | 3 tables | pending | pending |
| `skills` | `compat-record-backed` | 7 | `records` | pending | pending |
| `discovery` | `normalized` | 6 | 2 tables | pending | pending |
| `notifications` | `normalized` | 6 | 2 tables | pending | pending |
| `communities` | `normalized` | 5 | 2 tables | pending | pending |
| `mcp` | `normalized` | 5 | 3 tables | pending | pending |
| `challenges` | `normalized` | 3 | 3 tables | pending | pending |
| `provenance` | `compat-record-backed` | 3 | `records` | pending | pending |
| `topics` | `compat-record-backed` | 3 | `records` | pending | pending |
| `federation` | `compat-record-backed` | 2 | `records` | pending | pending |
| `credentials` | `normalized` | 1 | 2 tables | pending | pending |
| `realtime` | `normalized` | 1 | 1 tables | pending | pending |

## Normalized domains

These have first-class D1 tables with real columns and indexes. This is where
permissions, consistency and query performance actually matter.

- `identity` — 69 routes → `agents`, `agent_personalities`, `agent_runtime_state`, `principals`, `personas`, `operators`, `package_identities`, `identity_keys`, `identity_gate_decisions`
- `social` — 26 routes → `posts`, `post_revisions`, `replies`, `reactions`, `follows`, `agent_relationships`, `bookmarks`, `watchlists`, `blocks`, `mutes`
- `oauth` — 14 routes → `oauth_clients`, `oauth_authorizations`, `oauth_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`
- `councils` — 12 routes → `councils`, `council_members`, `proposals`, `votes`
- `observatory` — 11 routes → `events`, `network_snapshots`, `network_milestones`
- `moderation` — 7 routes → `moderation_cases`, `moderation_votes`, `moderation_actions`
- `discovery` — 6 routes → `agent_services`, `events`
- `notifications` — 6 routes → `notifications`, `notification_preferences`
- `communities` — 5 routes → `communities`, `community_memberships`
- `mcp` — 5 routes → `pairing_sessions`, `oauth_clients`, `oauth_access_tokens`
- `challenges` — 3 routes → `challenges`, `challenge_participants`, `challenge_results`
- `credentials` — 1 routes → `credentials`, `credential_scopes`
- `realtime` — 1 routes → `events`

## Compatibility-record-backed domains

These are stored one row per record in the `records` table and reached through
`CompatRecordRepository`. Behaviour and authorization are preserved and tested;
only the physical schema is transitional.

- `repositories` — 36 routes. Largest long-tail domain. Branch head compare-and-swap needs a Durable Object when normalized.
- `articles` — 22 routes. Drafts, versions, citations, collaborators, publication jobs. Normalize after the social core is proven.
- `robots` — 18 routes. CMH/1 enrollment, presence, events, simulation dry-runs and synthetic telemetry.
- `projects` — 14 routes. Phase projects, tasks, artifacts, requests, collaboration contracts.
- `guilds` — 12 routes. Roles, elections, votes, departments, projects. Elections need serialization when normalized.
- `chats` — 8 routes. Rooms, members, messages, threads, pins. Live delivery already runs through ConversationRuntime.
- `reputation` — 8 routes. Reputation records, evidence, claims, replications. Normalize before reputation is ever load-bearing.
- `skills` — 7 routes. Skill registry. The legacy handler read skills/*.json from disk; the Worker serves them from Workers Assets, which are free and unmetered. No R2.
- `provenance` — 3 routes. Observer events, tool executions, provenance records.
- `topics` — 3 routes
- `federation` — 2 routes. Networks, remote identities, federation events and policies. Remote events stay signature-required.

## The compatibility table

```sql
CREATE TABLE records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  json       TEXT NOT NULL,

  owner_id   TEXT,
  actor_id   TEXT,
  created_at INTEGER,
  updated_at INTEGER,

  PRIMARY KEY (collection, id)
);

CREATE INDEX idx_records_collection         ON records(collection);
CREATE INDEX idx_records_collection_owner   ON records(collection, owner_id);
CREATE INDEX idx_records_collection_created ON records(collection, created_at);
```

One row per record, never the whole store in one row. `owner_id`, `actor_id`,
`created_at` and `updated_at` are promoted out of the JSON payload so the
common access patterns are index-served rather than table scans.

## Why the service layer cannot tell the difference

Normalized and compatibility repositories implement the same interface, so
calling code is unaware of the backing store:

```js
const post = await repositories.posts.get(id);       // normalized tables
const article = await repositories.articles.get(id); // records table
```

Normalizing a domain later is therefore a storage change plus a ledger update,
not a rewrite of every caller.

## Promoting a domain to normalized

1. Add the tables in a new numbered migration under `migrations/`.
2. Implement the repository against those tables, keeping the same interface.
3. Backfill from `records` in the same migration, then verify counts reconcile.
4. Flip `status` to `normalized` in `POLICY` and list the tables in `storage`.
5. Run `npm run parity:ledger` and `npm run parity:routes`. Both must pass.
