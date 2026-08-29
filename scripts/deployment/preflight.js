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
  'vercel.json', 'frontend/vercel.json', 'frontend/package.json', 'media/evidence.json',
  'backend/.env.example', 'frontend/.env.example', 'frontend/analytics.js',
  'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md', 'SECURITY.md'
];
const FRONTEND_PAGES = { '/': '/index.html', '/onboard': '/onboard.html', '/robots': '/robots.html', '/observatory': '/index.html', '/observatory/population': '/population.html' };
const FRONTEND_OWNED = new Set(Object.keys(FRONTEND_PAGES));

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
function validateVercelConfig(vercel, label) {
  const rewrites = vercel.rewrites || [];
  const sources = new Set(rewrites.map((rewrite) => rewrite.source));
  assert(sources.size === rewrites.length, `${label} rewrite sources must be unique`);
  assert(sources.has('/api/:path*'), `${label} must forward /api/* to the reference service`);
  assert(sources.has('/v1/:path*'), `${label} must forward /v1/* to the reference service`);
  for (const [source, destination] of Object.entries(FRONTEND_PAGES)) {
    const localRewrite = rewrites.find((rewrite) => rewrite.source === source);
    assert(localRewrite?.destination === destination, `${label} must map frontend-owned ${source} to ${destination}`);
  }
  assert(rewrites.every((rewrite) => typeof rewrite.destination === 'string' && (/^https:\/\//.test(rewrite.destination) || rewrite.destination.startsWith('/'))), `${label} rewrites must use HTTPS remote or local frontend destinations`);
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
  const vercel = readJson('vercel.json');
  const frontendVercel = readJson('frontend/vercel.json');
  const railway = readJson('backend/railway.json');
  assert(Number(process.versions.node.split('.')[0]) >= 20, `Node 20 or newer is required; found ${process.versions.node}`);
  assert(packageMetadata.version === release.version && release.version === RELEASE_VERSION, 'root package and backend/config/release.json versions must agree');
  assert(backendPackage.version === release.version && frontendPackage.version === release.version, 'frontend/backend package versions must agree with backend/config/release.json');
  assert(packageMetadata.license === 'MIT' && backendPackage.license === 'MIT' && frontendPackage.license === 'MIT', 'root, frontend, and backend package metadata must declare the MIT license');
  assert(packageMetadata.engines?.node === RELEASE.node && backendPackage.engines?.node === RELEASE.node && frontendPackage.engines?.node === RELEASE.node, 'package engines and release node engine must agree');
  assert(vercel.buildCommand === 'npm --prefix frontend run build' && vercel.outputDirectory === 'frontend/dist', 'root Vercel config must build and serve frontend/dist');
  assert(frontendVercel.buildCommand === 'npm run build' && frontendVercel.outputDirectory === 'dist', 'frontend Vercel config must build and serve dist');
  assert(vercel.installCommand === 'npm install --prefix frontend --no-audit --no-fund', 'root Vercel config must install frontend dependencies explicitly');
  assert(frontendVercel.installCommand === 'npm install --no-audit --no-fund', 'frontend Vercel config must declare an explicit install command');
  for (const relativePath of REQUIRED_FILES) assert(fs.existsSync(path.join(ROOT, relativePath)), `required file is missing: ${relativePath}`);
  validateVercelConfig(vercel, 'root vercel.json');
  validateVercelConfig(frontendVercel, 'frontend/vercel.json');
  assert(Object.keys(routes.browserRoutes || {}).length > 0, 'backend/routes.json must define browser routes');
  assert(routes.staticRoutes.includes('/observatory') && routes.staticRoutes.includes('/onboard'), 'backend/routes.json must retain frontend static route metadata');
  const evidence = hasFlag('--skip-evidence') ? { skipped: true } : validateEvidenceManifest();
  assert(railway.build?.builder === 'NIXPACKS', 'Railway must use the declared Nixpacks builder');
  assert(railway.deploy?.startCommand === 'npm start', 'Railway must start the backend service with npm start');
  assert(railway.deploy?.healthcheckPath === '/api/v1/ready', 'Railway healthcheck must remain /api/v1/ready');
  const target = targetUrl();
  const checks = target ? await Promise.all(['/api/health', '/api/version', '/api/v1/health', '/api/v1/ready', '/api/v1/bootstrap'].map((endpoint) => checkRemote(target, endpoint))) : [];
  console.log(JSON.stringify({ command: 'deploy:check', release_version: RELEASE_VERSION, mode: configuration.mode, storage: configuration.storage, read_only: true, target: target?.origin || null, evidence, checks }, null, 2));
}
main().catch((error) => { console.error(`PREFLIGHT_FAILED ${error.message}`); process.exitCode = 1; });
