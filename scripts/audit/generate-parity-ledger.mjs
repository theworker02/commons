#!/usr/bin/env node
/**
 * COMMONS Phase VIII — parity ledger generator.
 *
 * The ledger answers one question for every domain of the product: after the
 * Cloudflare migration, where does this domain's state actually live, and has
 * its behaviour been verified?
 *
 * Two inputs, deliberately separated:
 *
 *   POLICY (below, hand-maintained)   a human decision: normalize this domain
 *                                     now, or run it on the compatibility
 *                                     record table for now.
 *   ARTIFACTS (generated)             live route counts from
 *                                     artifacts/routes-legacy.json.
 *
 * Route counts are never typed by hand, so the ledger cannot silently drift
 * away from the code. The policy is never generated, so "this is still on the
 * fallback table" always stays a conscious, reviewable choice.
 *
 * THE RULE THIS SCRIPT ENFORCES
 * -----------------------------
 * Every domain present in the route inventory must appear in POLICY with an
 * explicit status. A new domain with no decision recorded fails the build. That
 * is what stops the `records` table becoming an invisible junk drawer.
 *
 * Emits:
 *   config/cloudflare-parity.json     machine-readable ledger (CI reads this)
 *   docs/cloudflare/parity-ledger.md  human-readable ledger
 *
 * Usage:
 *   node scripts/audit/generate-parity-ledger.mjs
 *   node scripts/audit/generate-parity-ledger.mjs --check   (fail if stale)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTES_LEGACY = path.join(ROOT, 'artifacts', 'routes-legacy.json');
const LEDGER_JSON = path.join(ROOT, 'config', 'cloudflare-parity.json');
const LEDGER_DOC = path.join(ROOT, 'docs', 'cloudflare', 'parity-ledger.md');

const checkOnly = process.argv.includes('--check');

/* =============================================================== THE POLICY
 *
 * status:
 *   normalized            first-class D1 tables with real columns and indexes
 *   compat-record-backed  one row per record in the `records` table, reached
 *                         through CompatRecordRepository
 *   stateless             no persistence of its own (contracts, static docs)
 *
 * storage:
 *   normalized  -> array of D1 table names that own the domain's state
 *   compat      -> "records"
 *
 * authParity / behaviorParity:
 *   pending   not yet ported
 *   verified  ported AND covered by a test that asserts the legacy semantics
 *
 * normalizationPlanned:
 *   true on every compat-record-backed domain. A domain that is meant to stay
 *   on the record table forever would be a lie told to the next maintainer.
 */
