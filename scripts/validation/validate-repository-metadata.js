#!/usr/bin/env node
/**
 * COMMONS — repository metadata validation.
 *
 * Was an inline `node -e` one-liner in .github/workflows/ci.yml. It grew to
 * ~1,500 characters on a single line, which meant it could not be run locally
 * without copying it out of YAML, could not be diffed meaningfully, and — as of
 * the Cloudflare migration — silently kept asserting the existence of vercel.json
 * and backend/railway.json after both had been deleted. That is the failure mode
 * an unreviewable inline script invites.
 *
 * Checks, in order:
 *   1. every JSON contract file parses
 *   2. root, backend and frontend package metadata agree with release.json on
 *      version, node engine and licence
 *   3. required community and repository files exist
 *   4. no retired hosting-provider descriptor has reappeared
 *   5. the Cloudflare deployment descriptor is present and coherent
 *   6. the migration set is contiguous and the parity ledger is in step
 *
 * Read-only. No network, no credentials, no cost.
 *
 * Usage:
 *   node scripts/validation/validate-repository-metadata.js
 *   node scripts/validation/validate-repository-metadata.js --json
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const jsonOutput = process.argv.includes('--json');

const problems = [];
const fail = (message) => problems.push(message);
const resolve = (relativePath) => path.join(ROOT, relativePath);
const exists = (relativePath) => fs.existsSync(resolve(relativePath));

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(resolve(relativePath), 'utf8'));
  } catch (error) {
    fail(`${relativePath} is missing or not valid JSON: ${error.message}`);
    return null;
  }
}

/* ------------------------------------------------- 1. JSON contracts parse */

// backend/.well-known/agent-network has no .json extension but is a JSON
// document, and is served verbatim, so a syntax error there breaks discovery.
const JSON_CONTRACTS = [
  'package.json',
  'backend/package.json',
  'frontend/package.json',
  'backend/config/release.json',
  'backend/openapi.json',
  'backend/routes.json',
  'backend/.well-known/commons.json',
  'backend/.well-known/agent-network',
  'backend/.well-known/commons-robots.json',
  'media/evidence.json',
  'packages/api/package.json',
  'packages/sdk/package.json',
  'packages/cli/package.json',
];

for (const contract of JSON_CONTRACTS) readJson(contract);

/* ------------------------------------- 2. package metadata matches release */

const release = readJson('backend/config/release.json');
const root = readJson('package.json');
const backend = readJson('backend/package.json');
const frontend = readJson('frontend/package.json');

if (release && root && backend && frontend) {
  for (const [label, manifest] of [
    ['package.json', root],
    ['backend/package.json', backend],
    ['frontend/package.json', frontend],
  ]) {
    if (manifest.version !== release.version) {
      fail(`${label} version ${manifest.version} does not match release ${release.version}`);
    }
    if (manifest.engines?.node !== release.node) {
      fail(`${label} engines.node ${manifest.engines?.node} does not match release ${release.node}`);
    }
    if (manifest.license !== 'MIT') fail(`${label} must declare the MIT license`);
  }

  // The publishable packages ship in lockstep with the API they describe.
  for (const label of ['packages/api/package.json', 'packages/sdk/package.json', 'packages/cli/package.json']) {
    const manifest = readJson(label);
    if (!manifest) continue;
    if (manifest.version !== release.version) {
      fail(`${label} version ${manifest.version} does not match release ${release.version}`);
    }
    // GitHub Packages resolves a package to a repository through the scope, and
    // the scope must equal the owning account.
    if (!String(manifest.name).startsWith('@theworker02/')) {
      fail(`${label} name ${manifest.name} is not under @theworker02 and cannot publish to GitHub Packages`);
    }
  }
}

/* ------------------------------------------------ 3. required files exist */

const REQUIRED_FILES = [
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SUPPORT.md',
  'SECURITY.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  'skill.md',
  '.dev.vars.example',
];

for (const file of REQUIRED_FILES) if (!exists(file)) fail(`missing repository file: ${file}`);

/* --------------------------------- 4. no retired provider descriptor is back */

// Production is Cloudflare-only. Each of these files, if present, means some part
// of the deployment story has drifted back onto an external host.
const RETIRED_DESCRIPTORS = [
  ['vercel.json', 'Vercel'],
  ['frontend/vercel.json', 'Vercel'],
  ['backend/railway.json', 'Railway'],
  ['render.yaml', 'Render'],
  ['fly.toml', 'Fly.io'],
  ['Procfile', 'a buildpack host'],
  ['app.yaml', 'App Engine'],
  ['.github/workflows/vercel.yml', 'Vercel'],
];

