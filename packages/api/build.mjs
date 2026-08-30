#!/usr/bin/env node
/**
 * Builds the publishable contract for @theworker02/commons-api.
 *
 * Everything in generated/ is DERIVED. Nothing in this package is hand-written
 * data, because a hand-copied OpenAPI document or scope list drifts from the
 * implementation the moment someone forgets to update it, and a contract that
 * lies is worse than no contract.
 *
 * Sources of truth, in order of authority:
 *
 *   backend/openapi.json           the published HTTP contract
 *   backend/config/release.json    version, api revision, store schema version
 *   backend/server.js              the scope vocabulary and error codes, read
 *                                  statically (never imported — it opens a
 *                                  listening socket at require time)
 *   artifacts/routes-legacy.json   the canonical 406-route inventory produced by
 *                                  `npm run audit:legacy`
 *   config/cloudflare-parity.json  which domains are normalized vs still on the
 *                                  compatibility record table
 *
 * A published package therefore states, verifiably, both what the API offers and
 * how each part of it is currently stored.
 *
 * Usage:
 *   node build.mjs            write generated/
 *   node build.mjs --check    fail if generated/ is stale (CI gate)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const OUT_DIR = path.join(PACKAGE_DIR, 'generated');

const checkOnly = process.argv.includes('--check');

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ sources */

const openapi = readJson('backend/openapi.json');
const release = readJson('backend/config/release.json');
const serverSource = read('backend/server.js');

// Optional inputs. The package must still build in a fresh clone before anyone
// has run the audit, so a missing artifact degrades to null rather than failing.
const routesLegacy = exists('artifacts/routes-legacy.json') ? readJson('artifacts/routes-legacy.json') : null;
const parity = exists('config/cloudflare-parity.json') ? readJson('config/cloudflare-parity.json') : null;

if (manifest.version !== release.version) {
  console.error(
    `COMMONS_API_BUILD_FAILED package version ${manifest.version} does not match ` +
      `backend/config/release.json ${release.version}. The contract package must ship in lockstep with the API.`
  );
  process.exit(1);
}
if (openapi?.info?.version && openapi.info.version !== release.version) {
  console.error(
    `COMMONS_API_BUILD_FAILED backend/openapi.json declares version ${openapi.info.version} ` +
      `but release.json says ${release.version}.`
  );
  process.exit(1);
}

/* ------------------------------------------------------- scope extraction */

/**
 * Pull a named string-array or Set-of-strings constant out of server.js.
 *
 * Static extraction rather than import: requiring server.js validates the
 * environment, opens a data directory and starts a listener. The scope
 * vocabulary is a flat list of quoted literals, so reading it from source is
 * both sufficient and side-effect free.
 */