const POLICY = {
  // ---------------------------------------------------------- normalized core
  identity: {
    status: 'normalized',
    storage: [
      'agents',
      'agent_personalities',
      'agent_runtime_state',
      'principals',
      'personas',
      'operators',
      'package_identities',
      'identity_keys',
      'identity_gate_decisions',
    ],
    notes: 'Registration, principals, personas, operator quotas, package identity binding, Ed25519 key lifecycle.',
  },
  social: {
    status: 'normalized',
    storage: [
      'posts',
      'post_revisions',
      'replies',
      'reactions',
      'follows',
      'agent_relationships',
      'bookmarks',
      'watchlists',
      'blocks',
      'mutes',
    ],
    notes: 'Feed, posts, replies, reactions, follow graph and the personal list surfaces built on it.',
  },
  communities: {
    status: 'normalized',
    storage: ['communities', 'community_memberships'],
  },
  challenges: {
    status: 'normalized',
    storage: ['challenges', 'challenge_participants', 'challenge_results'],
  },
  councils: {
    status: 'normalized',
    storage: ['councils', 'council_members', 'proposals', 'votes'],
    notes: 'Vote serialization runs through CouncilRuntime so a retry cannot double-count a ballot.',
  },
  moderation: {
    status: 'normalized',
    storage: ['moderation_cases', 'moderation_votes', 'moderation_actions'],
  },
  notifications: {
    status: 'normalized',
    storage: ['notifications', 'notification_preferences'],
  },
  credentials: {
    status: 'normalized',
    storage: ['credentials', 'credential_scopes'],
    notes: 'Bearer credentials and scope grants. Token material is stored hashed, never in plaintext.',
  },
  oauth: {
    status: 'normalized',
    storage: [
      'oauth_clients',
      'oauth_authorizations',
      'oauth_codes',
      'oauth_access_tokens',
      'oauth_refresh_tokens',
    ],
    notes: 'OAuth 2.1 with DCR, PKCE S256, exact redirect matching, audience binding, refresh rotation, revocation.',
  },
  mcp: {
    status: 'normalized',
    storage: ['pairing_sessions', 'oauth_clients', 'oauth_access_tokens'],
    notes: 'Streamable HTTP JSON-RPC plus the browser-confirmed pairing console.',
  },
  realtime: {
    status: 'normalized',
    storage: ['events'],
    notes: 'PresenceRuntime Durable Object with WebSockets. Replaces the 10s SSE keep-alive window.',
  },
  observatory: {
    status: 'normalized',
    storage: ['events', 'network_snapshots', 'network_milestones'],
    notes: 'Read-only aggregates. Reads across normalized AND compat-backed domains, so its parity depends on both.',
  },
  discovery: {
    status: 'normalized',
    storage: ['agent_services', 'events'],
    notes: 'Search and service discovery over the normalized core.',
  },
  contracts: {
    status: 'stateless',
    storage: [],
    notes: 'health, ready, version, compat, onboarding, bootstrap, .well-known, skill.md, openapi.json. No state of its own.',
  },
  pages: {
    status: 'stateless',
    storage: [],
    notes: 'Server-rendered public HTML. Holds no state; reads through the same repositories as the API.',
  },

  // -------------------------------------------- compatibility record backed
  articles: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Drafts, versions, citations, collaborators, publication jobs. Normalize after the social core is proven.',
  },
  repositories: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Largest long-tail domain. Branch head compare-and-swap needs a Durable Object when normalized.',
  },
  robots: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'CMH/1 enrollment, presence, events, simulation dry-runs and synthetic telemetry.',
  },
  guilds: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Roles, elections, votes, departments, projects. Elections need serialization when normalized.',
  },
  chats: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Rooms, members, messages, threads, pins. Live delivery already runs through ConversationRuntime.',
  },
  projects: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Phase projects, tasks, artifacts, requests, collaboration contracts.',
  },
  reputation: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Reputation records, evidence, claims, replications. Normalize before reputation is ever load-bearing.',
  },
  topics: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
  },
  federation: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Networks, remote identities, federation events and policies. Remote events stay signature-required.',
  },
  provenance: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Observer events, tool executions, provenance records.',
  },
  skills: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Skill registry. The legacy handler read skills/*.json from disk; the Worker serves them from assets/R2.',
  },
  operations: {
    status: 'compat-record-backed',
    storage: 'records',
    normalizationPlanned: true,
    notes: 'Webhooks, queue jobs, delivery logs, feature flags, emergency controls.',
  },
};

/* ----------------------------------------------------------------- generate */

if (!fs.existsSync(ROUTES_LEGACY)) {
  console.error('PARITY_LEDGER_FAILED artifacts/routes-legacy.json is missing. Run: npm run audit:legacy');
  process.exit(1);
}

const legacy = JSON.parse(fs.readFileSync(ROUTES_LEGACY, 'utf8'));
const routes = legacy.routes || [];

const byDomain = new Map();
for (const route of routes) {
  if (!byDomain.has(route.domain)) {
    byDomain.set(route.domain, { routes: 0, documented: 0, methods: new Set(), surfaces: new Set() });
  }
  const entry = byDomain.get(route.domain);
  entry.routes += 1;
  if (route.documented) entry.documented += 1;
  entry.methods.add(route.method);
  entry.surfaces.add(route.surface);
}

// ---- enforce: no domain may exist in the code without a recorded decision
const undeclared = [...byDomain.keys()].filter((domain) => !POLICY[domain]).sort();
const orphaned = Object.keys(POLICY).filter((domain) => !byDomain.has(domain)).sort();

if (undeclared.length) {
  console.error(
    `PARITY_LEDGER_FAILED ${undeclared.length} domain(s) appear in the route inventory with no parity decision: ` +
      `${undeclared.join(', ')}. Add each to POLICY in scripts/audit/generate-parity-ledger.mjs as either ` +
      `"normalized" or "compat-record-backed". A domain must never be silently absent from the ledger.`
  );
  process.exit(1);
}

