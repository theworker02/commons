#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { RELEASE, RELEASE_VERSION, validateEnvironment } = require('../../backend/packages/config');
const { validateEvidenceManifest } = require('../validation/validate-evidence');

const ROOT = path.resolve(__dirname, '../..');
const REQUIRED_FILES = [
  'backend/server.js', 'backend/package.json', 'backend/config/release.json', 'backend/routes.json',
  'backend/railway.json', 'backend/openapi.json', 'skill.md',
  'backend/.well-known/commons.json', 'backend/.well-known/agent-network', 'backend/.well-known/commons-robots.json',
  'frontend/package.json', 'media/evidence.json',
  'backend/.env.example', 'frontend/.env.example', 'frontend/analytics.js',
  'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md', 'SECURITY.md'
];
// Pages whose HTML is authored in frontend/ and served by the backend's static
// route rather than being server-rendered. On a single origin these are not
// "frontend-owned" in a routing sense any more — one process serves both — but
// the files still have to exist for those URLs to resolve.
const FRONTEND_PAGES = { '/': 'index.html', '/onboard': 'onboard.html', '/robots': 'robots.html', '/observatory': 'index.html', '/observatory/population': 'population.html' };

function hasFlag(name) { return process.argv.includes(name); }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function readJson(relativePath) { return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')); }
function targetUrl() {
  const value = option('--url') || process.env.COMMONS_PREFLIGHT_URL;
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use http or https.');
  return url;
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function expectedStatus(endpoint) { return endpoint.endsWith('/ready') ? 'ready' : endpoint.endsWith('/health') ? 'ok' : null; }
async function checkRemote(base, endpoint) {
  const url = new URL(endpoint, `${base.origin}/`);
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  let body = {};
  try { body = await response.json(); } catch { throw new Error(`${endpoint} returned non-JSON content (HTTP ${response.status}).`); }
  assert(response.status === 200, `${endpoint} returned HTTP ${response.status}`);
  assert(body.version === RELEASE_VERSION, `${endpoint} reported version ${body.version || 'unknown'}; expected ${RELEASE_VERSION}`);
  const expected = expectedStatus(endpoint);
  assert(!expected || body.status === expected, `${endpoint} reported status ${body.status || 'unknown'}; expected ${expected}`);
  assert(endpoint !== '/api/version' || body.api === 'v1', `${endpoint} did not report API v1`);
  return { endpoint, status: response.status, status_value: body.status || null, version: body.version };
}
// The frontend and the API are served from ONE origin by the backend process.
// There is no proxy layer to validate, so instead of checking that a rewrite
// table forwards to the right hostname, assert the two things a single origin
// actually depends on: that every declared browser surface is reachable from the
// backend, and that the HTML the static route serves exists on disk.
function validateSingleOrigin(routes) {
  const declared = [
    ...Object.keys(routes.browserRoutes || {}),
    ...(routes.staticRoutes || []),
    ...(routes.dynamicRoutes || [])
  ];
  const duplicates = declared.filter((source, index) => declared.indexOf(source) !== index);
  assert(!duplicates.length, `backend/routes.json declares duplicate routes: ${[...new Set(duplicates)].join(', ')}`);

  // Every static page the backend hands to staticRoute must exist in frontend/.
  for (const [source, file] of Object.entries(FRONTEND_PAGES)) {
    assert(fs.existsSync(path.join(ROOT, 'frontend', file)), `single-origin page ${source} needs frontend/${file}`);
  }

  // No absolute cross-origin destination may remain anywhere in the route table.
  // A single origin means every browser surface resolves relatively.
  const absolute = declared.filter((source) => /^https?:\/\//i.test(source));
  assert(!absolute.length, `backend/routes.json must not reference absolute origins: ${absolute.join(', ')}`);

  return { browser: Object.keys(routes.browserRoutes || {}).length, static: (routes.staticRoutes || []).length, dynamic: (routes.dynamicRoutes || []).length };
}
async function main() {
  const suppliedMode = hasFlag('--production') ? 'production' : process.env.COMMONS_ENV;
  const environment = { ...process.env, ...(suppliedMode ? { COMMONS_ENV: suppliedMode } : {}) };
  const configuration = validateEnvironment({ env: environment });
  const packageMetadata = readJson('package.json');
  const backendPackage = readJson('backend/package.json');
  const frontendPackage = readJson('frontend/package.json');
  const release = readJson('backend/config/release.json');
  const routes = readJson('backend/routes.json');
  const railway = readJson('backend/railway.json');
  assert(Number(process.versions.node.split('.')[0]) >= 20, `Node 20 or newer is required; found ${process.versions.node}`);
  assert(packageMetadata.version === release.version && release.version === RELEASE_VERSION, 'root package and backend/config/release.json versions must agree');
  assert(backendPackage.version === release.version && frontendPackage.version === release.version, 'frontend/backend package versions must agree with backend/config/release.json');
  assert(packageMetadata.license === 'MIT' && backendPackage.license === 'MIT' && frontendPackage.license === 'MIT', 'root, frontend, and backend package metadata must declare the MIT license');
  assert(packageMetadata.engines?.node === RELEASE.node && backendPackage.engines?.node === RELEASE.node && frontendPackage.engines?.node === RELEASE.node, 'package engines and release node engine must agree');
  // The frontend build must land where the backend serves it from. Keeping these
  // two facts asserted together is what stops the origins drifting apart again.
  assert(packageMetadata.scripts?.build === 'npm --prefix frontend run build', 'root package must build the frontend with npm --prefix frontend run build');
  assert(frontendPackage.scripts?.build, 'frontend package must declare a build script');
  for (const relativePath of REQUIRED_FILES) assert(fs.existsSync(path.join(ROOT, relativePath)), `required file is missing: ${relativePath}`);
  // Guard against the two-origin split being reintroduced by accident.
  for (const stale of ['vercel.json', 'frontend/vercel.json']) {
    assert(!fs.existsSync(path.join(ROOT, stale)), `${stale} reintroduces a second origin; the frontend and API are served from one origin`);
  }
  assert(Object.keys(routes.browserRoutes || {}).length > 0, 'backend/routes.json must define browser routes');
  assert(routes.staticRoutes.includes('/observatory') && routes.staticRoutes.includes('/onboard'), 'backend/routes.json must retain frontend static route metadata');
  const origin = validateSingleOrigin(routes);
  const evidence = hasFlag('--skip-evidence') ? { skipped: true } : validateEvidenceManifest();
  assert(railway.build?.builder === 'NIXPACKS', 'Railway must use the declared Nixpacks builder');
  assert(railway.deploy?.startCommand === 'npm start', 'Railway must start the backend service with npm start');
  assert(railway.deploy?.healthcheckPath === '/api/v1/ready', 'Railway healthcheck must remain /api/v1/ready');
  const target = targetUrl();
  const checks = target ? await Promise.all(['/api/health', '/api/version', '/api/v1/health', '/api/v1/ready', '/api/v1/bootstrap'].map((endpoint) => checkRemote(target, endpoint))) : [];
  console.log(JSON.stringify({ command: 'deploy:check', release_version: RELEASE_VERSION, mode: configuration.mode, storage: configuration.storage, read_only: true, topology: 'single-origin', routes: origin, target: target?.origin || null, evidence, checks }, null, 2));
}
main().catch((error) => { console.error(`PREFLIGHT_FAILED ${error.message}`); process.exitCode = 1; });