for (const [file, provider] of RETIRED_DESCRIPTORS) {
  if (exists(file)) fail(`${file} reintroduces ${provider}; production runs on Cloudflare Workers only`);
}

/* ------------------------------------ 5. Cloudflare descriptor is coherent */

let wrangler = null;
if (!exists('wrangler.jsonc')) {
  fail('wrangler.jsonc is missing; it is the only production deployment descriptor');
} else {
  // free-tier-guard.js owns the JSONC parser and the free-plan rules. Reusing it
  // keeps one implementation of both rather than a second, subtly different one.
  try {
    const { parseJsonc } = require('../deployment/free-tier-guard.js');
    wrangler = parseJsonc(fs.readFileSync(resolve('wrangler.jsonc'), 'utf8'));
  } catch (error) {
    fail(`wrangler.jsonc could not be parsed: ${error.message}`);
  }
}

if (wrangler) {
  if (!wrangler.main) fail('wrangler.jsonc declares no main entry point');
  else if (!exists(wrangler.main)) fail(`wrangler.jsonc main entry point does not exist: ${wrangler.main}`);
  if (!wrangler.compatibility_date) fail('wrangler.jsonc declares no compatibility_date');
  if (!wrangler.d1_databases?.length) fail('wrangler.jsonc declares no D1 database; D1 is the source of truth');
  // R2 bills on overage instead of failing closed, which is why it is excluded.
  // cf:guard enforces this too; asserting it here as well means the invariant
  // survives someone running only one of the two checks.
  if (wrangler.r2_buckets?.length) {
    fail('wrangler.jsonc binds R2, which bills on overage rather than failing closed');
  }
}

/* --------------------------- 6. migrations contiguous, ledger in step */

const MIGRATIONS_DIR = resolve('migrations');
let migrations = [];
if (!fs.existsSync(MIGRATIONS_DIR)) {
  fail('migrations/ is missing; the D1 schema is applied by explicit migration only');
} else {
  migrations = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  if (!migrations.length) fail('migrations/ contains no .sql files');
  migrations.forEach((name, index) => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match) {
      fail(`migration ${name} is not named NNNN_snake_case.sql`);
      return;
    }
    if (Number(match[1]) !== index + 1) {
      fail(`migration ${name} breaks the contiguous sequence; expected ${String(index + 1).padStart(4, '0')}`);
    }
  });
}

const parity = exists('config/cloudflare-parity.json') ? readJson('config/cloudflare-parity.json') : null;
if (!parity) {
  fail('config/cloudflare-parity.json is missing; every domain needs a recorded storage decision');
} else {
  const undecided = (parity.domains || []).filter((domain) => !domain.status);
  if (undecided.length) fail(`${undecided.length} parity ledger domains have no status`);
  // A compat-backed domain without a normalization plan is the junk-drawer
  // failure mode the ledger exists to prevent.
  const unplanned = (parity.domains || []).filter(
    (domain) => domain.status === 'compat-record-backed' && domain.normalizationPlanned !== true
  );
  for (const domain of unplanned) {
    fail(`parity ledger domain "${domain.domain}" is compat-record-backed without normalizationPlanned`);
  }
}

/* ---------------------------------------------------------------- report */

const summary = {
  command: 'validate:metadata',
  release_version: release?.version ?? null,
  json_contracts: JSON_CONTRACTS.length,
  required_files: REQUIRED_FILES.length,
  retired_descriptors_checked: RETIRED_DESCRIPTORS.length,
  migrations: migrations.length,
  parity_domains: parity?.domains?.length ?? 0,
  ok: problems.length === 0,
};

if (jsonOutput) {
  console.log(JSON.stringify({ ...summary, problems }, null, 2));
} else if (problems.length) {
  console.error('Repository metadata validation failed');
  for (const problem of problems) console.error(`  ! ${problem}`);
} else {
  console.log(
    `JSON contracts and repository metadata valid ${release?.version ?? ''}`.trim() +
      ` (${migrations.length} migrations, ${summary.parity_domains} parity domains)`
  );
}

process.exit(problems.length ? 1 : 0);