function extractStringList(name) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*(?:new Set\\(\\s*)?\\[([\\s\\S]*?)\\]`, 'm');
  const match = pattern.exec(serverSource);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

const scopeGroups = {
  all: extractStringList('ALLOWED_CREDENTIAL_SCOPES'),
  bootstrapIssuable: extractStringList('BOOTSTRAP_ISSUABLE_SCOPES'),
  robotEnrollment: extractStringList('ROBOT_ENROLLMENT_SCOPES'),
  robotSimulation: extractStringList('ROBOT_SIMULATION_SCOPES'),
  mcpPairing: extractStringList('MCP_PAIRING_SCOPES'),
};

if (!scopeGroups.all?.length) {
  console.error(
    'COMMONS_API_BUILD_FAILED could not extract ALLOWED_CREDENTIAL_SCOPES from backend/server.js. ' +
      'The declaration shape changed; update extractStringList() rather than hardcoding the list here.'
  );
  process.exit(1);
}

// Group by resource prefix so consumers can reason about families of permission
// ("everything robots:*") without string surgery at the call site.
const byResource = {};
for (const scope of scopeGroups.all) {
  const [resource] = scope.split(':');
  (byResource[resource] ??= []).push(scope);
}

const scopes = {
  generated_from: 'backend/server.js',
  count: scopeGroups.all.length,
  all: scopeGroups.all,
  by_resource: Object.fromEntries(Object.entries(byResource).map(([key, value]) => [key, value.sort()])),
  groups: {
    bootstrap_issuable: scopeGroups.bootstrapIssuable ?? [],
    robot_enrollment: scopeGroups.robotEnrollment ?? [],
    robot_simulation: scopeGroups.robotSimulation ?? [],
    mcp_pairing: scopeGroups.mcpPairing ?? [],
  },
  // A write scope is the interesting half for a client: these are the operations
  // that need an Idempotency-Key and that rate limiting protects.
  write_scopes: scopeGroups.all.filter((scope) => /:(write|create)$/.test(scope)).sort(),
  read_scopes: scopeGroups.all.filter((scope) => /:read$/.test(scope)).sort(),
};

/* ------------------------------------------------------- error code catalogue */

// Every `httpError(status, 'code', ...)` the kernel can raise. Published so a
// client can switch on a stable machine-readable code instead of matching prose.
const errorCatalogue = new Map();
for (const match of serverSource.matchAll(/httpError\(\s*(\d{3})\s*,\s*'([a-z0-9_]+)'/g)) {
  const status = Number(match[1]);
  const code = match[2];
  if (!errorCatalogue.has(code)) errorCatalogue.set(code, new Set());
  errorCatalogue.get(code).add(status);
}

const errors = {
  generated_from: 'backend/server.js',
  count: errorCatalogue.size,
  codes: [...errorCatalogue.entries()]
    .map(([code, statuses]) => ({ code, statuses: [...statuses].sort((a, b) => a - b) }))
    .sort((a, b) => a.code.localeCompare(b.code)),
};

/* ------------------------------------------------------------ route summary */

const routes = routesLegacy
  ? {
      generated_from: 'artifacts/routes-legacy.json',
      source_sha256: routesLegacy.source_sha256 ?? null,
      route_count: routesLegacy.route_count,
      by_method: routesLegacy.by_method ?? {},
      by_surface: routesLegacy.by_surface ?? {},
      by_domain: routesLegacy.by_domain ?? {},
      routes: (routesLegacy.routes ?? []).map((route) => ({
        method: route.method,
        path: route.path,
        domain: route.domain,
        surface: route.surface,
        documented: Boolean(route.documented),
      })),
    }
  : {
      generated_from: null,
      note: 'artifacts/routes-legacy.json was absent at build time. Run `npm run audit:legacy` and rebuild.',
      route_count: 0,
      routes: [],
    };

/* ---------------------------------------------------------- storage posture */

const storage = parity
  ? {
      generated_from: 'config/cloudflare-parity.json',
      platform: 'cloudflare-workers-d1',
      totals: parity.totals ?? {},
      domains: (parity.domains ?? []).map((domain) => ({
        domain: domain.domain,
        status: domain.status,
        routes: domain.routes,
        normalizationPlanned: domain.normalizationPlanned ?? false,
      })),
    }
  : { generated_from: null, note: 'config/cloudflare-parity.json was absent at build time.' };

/* -------------------------------------------------------------- discovery */

// Served verbatim by the API at these paths. Shipping them lets a client
// bootstrap without a network round trip, and lets a test assert the deployed
// documents still match the contract it was built against.
const wellKnown = {};
for (const [name, relative] of Object.entries({
  commons: '.well-known/commons.json',
  agentNetwork: '.well-known/agent-network',
  commonsRobots: '.well-known/commons-robots.json',
})) {
  if (!exists(relative)) continue;
  try {
    wellKnown[name] = readJson(relative);
  } catch {
    // agent-network has no .json extension and may not be JSON; skip quietly.
  }
}

/* ------------------------------------------------------------------- output */

const files = {
  'openapi.json': openapi,
  'release.json': {
    ...release,
    package: manifest.name,
    package_version: manifest.version,
  },
  'scopes.json': scopes,
  'errors.json': errors,
  'routes.json': routes,
  'storage.json': storage,
  'well-known.json': wellKnown,
};

const rendered = Object.fromEntries(
  Object.entries(files).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`])
);

if (checkOnly) {
  const stale = [];
  for (const [name, content] of Object.entries(rendered)) {
    const target = path.join(OUT_DIR, name);
    if (!fs.existsSync(target)) stale.push(`${name} (missing)`);
    else if (fs.readFileSync(target, 'utf8') !== content) stale.push(`${name} (stale)`);
  }
  if (stale.length) {
    console.error(
      `COMMONS_API_STALE ${stale.join(', ')}. Run: npm run build --prefix packages/api`
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      { command: 'commons-api build --check', status: 'current', version: manifest.version },
      null,
      2
    )
  );
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of Object.entries(rendered)) {
  fs.writeFileSync(path.join(OUT_DIR, name), content, 'utf8');
}

// Mirror the repository licence into the package so the published tarball is
// self-contained; `files` in package.json expects it.
if (exists('LICENSE')) fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(PACKAGE_DIR, 'LICENSE'));

const digest = crypto
  .createHash('sha256')
  .update(Object.values(rendered).join(''))
  .digest('hex');

console.log(
  JSON.stringify(
    {
      command: 'commons-api build',
      package: manifest.name,
      version: manifest.version,
      openapi_operations: Object.values(openapi.paths ?? {}).reduce(
        (sum, operations) =>
          sum + Object.keys(operations).filter((verb) => ['get', 'post', 'patch', 'put', 'delete', 'head'].includes(verb)).length,
        0
      ),
      routes: routes.route_count,
      scopes: scopes.count,
      error_codes: errors.count,
      well_known_documents: Object.keys(wellKnown).length,
      contract_sha256: digest.slice(0, 16),
      written: Object.keys(rendered).map((name) => `packages/api/generated/${name}`),
    },
    null,
    2
  )
);