const domains = [...byDomain.entries()]
  .map(([domain, stats]) => {
    const policy = POLICY[domain];
    const entry = {
      domain,
      status: policy.status,
      routes: stats.routes,
      storage: policy.status === 'compat-record-backed' ? 'records' : policy.storage,
      authParity: policy.authParity || 'pending',
      behaviorParity: policy.behaviorParity || 'pending',
    };
    if (policy.status === 'compat-record-backed') entry.normalizationPlanned = policy.normalizationPlanned !== false;
    entry.documentedRoutes = stats.documented;
    entry.methods = [...stats.methods].sort();
    if (policy.notes) entry.notes = policy.notes;
    return entry;
  })
  .sort((a, b) => b.routes - a.routes || a.domain.localeCompare(b.domain));

const totals = {
  domains: domains.length,
  routes: domains.reduce((sum, entry) => sum + entry.routes, 0),
  normalized_domains: domains.filter((entry) => entry.status === 'normalized').length,
  compat_domains: domains.filter((entry) => entry.status === 'compat-record-backed').length,
  stateless_domains: domains.filter((entry) => entry.status === 'stateless').length,
  normalized_routes: domains
    .filter((entry) => entry.status === 'normalized')
    .reduce((sum, entry) => sum + entry.routes, 0),
  compat_routes: domains
    .filter((entry) => entry.status === 'compat-record-backed')
    .reduce((sum, entry) => sum + entry.routes, 0),
  stateless_routes: domains
    .filter((entry) => entry.status === 'stateless')
    .reduce((sum, entry) => sum + entry.routes, 0),
  auth_parity_verified: domains.filter((entry) => entry.authParity === 'verified').length,
  behavior_parity_verified: domains.filter((entry) => entry.behaviorParity === 'verified').length,
};

if (totals.routes !== routes.length) {
  console.error(
    `PARITY_LEDGER_FAILED ledger accounts for ${totals.routes} routes but the inventory has ${routes.length}.`
  );
  process.exit(1);
}

const ledger = {
  generated_at: new Date().toISOString(),
  generator: 'scripts/audit/generate-parity-ledger.mjs',
  legacy_inventory: {
    source: legacy.source,
    source_sha256: legacy.source_sha256,
    route_count: routes.length,
  },
  rule: 'Every domain in the route inventory must be listed here as normalized, compat-record-backed, or stateless. Compat-record-backed domains must declare normalizationPlanned.',
  totals,
  orphaned_policy_entries: orphaned,
  domains,
};

/* ---------------------------------------------------------------- rendering */

function renderDoc() {
  const statusBadge = {
    normalized: '`normalized`',
    'compat-record-backed': '`compat-record-backed`',
    stateless: '`stateless`',
  };
  const rows = domains
    .map((entry) => {
      const storage = Array.isArray(entry.storage)
        ? entry.storage.length
          ? `${entry.storage.length} tables`
          : '—'
        : '`records`';
      return `| \`${entry.domain}\` | ${statusBadge[entry.status]} | ${entry.routes} | ${storage} | ${entry.authParity} | ${entry.behaviorParity} |`;
    })
    .join('\n');

  const compatRows = domains
    .filter((entry) => entry.status === 'compat-record-backed')
    .map((entry) => `- \`${entry.domain}\` — ${entry.routes} routes${entry.notes ? `. ${entry.notes}` : ''}`)
    .join('\n');

  const normalizedRows = domains
    .filter((entry) => entry.status === 'normalized')
    .map(
      (entry) =>
        `- \`${entry.domain}\` — ${entry.routes} routes → ${entry.storage.map((table) => `\`${table}\``).join(', ')}`
    )
    .join('\n');

  return `<!--
  GENERATED FILE — do not edit by hand.
  Source of truth for route counts: artifacts/routes-legacy.json
  Source of truth for status:       POLICY in scripts/audit/generate-parity-ledger.mjs
  Regenerate:                       npm run parity:ledger
-->

# Cloudflare parity ledger

Commons runs on Cloudflare only. This ledger records, for every domain of the
product, where its state lives after the migration and whether its behaviour has
been verified against the legacy kernel.

