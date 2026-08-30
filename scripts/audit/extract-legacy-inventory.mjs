#!/usr/bin/env node
/**
 * COMMONS Phase VIII — legacy kernel inventory extractor.
 *
 * Reads backend/server.js statically and emits a machine-readable
 * specification of everything the legacy Node kernel exposes. The Cloudflare
 * port is written FROM these artifacts, not from anyone's recollection of a
 * 581 KB single-file server.
 *
 * Emits:
 *   artifacts/routes-legacy.json          canonical route inventory (the parity gate input)
 *   artifacts/legacy/route-specs.json     per-occurrence mined spec for each route
 *   artifacts/legacy/collections.json     the ~150 store collections + who touches them
 *   artifacts/legacy/functions.json       helper inventory, incl. discovered auth helpers
 *   artifacts/legacy/summary.json         counts and extraction diagnostics
 *
 * Design notes
 * ------------
 * Handler boundaries: this file is one long ordered `if (...) return handler()`
 * dispatcher, so the reliable boundary for "the body belonging to route N" is
 * "the text up to the next route guard". That avoids brace matching across
 * template literals full of HTML, which is where naive parsers break on this
 * file. Windows are additionally capped so a missing next-guard cannot swallow
 * the rest of the file.
 *
 * Over-inclusion is deliberately preferred to under-inclusion: a spec that
 * lists one extra collection is a review nuisance, a spec that omits a scope
 * check is a security regression.
 *
 * Usage:
 *   node scripts/audit/extract-legacy-inventory.mjs
 *   node scripts/audit/extract-legacy-inventory.mjs --print
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_PATH = path.join(ROOT, 'backend', 'server.js');
const ROUTES_META_PATH = path.join(ROOT, 'backend', 'routes.json');
const OPENAPI_PATH = path.join(ROOT, 'backend', 'openapi.json');
const OUT_DIR = path.join(ROOT, 'artifacts');
const OUT_LEGACY_DIR = path.join(OUT_DIR, 'legacy');

const MAX_WINDOW = 8000; // hard cap on an inferred handler body
const CONDITION_LOOKBEHIND = 500; // how far back to hunt for the enclosing `if (`

const printOnly = process.argv.includes('--print');

/* ------------------------------------------------------------------ helpers */

const unique = (values) => [...new Set(values)].sort();

function matchAll(source, regex, mapper) {
  const out = [];
  for (const match of source.matchAll(regex)) out.push(mapper(match));
  return out;
}

/** Classify a path into the surface it belongs to. */
function classify(routePath) {
  if (routePath.startsWith('/api/v1/')) return 'api-v1';
  if (routePath.startsWith('/api/')) return 'api';
  if (routePath.startsWith('/v1/')) return 'api-v1-alias';
  if (routePath.startsWith('/.well-known/')) return 'well-known';
  if (routePath.startsWith('/oauth')) return 'oauth';
  if (routePath === '/mcp' || routePath.startsWith('/mcp/')) return 'mcp';
  if (routePath === '/skill.md' || routePath === '/openapi.json') return 'contract';
  if (routePath === '/robots.txt') return 'contract';
  if (routePath === '/developers') return 'page';
  return 'page';
}

/**
 * Group a route path to a product domain. Used to drive the parity ledger, so
 * the mapping is intentionally explicit rather than clever: an unrecognised
 * path must surface as "unclassified" and fail review, not get silently
 * bucketed somewhere plausible.
 */
