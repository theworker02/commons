/*
 * Dependency-free, isolated API integration + fuzz suite.
 *
 * It runs the real backend in a child process against a temporary JSON store.
 * Seeds are deterministic: set COMMONS_FUZZ_SEED and COMMONS_FUZZ_CASES to
 * reproduce or enlarge randomized coverage locally and in CI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend', 'server.js');
const seed = Number(process.env.COMMONS_FUZZ_SEED || 0xC0A55005) >>> 0;
const FUZZ_CASES = Math.max(20, Math.min(500, Number(process.env.COMMONS_FUZZ_CASES || 20)));
let state = seed || 1;
const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
const pick = (values) => values[Math.floor(rand() * values.length)];
const randomToken = (length = 8) => Array.from({ length }, () => pick('abcdefghijklmnopqrstuvwxyz0123456789')).join('');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class CommonsInstance {
  constructor() { this.port = null; this.base = null; this.dir = null; this.child = null; this.log = ''; this.seq = 0; }
  async start({ runtime = true, existingDir = null } = {}) {
    this.port = await reservePort();
    this.base = `http://127.0.0.1:${this.port}`;
    this.dir = existingDir || await fsp.mkdtemp(path.join(os.tmpdir(), 'commons-test-'));
    this.child = spawn(process.execPath, [BACKEND], { env: { ...process.env, COMMONS_ENV: 'test', HOST: '127.0.0.1', PORT: String(this.port), COMMONS_DATA_DIR: this.dir, COMMONS_AGENT_RUNTIME_ENABLED: String(runtime), COMMONS_AGENT_RUNTIME_INTERVAL_MS: '1000', COMMONS_AGENT_RUNTIME_BATCH_SIZE: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => { this.log += chunk; });
    this.child.stderr.on('data', (chunk) => { this.log += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${this.base}/api/v1/ready`)).ok) return; } catch { /* server still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend did not become ready:\n${this.log}`);
  }
  async stop({ removeDir = true } = {}) {
    if (this.child && !this.child.killed) { this.child.kill('SIGTERM'); await new Promise((resolve) => this.child.once('exit', resolve)); }
    this.child = null;
    if (removeDir && this.dir) await fsp.rm(this.dir, { recursive: true, force: true });
  }
  async request(pathname, { method = 'GET', token, body, headers = {}, rawBody } = {}) {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (rawBody !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (['POST', 'PATCH', 'DELETE'].includes(method) && !Object.prototype.hasOwnProperty.call(requestHeaders, 'Idempotency-Key')) requestHeaders['Idempotency-Key'] = `test-${Date.now()}-${++this.seq}`;
    let response;
    try { response = await fetch(`${this.base}${pathname}`, { method, headers: requestHeaders, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) }); }
    catch (error) { throw new Error(`request failed ${method} ${pathname}: ${error.message}; server log: ${this.log.slice(-1200)}`); }
    const text = await response.text(); let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  }
  async register(handle, extra = {}, key) {
    return this.request('/api/v1/agents/register', { method: 'POST', headers: key ? { 'Idempotency-Key': key } : {}, body: { handle, ...extra } });
  }
  async exchange(token, scopes = ['profile:read', 'identity:read', 'social:read', 'social:write', 'notifications:read', 'search:read']) {
    const response = await this.request('/api/v1/principals/me/credentials', { method: 'POST', token, body: { scopes } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.access_token;
  }
}

let app;
let serialTail = Promise.resolve();
function serialTest(name, fn) {
  return test(name, async () => {
    let release;
    const previous = serialTail;
    serialTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { await fn(); } finally { release(); }
  });
}
test.before(async () => { app = new CommonsInstance(); await app.start(); });
test.after(async () => { await app.stop(); });

serialTest('public contract and malformed request boundaries never return 5xx', async () => {
  for (const endpoint of ['/api/v1/health', '/api/v1/ready', '/api/v1/onboarding', '/api/v1/bootstrap', '/api/v1/compat', '/openapi.json', '/.well-known/commons.json']) {
    const response = await app.request(endpoint);
    assert.equal(response.status, 200, endpoint);
  }
  const malformed = await app.request('/api/v1/agents/register', { method: 'POST', rawBody: '{not json' });
  assert.equal(malformed.status, 400);
  const missingKey = await app.request('/api/v1/agents/register', { method: 'POST', headers: { 'Idempotency-Key': '' }, body: { handle: 'missing-key' } });
  assert.equal(missingKey.status, 400);
  const unsupported = await app.request('/api/v1/definitely-not-real');
  assert.equal(unsupported.status, 404);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const response = await app.request('/api/v1/health', { method });
    assert.ok(response.status >= 400 && response.status < 500, `${method} -> ${response.status}`);
  }
});

serialTest('registration, bootstrap, idempotency, social mutation, runtime controls, and restart persist', async () => {
  const first = await app.register('integration-alpha', { interests: ['testing', 'runtime'], capabilities: ['analysis'] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.runtime.initial_run.status, 'SUCCEEDED');
  assert.ok(first.body.runtime.initial_run.actions.some((action) => action.kind === 'post'));
  assert.match(first.body.agent.personality.source, /DERIVED_FROM_REGISTRATION/);
  const token = await app.exchange(first.body.access_token);
  const runtime = await app.request('/api/v1/agents/me/runtime', { token });
  assert.equal(runtime.status, 200);
  assert.equal(runtime.body.runtime.enabled, true);
  assert.ok(runtime.body.history.length >= 1);

  const second = await app.register('integration-beta', { interests: ['testing'], capabilities: ['review'] });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.ok(second.body.runtime.initial_run.actions.some((action) => action.kind === 'follow'));
  assert.ok(second.body.runtime.initial_run.actions.some((action) => action.kind === 'reply'));
  const secondToken = await app.exchange(second.body.access_token);

  const signal = await app.request('/api/v1/agents/me/signals', { method: 'POST', token, body: { kind: 'OFFER', subject: 'test review', tags: ['testing'], visibility: 'PUBLIC' } });
  assert.equal(signal.status, 201, JSON.stringify(signal.body));
  const revoke = await app.request(`/api/v1/agents/me/signals/${signal.body.signal.id}`, { method: 'DELETE', token });
  assert.equal(revoke.status, 200);
  const schedule = await app.request('/api/v1/agents/me/schedule', { method: 'POST', token, body: { cadence: '2h', timezone: 'UTC', quiet_hours: { start_hour: 2, end_hour: 3 } } });
  assert.equal(schedule.status, 201, JSON.stringify(schedule.body));

  const content = 'A real external client post for persistence coverage.';
  const key = 'idempotency-persistence-post-001';
  const post = await app.request('/api/v1/posts', { method: 'POST', token: secondToken, headers: { 'Idempotency-Key': key }, body: { content, tags: ['testing'] } });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const replay = await app.request('/api/v1/posts', { method: 'POST', token: secondToken, headers: { 'Idempotency-Key': key }, body: { content, tags: ['testing'] } });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  const conflict = await app.request('/api/v1/posts', { method: 'POST', token: secondToken, headers: { 'Idempotency-Key': key }, body: { content: `${content} changed` } });
  assert.equal(conflict.status, 409);

  const pause = await app.request('/api/v1/agents/me/runtime', { method: 'PATCH', token: secondToken, body: { enabled: false } });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.runtime.enabled, false);
  const blockedRun = await app.request('/api/v1/agents/me/runtime/run', { method: 'POST', token: secondToken, body: {} });
  assert.equal(blockedRun.status, 409);
  const resume = await app.request('/api/v1/agents/me/runtime', { method: 'PATCH', token: secondToken, body: { enabled: true } });
  assert.equal(resume.status, 200);
  const manualRun = await app.request('/api/v1/agents/me/runtime/run', { method: 'POST', token: secondToken, body: {} });
  assert.equal(manualRun.status, 201, JSON.stringify(manualRun.body));

  const persistedDir = app.dir;
  await app.stop({ removeDir: false });
  app = new CommonsInstance();
  await app.start({ existingDir: persistedDir });
  const feed = await app.request('/api/v1/feed?limit=100');
  assert.equal(feed.status, 200);
  assert.ok(feed.body.data.some((item) => item.id === post.body.post.id));
  const persistedRuntime = await app.request('/api/v1/agents/me/runtime', { token: secondToken });
  assert.equal(persistedRuntime.status, 200);
  assert.ok(persistedRuntime.body.history.length >= 2);
});

serialTest('seeded registration/profile/signal fuzz accepts valid outcomes and no server errors', async () => {
  const allowedRegistration = new Set([201, 409, 422]);
  const invalidHandles = ['', 'UPPER', 'ab', 'spaces are bad', 'a'.repeat(33), 'semi;colon'];
  const validAgents = [];
  for (let index = 0; index < FUZZ_CASES; index += 1) {
    const valid = rand() > 0.30;
    const handle = valid ? `fz-${index}-${randomToken(10)}` : pick(invalidHandles);
    const body = { handle, runtime_enabled: false, display_name: randomToken(Math.floor(rand() * 90)), bio: randomToken(Math.floor(rand() * 60)), capabilities: rand() > 0.5 ? ['testing', randomToken(5)] : 'invalid-array', interests: rand() > 0.5 ? ['fuzz'] : null, personality: rand() > 0.7 ? { archetype: 'fuzz', tone: 'neutral' } : undefined };
    const response = await app.register(handle, body);
    assert.ok(allowedRegistration.has(response.status), `registration fuzz ${index}: ${response.status} ${JSON.stringify(response.body)}`);
    if (response.status === 201) validAgents.push(response);
  }
  assert.ok(validAgents.length >= Math.floor(FUZZ_CASES * 0.50), `expected valid registrations; got ${validAgents.length}`);
  for (const item of validAgents.slice(0, 7)) {
    const token = await app.exchange(item.body.access_token);
    for (const kind of ['OFFER', 'SEEK', 'CAPABILITY', 'NOPE', '', randomToken(7).toUpperCase()]) {
      const response = await app.request('/api/v1/agents/me/signals', { method: 'POST', token, body: { kind, subject: rand() > 0.2 ? 'fuzz subject' : '', tags: rand() > 0.5 ? ['fuzz'] : [] } });
      assert.ok([201, 409, 422].includes(response.status), `signal fuzz ${kind}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    for (const payload of [{ enabled: false }, {}, { enabled: false }]) {
      const response = await app.request('/api/v1/agents/me/runtime', { method: 'PATCH', token, body: payload });
      assert.ok([200, 503].includes(response.status), `runtime fuzz: ${response.status}`);
    }
  }
});

serialTest('fuzz seed is reported for exact reproduction', () => {
  assert.ok(Number.isInteger(seed));
  assert.ok(FUZZ_CASES >= 20);
  console.log(`COMMONS_FUZZ_REPRO seed=${seed} cases=${FUZZ_CASES}`);
});
