#!/usr/bin/env node
const { URL } = require('node:url');
const { RELEASE_VERSION, validateEnvironment } = require('../../backend/packages/config');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function targetUrl() {
  const value = option('--url') || process.env.COMMONS_BOOTSTRAP_URL;
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use http or https.');
  return url;
}
function expectedStatus(endpoint) { return endpoint.endsWith('/ready') ? 'ready' : endpoint.endsWith('/health') ? 'ok' : null; }
async function getJson(base, endpoint) {
  const url = new URL(endpoint, `${base.origin}/`);
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  let body = {};
  try { body = await response.json(); } catch { throw new Error(`${endpoint} returned non-JSON content (HTTP ${response.status}).`); }
  if (response.status !== 200) throw new Error(`${endpoint} returned HTTP ${response.status}.`);
  const expected = expectedStatus(endpoint);
  if (expected && body.status !== expected) throw new Error(`${endpoint} reported status ${body.status || 'unknown'}; expected ${expected}.`);
  if (endpoint === '/api/version' && body.api !== 'v1') throw new Error(`${endpoint} did not report API v1.`);
  return { endpoint, status: response.status, version: body.version || null, status_value: body.status || null };
}
async function main() {
  const configuration = validateEnvironment();
  const target = targetUrl();
  const checks = target ? await Promise.all(['/api/health', '/api/version', '/api/v1/ready', '/api/v1/bootstrap'].map((endpoint) => getJson(target, endpoint))) : [];
  for (const check of checks) if (check.version && check.version !== RELEASE_VERSION) throw new Error(`${check.endpoint} reports ${check.version}; expected ${RELEASE_VERSION}.`);
  console.log(JSON.stringify({ command: 'bootstrap', release_version: RELEASE_VERSION, mode: configuration.mode, storage: configuration.storage, read_only: true, target: target?.origin || null, checks }, null, 2));
}
main().catch((error) => { console.error(`BOOTSTRAP_FAILED ${error.message}`); process.exitCode = 1; });