const DOMAIN_RULES = [
  [/^\/api\/v1\/(agents|principals|personas|operators|identity|package-identities|activation|runtime-sessions|sessions)\b/, 'identity'],
  [/^\/api\/v1\/(posts|replies|reactions|feed|relationships|follows|bookmarks|watchlists|blocks|mutes)\b/, 'social'],
  [/^\/api\/v1\/(communities)\b/, 'communities'],
  [/^\/api\/v1\/(challenges|submissions)\b/, 'challenges'],
  [/^\/api\/v1\/(governance|proposals|council|councils|votes|amendments|commitments)\b/, 'councils'],
  [/^\/api\/v1\/(moderation|reports|appeals)\b/, 'moderation'],
  [/^\/api\/v1\/(notifications|notification-preferences|mentions)\b/, 'notifications'],
  [/^\/api\/v1\/(credentials|keys|attestations)\b/, 'credentials'],
  [/^\/api\/v1\/(mcp)\b/, 'mcp'],
  [/^\/api\/v1\/(robots)\b/, 'robots'],
  [/^\/api\/v1\/(articles|citations)\b/, 'articles'],
  [/^\/api\/v1\/(repositories|fragments|code)\b/, 'repositories'],
  [/^\/api\/v1\/(guilds)\b/, 'guilds'],
  [/^\/api\/v1\/(chats|conversations|messages)\b/, 'chats'],
  [/^\/api\/v1\/(topics)\b/, 'topics'],
  [/^\/api\/v1\/(federation|remote-identities)\b/, 'federation'],
  [/^\/api\/v1\/(provenance|tool-executions|observer)\b/, 'provenance'],
  [/^\/api\/v1\/(projects|tasks|artifacts|work|collaboration)\b/, 'projects'],
  [/^\/api\/v1\/(reputation|claims|replications|evidence)\b/, 'reputation'],
  [/^\/api\/v1\/(services|discovery|search)\b/, 'discovery'],
  [/^\/api\/v1\/(observatory|analytics|network|population)\b/, 'observatory'],
  [/^\/api\/v1\/(skills)\b/, 'skills'],
  [/^\/api\/v1\/(webhooks|queue|delivery|flags|emergency)\b/, 'operations'],
  [/^\/api\/v1\/(health|ready|version|compat|onboarding|bootstrap)\b/, 'contracts'],
  [/^\/api\/v1\/stream\b/, 'realtime'],
  [/^\/api\/(health|version)\b/, 'contracts'],
  [/^\/oauth/, 'oauth'],
  [/^\/\.well-known\/oauth/, 'oauth'],
  [/^\/\.well-known\//, 'contracts'],
  [/^\/mcp/, 'mcp'],
  [/^\/(skill\.md|openapi\.json|robots\.txt|developers)$/, 'contracts'],
];

function domainFor(routePath) {
  for (const [pattern, domain] of DOMAIN_RULES) if (pattern.test(routePath)) return domain;
  return 'pages';
}

/* -------------------------------------------------------------- source load */

if (!fs.existsSync(SERVER_PATH)) {
  console.error(`LEGACY_SOURCE_MISSING ${SERVER_PATH}`);
  process.exit(1);
}

const source = fs.readFileSync(SERVER_PATH, 'utf8');
const sourceSha = crypto.createHash('sha256').update(source).digest('hex');
const routesMeta = JSON.parse(fs.readFileSync(ROUTES_META_PATH, 'utf8'));
const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));

/* ---------------------------------------------------- function/helper index */

const functionNames = unique(
  matchAll(source, /\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g, (m) => m[1])
    .concat(matchAll(source, /\bconst\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g, (m) => m[1]))
);

// Auth-relevant helpers are DISCOVERED from the source rather than hardcoded,
// so a helper we have never seen still shows up in the per-route spec.
const AUTH_HINT = /(auth|require|scope|credential|operator|anonymous|bearer|token|signature|identity|principal|permission|gate|enforce)/i;
const authHelpers = functionNames.filter((name) => AUTH_HINT.test(name));

/* ------------------------------------------------------- collection index */

const collectionsMatch = source.match(/const COLLECTIONS = \[([\s\S]*?)\];/);
const collections = collectionsMatch
  ? unique(matchAll(collectionsMatch[1], /'([A-Za-z0-9_]+)'/g, (m) => m[1]))
  : [];

const storeVersionMatch = source.match(/const STORE_VERSION = (\d+)/);
const storeVersion = storeVersionMatch ? Number(storeVersionMatch[1]) : null;

/* ------------------------------------------------------------ route guards */

/**
 * Every way the legacy dispatcher tests a path. Each entry records where the
 * literal sits in the source so handler windows can be derived from ordering.
 */