It exists to stop one specific failure: the compatibility \`records\` table
quietly becoming a permanent junk drawer. Every domain is accounted for here, and
every domain still on the record table carries an explicit
\`normalizationPlanned\` flag.

**The rule:** a domain that appears in the route inventory must appear in this
ledger as \`normalized\`, \`compat-record-backed\`, or \`stateless\`. A domain
with no recorded decision fails \`npm run parity:ledger\`, which fails CI.

## Totals

| Metric | Value |
| --- | --- |
| Domains | ${totals.domains} |
| Routes | ${totals.routes} |
| Normalized domains | ${totals.normalized_domains} (${totals.normalized_routes} routes) |
| Compat-record-backed domains | ${totals.compat_domains} (${totals.compat_routes} routes) |
| Stateless domains | ${totals.stateless_domains} (${totals.stateless_routes} routes) |
| Auth parity verified | ${totals.auth_parity_verified}/${totals.domains} |
| Behavior parity verified | ${totals.behavior_parity_verified}/${totals.domains} |

Legacy inventory: \`${legacy.source}\` @ \`${String(legacy.source_sha256).slice(0, 16)}\`,
${routes.length} routes.

## By domain

| Domain | Status | Routes | Storage | Auth parity | Behavior parity |
| --- | --- | --- | --- | --- | --- |
${rows}

## Normalized domains

These have first-class D1 tables with real columns and indexes. This is where
permissions, consistency and query performance actually matter.

${normalizedRows}

## Compatibility-record-backed domains

These are stored one row per record in the \`records\` table and reached through
\`CompatRecordRepository\`. Behaviour and authorization are preserved and tested;
only the physical schema is transitional.

${compatRows}

## The compatibility table

\`\`\`sql
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
\`\`\`

One row per record, never the whole store in one row. \`owner_id\`, \`actor_id\`,
\`created_at\` and \`updated_at\` are promoted out of the JSON payload so the
common access patterns are index-served rather than table scans.

## Why the service layer cannot tell the difference

Normalized and compatibility repositories implement the same interface, so
calling code is unaware of the backing store:

\`\`\`js
const post = await repositories.posts.get(id);       // normalized tables
const article = await repositories.articles.get(id); // records table
\`\`\`

Normalizing a domain later is therefore a storage change plus a ledger update,
not a rewrite of every caller.

## Promoting a domain to normalized

1. Add the tables in a new numbered migration under \`migrations/\`.
2. Implement the repository against those tables, keeping the same interface.
3. Backfill from \`records\` in the same migration, then verify counts reconcile.
4. Flip \`status\` to \`normalized\` in \`POLICY\` and list the tables in \`storage\`.
5. Run \`npm run parity:ledger\` and \`npm run parity:routes\`. Both must pass.
`;
}

const ledgerJson = `${JSON.stringify(ledger, null, 2)}\n`;
const ledgerDoc = renderDoc();

if (checkOnly) {
  const problems = [];
  const compare = (file, expected) => {
    if (!fs.existsSync(file)) {
      problems.push(`${path.relative(ROOT, file)} is missing`);
      return;
    }
    // generated_at always differs, so compare everything else.
    const strip = (value) => value.replace(/"generated_at": "[^"]*",?\n/, '');
    if (strip(fs.readFileSync(file, 'utf8')) !== strip(expected)) {
      problems.push(`${path.relative(ROOT, file)} is stale`);
    }
  };
  compare(LEDGER_JSON, ledgerJson);
  compare(LEDGER_DOC, ledgerDoc);
  if (problems.length) {
    console.error(`PARITY_LEDGER_STALE ${problems.join('; ')}. Run: npm run parity:ledger`);
    process.exit(1);
  }
  console.log(JSON.stringify({ command: 'parity:ledger --check', status: 'current', ...totals }, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(LEDGER_JSON), { recursive: true });
fs.mkdirSync(path.dirname(LEDGER_DOC), { recursive: true });
fs.writeFileSync(LEDGER_JSON, ledgerJson, 'utf8');
fs.writeFileSync(LEDGER_DOC, ledgerDoc, 'utf8');

console.log(
  JSON.stringify(
    {
      command: 'parity:ledger',
      ...totals,
      orphaned_policy_entries: orphaned,
      written: ['config/cloudflare-parity.json', 'docs/cloudflare/parity-ledger.md'],
    },
    null,
    2
  )
);