const GUARD_PATTERNS = [
  { name: 'exact', regex: /(?:parsed\.)?pathname\s*===\s*'([^']+)'/g, match: 'exact' },
  { name: 'exact-reversed', regex: /'([^']+)'\s*===\s*(?:parsed\.)?pathname/g, match: 'exact' },
  { name: 'prefix', regex: /(?:parsed\.)?pathname\.startsWith\('([^']+)'\)/g, match: 'prefix' },
];

const guards = [];
for (const pattern of GUARD_PATTERNS) {
  for (const match of source.matchAll(pattern.regex)) {
    const value = match[1];
    if (!value.startsWith('/')) continue;
    guards.push({
      path: value,
      matchKind: pattern.match,
      guard: pattern.name,
      index: match.index,
      length: match[0].length,
    });
  }
}
guards.sort((a, b) => a.index - b.index);

// `parts[N] === '...'` segment tests. These build dynamic API paths that never
// appear as a single literal.
const segmentTests = matchAll(source, /parts\[(\d+)\]\s*===\s*'([^']+)'/g, (m) => ({
  position: Number(m[1]),
  value: m[2],
  index: m.index,
}));

/* ------------------------------------------- dynamic (segment) route rebuild
 * The legacy dispatcher matches parameterised API paths by comparing individual
 * segments of `pathname.split('/').filter(Boolean)` instead of comparing a whole
 * string. Those routes are invisible to literal extraction, so they are
 * reconstructed here from the enclosing `if (...)` condition:
 *
 *   if (method === 'GET' && parts[2] === 'agents' && parts.length === 4)
 *     -> GET /api/v1/agents/:param3
 *
 * Positions with no literal become named parameters. A `parts.length` test
 * fixes the arity; without one, the highest tested position is used and the
 * route is flagged `arity: "inferred"` so a reviewer can confirm it.
 */

/** Read the full parenthesised condition of an `if (` at `ifIndex`. */
function readCondition(src, ifIndex) {
  const open = src.indexOf('(', ifIndex);
  if (open < 0) return '';
  const limit = Math.min(src.length, open + 4000);
  let depth = 0;
  let i = open;
  while (i < limit) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < limit && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
    i += 1;
  }
  return src.slice(open + 1, limit);
}

const dynamicRouteIndex = new Map();
const dynamicDiagnostics = [];

for (const ifMatch of source.matchAll(/\bif\s*\(/g)) {
  const condition = readCondition(source, ifMatch.index);
  if (!condition.includes('parts[')) continue;

  const segments = new Map();
  for (const segment of condition.matchAll(/parts\[(\d+)\]\s*===\s*'([^']+)'/g)) {
    segments.set(Number(segment[1]), segment[2]);
  }
  if (!segments.size) continue;

  // Arity. `=== N` is exact; `>= N` / `> N` only sets a floor.
  const exactLength = condition.match(/parts\.length\s*===\s*(\d+)/);
  const minLength = condition.match(/parts\.length\s*(?:>=|>)\s*(\d+)/);
  const highestTested = Math.max(...segments.keys());
  const arity = exactLength
    ? { length: Number(exactLength[1]), kind: 'exact' }
    : minLength
      ? { length: Math.max(Number(minLength[1]), highestTested + 1), kind: 'minimum' }
      : { length: highestTested + 1, kind: 'inferred' };

  // apiRoute() is only reached for /api/v1/*, so positions 0 and 1 are implied
  // whenever the condition does not state them.
  if (!segments.has(0)) segments.set(0, 'api');
  if (!segments.has(1)) segments.set(1, 'v1');

  const length = Math.max(arity.length, highestTested + 1, 2);
  const parts = [];
  for (let position = 0; position < length; position += 1) {
    parts.push(segments.has(position) ? segments.get(position) : `:param${position}`);
  }
  const routePath = `/${parts.join('/')}`;

  const directMethods = matchAll(condition, /(?:request\.)?method\s*===\s*'([A-Z]+)'/g, (m) => m[1]);
  const listedMethods = [];
  for (const listed of condition.matchAll(/\[([^\]]*?)\]\.includes\(\s*(?:request\.)?method\s*\)/g)) {
    listedMethods.push(...matchAll(listed[1], /'([A-Z]+)'/g, (m) => m[1]));
  }
  const methods = unique([...directMethods, ...listedMethods]);

  dynamicDiagnostics.push({
    path: routePath,
    methods: methods.length ? methods : ['ANY'],
    arity,
    sourceIndex: ifMatch.index,
  });

  for (const method of methods.length ? methods : ['ANY']) {
    const key = `${method} ${routePath}`;
    if (!dynamicRouteIndex.has(key)) {
      dynamicRouteIndex.set(key, {
        method,
        path: routePath,
        matchKind: 'segments',
        surface: classify(routePath),
        domain: domainFor(routePath),
        arity: arity.kind,
        occurrences: 0,
        sourceIndex: ifMatch.index,
      });
    }
    dynamicRouteIndex.get(key).occurrences += 1;
  }
}

/* -------------------------------------------------------- per-route mining */

function conditionTextFor(index) {
  const from = Math.max(0, index - CONDITION_LOOKBEHIND);
  const behind = source.slice(from, index);
  const ifAt = behind.lastIndexOf('if (');
  const start = ifAt >= 0 ? from + ifAt : from;
  // Extend a little past the literal so `&& request.method === 'GET'` is seen.
  return source.slice(start, Math.min(source.length, index + 300));
}

function methodsFor(index) {
  const condition = conditionTextFor(index);
  const direct = matchAll(condition, /(?:request\.)?method\s*===\s*'([A-Z]+)'/g, (m) => m[1]);
  const listed = [];
  for (const match of condition.matchAll(/\[([^\]]*?)\]\.includes\(\s*(?:request\.)?method\s*\)/g)) {
    listed.push(...matchAll(match[1], /'([A-Z]+)'/g, (m) => m[1]));
  }
  const methods = unique([...direct, ...listed]);
  return methods.length ? methods : ['ANY'];
}

/**
 * Handler bodies are bounded by the NEXT route anchor, where an anchor is either
 * a path literal guard or a reconstructed segment-matched condition. Using both
 * kinds keeps a literal route from absorbing the dynamic routes that follow it.
 */
const anchorIndices = [
  ...new Set([...guards.map((guard) => guard.index), ...dynamicDiagnostics.map((entry) => entry.sourceIndex)]),
].sort((a, b) => a - b);

function windowAt(index) {
  const position = anchorIndices.indexOf(index);
  const next = position >= 0 ? (anchorIndices[position + 1] ?? source.length) : source.length;
  return source.slice(index, Math.min(next, index + MAX_WINDOW, source.length));
}

function mineSpec({ path: routePath, matchKind, index, methodOverride }) {
  const body = windowAt(index);
  const methods = methodOverride || methodsFor(index);

  const storeRefs = matchAll(body, /store\.([A-Za-z0-9_]+)/g, (m) => m[1]).filter((name) =>
    collections.includes(name)
  );
  const writes = unique(
    matchAll(body, /store\.([A-Za-z0-9_]+)\.(?:push|splice|unshift|pop|shift)\s*\(/g, (m) => m[1]).filter(
      (name) => collections.includes(name)
    )
  );
  const reads = unique(storeRefs.filter((name) => !writes.includes(name)));

  return {
    method: methods.length === 1 ? methods[0] : methods,
    path: routePath,
    matchKind,
    surface: classify(routePath),
    domain: domainFor(routePath),
    sourceIndex: index,
    windowChars: body.length,

    // ---- authorisation posture
    auth: {
      helpers: unique(
        authHelpers.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(body))
      ),
      anonymous: /enforceAnonymous\s*\(/.test(body),
      mutation: /\bmutate\s*\(/.test(body),
      idempotent: /Idempotency-Key|idempotency/i.test(body),
      signature: /requireIdentitySignature|verifyEd25519/.test(body),
      operator: /operator/i.test(body) && /token/i.test(body),
    },
    scopes: unique(matchAll(body, /'([a-z][a-z_]*:[a-z][a-z_:]*)'/g, (m) => m[1])),

    // ---- persistence footprint
    reads,
    writes,
    persists: /\bpersist\s*\(/.test(body),

    // ---- observable behaviour
    events: unique(matchAll(body, /'([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)'/g, (m) => m[1])),
    statuses: unique(
      matchAll(body, /json\(\s*response\s*,\s*(\d{3})/g, (m) => Number(m[1]))
        .concat(matchAll(body, /send\(\s*response\s*,\s*(\d{3})/g, (m) => Number(m[1])))
        .concat(matchAll(body, /status:\s*(\d{3})\b/g, (m) => Number(m[1])))
        .map(String)
    ).map(Number),
    errors: unique(matchAll(body, /httpError\(\s*(\d{3})/g, (m) => Number(m[1])).map(String)).map(Number),
    streaming: /text\/event-stream|streamRoute/.test(body),
    queues: /setTimeout|setInterval/.test(body),
  };
}

const literalSpecs = guards.map((guard) =>
  mineSpec({ path: guard.path, matchKind: guard.matchKind, index: guard.index })
);
const dynamicSpecs = dynamicDiagnostics.map((entry) =>
  mineSpec({
    path: entry.path,
    matchKind: 'segments',
    index: entry.sourceIndex,
    methodOverride: entry.methods,
  })
);
const specs = [...literalSpecs, ...dynamicSpecs].sort((a, b) => a.sourceIndex - b.sourceIndex);

/* --------------------------------------------- canonical route inventory */

/**
 * The canonical inventory is a UNION of three independent views of the legacy
 * kernel, because no single view is complete:
 *
 *   openapi   backend/openapi.json — authoritative PATH SHAPE and parameter
 *             names for everything that was documented (149 operations)
 *   literal   `pathname === '...'` / `.startsWith('...')` guards in server.js
 *   segments  conditions reconstructed from `parts[N] === '...'` comparisons
 *   routes    backend/routes.json browser + dynamic page routes
 *
 * Entries are keyed by SHAPE (method + path with every parameter collapsed to
 * `*`) so the same endpoint discovered by two views collapses into one route
 * instead of double-counting. When OpenAPI documents a route, its spelling wins,
 * because `{robot_id}` is more useful to a porter than `:param5`.
 *
 * Measured recall of the static extractor against OpenAPI was 142/149 shapes;
 * the union closes the remaining 7, which were all arity near-misses on deeply
 * nested paths rather than missing handlers.
 */
const shapeOf = (method, routePath) =>
  `${method} ${routePath.replace(/\{[^}]+\}/g, '*').replace(/:[A-Za-z0-9_]+/g, '*').replace(/\/+$/, '') || '/'}`;

const routeIndex = new Map();

function upsert(key, entry, sourceLabel) {
  const existing = routeIndex.get(key);
  if (!existing) {
    routeIndex.set(key, { ...entry, sources: [sourceLabel], occurrences: 1 });
    return routeIndex.get(key);
  }
  existing.occurrences += 1;
  if (!existing.sources.includes(sourceLabel)) existing.sources.push(sourceLabel);
  return existing;
}

// ---- view 1: OpenAPI (authoritative shape + parameter names)
const openapiOperations = [];
for (const [specPath, operations] of Object.entries(openapi.paths || {})) {
  for (const [verb, operation] of Object.entries(operations || {})) {
    if (!['get', 'post', 'patch', 'put', 'delete', 'head', 'options'].includes(verb)) continue;
    const method = verb.toUpperCase();
    openapiOperations.push({ method, path: specPath, operationId: operation?.operationId || null });
    upsert(
      shapeOf(method, specPath),
      {
        method,
        path: specPath,
        matchKind: 'documented',
        surface: classify(specPath),
        domain: domainFor(specPath),
        arity: 'exact',
        documented: true,
        operationId: operation?.operationId || null,
        summary: typeof operation?.summary === 'string' ? operation.summary : null,
      },
      'openapi'
    );
  }
}

// ---- view 2 + 3: static extraction from server.js
for (const spec of specs) {
  const methods = Array.isArray(spec.method) ? spec.method : [spec.method];
  for (const method of methods) {
    const key = shapeOf(method, spec.path);
    const entry = upsert(
      key,
      {
        method,
        path: spec.path,
        matchKind: spec.matchKind,
        surface: spec.surface,
        domain: spec.domain,
        documented: false,
      },
      spec.matchKind === 'segments' ? 'segments' : 'literal'
    );
    // A documented route keeps the OpenAPI spelling but gains the implementation
    // detail that only static analysis can see.
    if (!entry.implemented) entry.implemented = true;
    if (spec.matchKind === 'segments' && !entry.arity) entry.arity = 'inferred';
  }
}

// Carry the arity confidence of reconstructed segment routes onto the canonical
// entry, so `arity: "inferred"` stays visible to whoever reviews the ledger.
for (const dynamic of dynamicRouteIndex.values()) {
  const existing = routeIndex.get(shapeOf(dynamic.method, dynamic.path));
  if (existing && !existing.documented) existing.arity = dynamic.arity;
}

// ---- view 4: server-rendered browser pages, declared in routes.json
for (const [pagePath, meta] of Object.entries(routesMeta.browserRoutes || {})) {
  const entry = upsert(
    shapeOf('GET', pagePath),
    {
      method: 'GET',
      path: pagePath,
      matchKind: 'page',
      surface: 'page',
      domain: 'pages',
      arity: 'exact',
      documented: false,
      section: meta[0],
      title: meta[1],
    },
    'routes.json:browserRoutes'
  );
  entry.section = entry.section || meta[0];
  entry.title = entry.title || meta[1];
}
for (const dynamicPath of routesMeta.dynamicRoutes || []) {
  upsert(
    shapeOf('GET', dynamicPath),
    {
      method: 'GET',
      path: dynamicPath,
      matchKind: 'page-pattern',
      surface: 'page',
      domain: domainFor(dynamicPath),
      arity: 'exact',
      documented: false,
    },
    'routes.json:dynamicRoutes'
  );
}

const routes = [...routeIndex.values()]
  .map((route) => ({ ...route, shape: shapeOf(route.method, route.path) }))
  .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

/* ------------------------------------------------- openapi reconciliation
 * Two independent views disagreeing is a signal, not noise:
 *   documented_not_implemented  the contract promises something the kernel may
 *                               not serve, or static analysis could not see it
 *   implemented_not_documented  real surface area absent from the contract; it
 *                               still has to be ported, and it still needs a
 *                               parity entry
 */
const documentedShapes = new Set(openapiOperations.map((op) => shapeOf(op.method, op.path)));
const staticShapes = new Set();
for (const spec of specs) {
  const methods = Array.isArray(spec.method) ? spec.method : [spec.method];
  for (const method of methods) staticShapes.add(shapeOf(method, spec.path));
}
const reconciliation = {
  openapi_operations: openapiOperations.length,
  statically_extracted_shapes: staticShapes.size,
  union_routes: routes.length,
  documented_not_statically_extracted: [...documentedShapes].filter((shape) => !staticShapes.has(shape)).sort(),
  implemented_not_documented: [...staticShapes]
    .filter((shape) => !documentedShapes.has(shape) && shape.includes(' /api/'))
    .sort(),
};

/* ------------------------------------------------ collection cross-ref */

const collectionUsage = collections.map((name) => {
  const readers = specs.filter((spec) => spec.reads.includes(name));
  const writers = specs.filter((spec) => spec.writes.includes(name));
  return {
    collection: name,
    readRoutes: readers.length,
    writeRoutes: writers.length,
    domains: unique([...readers, ...writers].map((spec) => spec.domain)),
    touched: readers.length + writers.length > 0,
  };
});

/* ------------------------------------------------------------ diagnostics */

const bySurface = {};
for (const route of routes) bySurface[route.surface] = (bySurface[route.surface] || 0) + 1;
const byDomain = {};
for (const route of routes) byDomain[route.domain] = (byDomain[route.domain] || 0) + 1;
const byMethod = {};
for (const route of routes) byMethod[route.method] = (byMethod[route.method] || 0) + 1;

const generatedAt = new Date().toISOString();
const provenance = {
  generated_at: generatedAt,
  generator: 'scripts/audit/extract-legacy-inventory.mjs',
  source: 'backend/server.js',
  source_bytes: Buffer.byteLength(source, 'utf8'),
  source_sha256: sourceSha,
  store_schema_version: storeVersion,
};

const routesLegacy = {
  ...provenance,
  openapi_version: openapi?.info?.version || null,
  route_count: routes.length,
  by_method: byMethod,
  by_surface: bySurface,
  by_domain: byDomain,
  reconciliation,
  routes,
};

const summary = {
  ...provenance,
  totals: {
    routes: routes.length,
    route_occurrences: specs.length,
    openapi_operations: openapiOperations.length,
    documented_routes: routes.filter((route) => route.documented).length,
    undocumented_routes: routes.filter((route) => !route.documented).length,
    collections: collections.length,
    collections_touched: collectionUsage.filter((entry) => entry.touched).length,
    functions: functionNames.length,
    auth_helpers: authHelpers.length,
    segment_tests: segmentTests.length,
  },
  reconciliation,
  by_domain: byDomain,
  by_surface: bySurface,
  by_method: byMethod,
  match_kinds: (() => {
    const counts = {};
    for (const route of routes) counts[route.matchKind] = (counts[route.matchKind] || 0) + 1;
    return counts;
  })(),
  arity_confidence: (() => {
    const counts = {};
    for (const route of routes) if (route.arity) counts[route.arity] = (counts[route.arity] || 0) + 1;
    return counts;
  })(),
  // Residual limitations. Reported loudly rather than hidden, because the parity
  // gate is only as trustworthy as this list is honest.
  caveats: {
    inferred_arity:
      'Segment routes without a parts.length test have their arity inferred from the highest tested position. Confirm these against the source before treating the count as exact.',
    implied_prefix:
      'Segment conditions that do not test parts[0]/parts[1] are assumed to sit inside apiRoute() and are prefixed /api/v1.',
    parameter_names:
      'Reconstructed parameters are positional (:param3), not the legacy variable names. Path SHAPE is authoritative; names are not.',
    over_inclusion:
      'Handler windows are bounded by the next route anchor, so a mined scope/collection list may include a neighbour. Over-inclusion is deliberate.',
  },
};

/* ---------------------------------------------------------------- output */

if (printOnly) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

fs.mkdirSync(OUT_LEGACY_DIR, { recursive: true });
const write = (file, data) => {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return `${path.relative(ROOT, file)} (${routeCountLabel(data)})`;
};
function routeCountLabel(data) {
  if (Array.isArray(data)) return `${data.length} entries`;
  if (data.routes) return `${data.routes.length} routes`;
  if (data.collections) return `${data.collections.length} collections`;
  return 'ok';
}

const written = [
  write(path.join(OUT_DIR, 'routes-legacy.json'), routesLegacy),
  write(path.join(OUT_LEGACY_DIR, 'route-specs.json'), { ...provenance, specs }),
  write(path.join(OUT_LEGACY_DIR, 'collections.json'), {
    ...provenance,
    store_schema_version: storeVersion,
    collections: collectionUsage,
  }),
  write(path.join(OUT_LEGACY_DIR, 'functions.json'), {
    ...provenance,
    functions: functionNames,
    auth_helpers: authHelpers,
  }),
  write(path.join(OUT_LEGACY_DIR, 'segment-tests.json'), {
    ...provenance,
    segment_tests: segmentTests,
    reconstructed_routes: dynamicDiagnostics,
  }),
  write(path.join(OUT_LEGACY_DIR, 'summary.json'), summary),
];

console.log(
  JSON.stringify(
    {
      command: 'audit:legacy',
      ...summary.totals,
      store_schema_version: storeVersion,
      source_sha256: sourceSha.slice(0, 16),
      written,
    },
    null,
    2
  )
);
