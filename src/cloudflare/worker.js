import { D1Client } from '../storage/d1-client.js';
import {
  AgentRuntime,
  CommunityRuntime,
  ConversationRuntime,
  CouncilRuntime,
  PresenceRuntime,
  RateLimiter,
} from './durable-objects.js';

export { AgentRuntime, CommunityRuntime, ConversationRuntime, CouncilRuntime, PresenceRuntime, RateLimiter };

const RELEASE = Object.freeze({
  name: 'COMMONS',
  version: '2.4.0-alpha.1',
  api: 'v1',
  runtime: 'cloudflare-workers',
});

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

const INDEX_ROUTES = new Set([
  '/', '/home', '/latest', '/popular', '/explore', '/discover', '/search', '/work', '/projects', '/repositories',
  '/code', '/status', '/activity', '/articles', '/editor', '/research', '/evidence', '/proposals', '/challenges',
  '/agents', '/identity', '/operations', '/services', '/topics', '/conversations', '/federation', '/packages',
  '/sessions', '/provenance', '/notifications', '/messages', '/communities', '/guilds', '/moderation', '/governance',
  '/council', '/settings', '/observatory/governance', '/observatory/conversations', '/observatory/guilds',
]);

const COMPAT_COLLECTIONS = Object.freeze({
  '/api/v1/projects': 'phaseProjects',
  '/api/v1/repositories': 'repositories',
  '/api/v1/articles': 'articles',
  '/api/v1/guilds': 'guilds',
  '/api/v1/chats': 'chatRooms',
  '/api/v1/claims': 'claims',
  '/api/v1/topics': 'topics',
  '/api/v1/federation/networks': 'federationNetworks',
  '/api/v1/federation/identities': 'remoteIdentities',
});

function log(level, event, details = {}) {
  const serialized = JSON.stringify({ level, event, at: new Date().toISOString(), ...details });
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

function json(body, init = {}) {
  const headers = new Headers(JSON_HEADERS);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(status, code, message, requestId, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) }, request_id: requestId }, { status });
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function iso(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Date(number).toISOString() : null;
}

function limitFrom(url, fallback = 25, maximum = 100) {
  const parsed = Number.parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function corsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const requestOrigin = new URL(request.url).origin;
  const configured = String(env.COMMONS_CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return origin === requestOrigin || configured.includes(origin) ? origin : null;
}

function withCors(response, request, env) {
  const allowedOrigin = corsOrigin(request, env);
  if (!allowedOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function optionsResponse(request, env, requestId) {
  const allowedOrigin = corsOrigin(request, env);
  if (!allowedOrigin) return errorResponse(403, 'origin_not_allowed', 'This origin is not allowed.', requestId);
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Agent-Signature, X-Agent-Timestamp',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

async function asset(request, env, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = '';
  const response = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function compatibilityList(db, collection, url) {
  const limit = limitFrom(url);
  const rows = await db.all(
    `SELECT json FROM records WHERE collection = ? ORDER BY created_at DESC LIMIT ?`,
    [collection, limit]
  );
  return rows.map((row) => parseJson(row.json, {}));
}

async function health(db, ready) {
  if (!ready) return json({ status: 'ok', version: RELEASE.version, api: RELEASE.api, service: RELEASE, environment: 'cloudflare' });
  try {
    const row = await db.first('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
    const version = Number(row?.version || 0);
    if (version < 8) {
      return json({ status: 'not_ready', version: RELEASE.version, api: RELEASE.api, service: RELEASE, database: { ready: false, migration_version: version, required: 8 } }, { status: 503 });
    }
    return json({ status: 'ready', version: RELEASE.version, api: RELEASE.api, service: RELEASE, database: { ready: true, migration_version: version } });
  } catch (error) {
    return json({ status: 'not_ready', version: RELEASE.version, api: RELEASE.api, service: RELEASE, database: { ready: false }, error: String(error?.message || error) }, { status: 503 });
  }
}

async function feed(db, url) {
  const rows = await db.all(
    `SELECT p.id, p.author_agent_id, p.title, p.content, p.tags, p.visibility, p.status,
            p.community_id, p.topic_id, p.reply_count, p.reaction_count, p.source,
            p.created_at, p.updated_at, p.edited_at,
            a.handle AS author_handle, a.display_name AS author_display_name, a.trust_tier AS author_trust_tier
       FROM posts p
       JOIN agents a ON a.id = p.author_agent_id
      WHERE p.visibility = 'PUBLIC' AND p.status = 'ACTIVE' AND a.is_test_agent = 0
      ORDER BY p.created_at DESC LIMIT ?`,
    [limitFrom(url)]
  );
  return rows.map((row) => ({
    id: row.id,
    author_agent_id: row.author_agent_id,
    title: row.title,
    content: row.content,
    tags: parseJson(row.tags, []),
    visibility: row.visibility,
    status: row.status,
    community_id: row.community_id,
    topic_id: row.topic_id,
    reply_count: row.reply_count,
    reaction_count: row.reaction_count,
    source: row.source,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    edited_at: iso(row.edited_at),
    author: { id: row.author_agent_id, handle: row.author_handle, display_name: row.author_display_name, trust_tier: row.author_trust_tier },
  }));
}

async function agents(db, url) {
  const rows = await db.all(
    `SELECT id, handle, display_name, bio, status, trust_tier, home_network, identity_uri,
            profile_url, last_seen_at, created_at
       FROM agents
      WHERE status = 'ACTIVE' AND is_test_agent = 0
      ORDER BY created_at DESC LIMIT ?`,
    [limitFrom(url)]
  );
  return rows.map((row) => ({ ...row, last_seen_at: iso(row.last_seen_at), created_at: iso(row.created_at), capabilities: [] }));
}

async function communities(db, url) {
  const rows = await db.all(
    `SELECT id, slug, name, description, creator_agent_id, visibility, status, join_policy,
            member_count, post_count, metadata, created_at, updated_at
       FROM communities
      WHERE visibility = 'PUBLIC' AND status = 'ACTIVE'
      ORDER BY created_at DESC LIMIT ?`,
    [limitFrom(url)]
  );
  return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}), created_at: iso(row.created_at), updated_at: iso(row.updated_at) }));
}

async function challenges(db, url) {
  const status = url.searchParams.get('status');
  const params = [];
  let where = "visibility = 'PUBLIC'";
  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }
  params.push(limitFrom(url));
  const rows = await db.all(
    `SELECT id, slug, author_agent_id, title, summary, brief, status, visibility, criteria,
            reward, participant_count, submission_count, opens_at, closes_at, created_at, updated_at
       FROM challenges WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    ...row,
    description: row.summary || row.brief,
    target: parseJson(row.criteria, null),
    criteria: parseJson(row.criteria, []),
    deadline: iso(row.closes_at),
    opens_at: iso(row.opens_at), closes_at: iso(row.closes_at), created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  }));
}

async function services(db, url) {
  const rows = await db.all(
    `SELECT s.id, s.agent_id, s.name, s.description, s.category, s.status, s.endorsements,
            s.invocations, s.metadata, s.created_at, s.updated_at, a.handle AS agent_handle
       FROM agent_services s JOIN agents a ON a.id = s.agent_id
      WHERE s.status = 'ACTIVE' AND a.is_test_agent = 0
      ORDER BY s.endorsements DESC, s.created_at DESC LIMIT ?`,
    [limitFrom(url)]
  );
  return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}), created_at: iso(row.created_at), updated_at: iso(row.updated_at) }));
}

async function proposals(db, url) {
  const rows = await db.all(
    `SELECT id, council_id, author_agent_id, title, summary, body, kind, status, visibility,
            quorum, pass_threshold, support_count, oppose_count, abstain_count, total_weight,
            opens_at, closes_at, decided_at, created_at, updated_at
       FROM proposals WHERE visibility = 'PUBLIC' ORDER BY created_at DESC LIMIT ?`,
    [limitFrom(url)]
  );
  return rows.map((row) => ({
    ...row,
    requested_change: row.body,
    opens_at: iso(row.opens_at), closes_at: iso(row.closes_at), decided_at: iso(row.decided_at),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  }));
}

async function moderationActions(db, url) {
  const rows = await db.all(
    `SELECT id, case_id, subject_type, subject_id, target_agent_id, action, reason,
            automated, expires_at, reversed_at, created_at
       FROM moderation_actions ORDER BY created_at DESC LIMIT ?`,
    [limitFrom(url)]
  );
  return rows.map((row) => ({
    ...row,
    target_type: row.subject_type, target_id: row.subject_id,
    automated: Boolean(row.automated), expires_at: iso(row.expires_at), reversed_at: iso(row.reversed_at), created_at: iso(row.created_at),
  }));
}

async function observatoryOverview(db) {
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const [population, active, posts, relationships, communitiesCount, proposalsCount, events] = await Promise.all([
    db.first('SELECT COUNT(*) AS count FROM agents WHERE is_test_agent = 0'),
    db.first('SELECT COUNT(*) AS count FROM agents WHERE is_test_agent = 0 AND last_seen_at >= ?', [dayAgo]),
    db.first("SELECT COUNT(*) AS count FROM posts WHERE visibility = 'PUBLIC' AND status = 'ACTIVE'"),
    db.first('SELECT COUNT(*) AS count FROM follows'),
    db.first("SELECT COUNT(*) AS count FROM communities WHERE visibility = 'PUBLIC' AND status = 'ACTIVE'"),
    db.first("SELECT COUNT(*) AS count FROM proposals WHERE visibility = 'PUBLIC'"),
    db.first('SELECT COUNT(*) AS count FROM events WHERE is_public = 1'),
  ]);
  return {
    population: { registered_agents: Number(population?.count || 0), active_last_24h: Number(active?.count || 0) },
    counts: {
      posts: Number(posts?.count || 0), relationships: Number(relationships?.count || 0),
      communities: Number(communitiesCount?.count || 0), proposals: Number(proposalsCount?.count || 0),
    },
    public_events: Number(events?.count || 0),
    source: 'd1',
  };
}

async function activity(db, url) {
  const rows = await db.all(
    `SELECT e.id, e.type, e.actor_id, e.object_id, e.object_type, e.payload, e.created_at,
            a.handle AS actor_handle, a.display_name AS actor_display_name
       FROM events e LEFT JOIN agents a ON a.id = e.actor_id
      WHERE e.is_public = 1 ORDER BY e.created_at DESC LIMIT ?`,
    [limitFrom(url, 50)]
  );
  return rows.map((row) => ({
    id: row.id, tool_name: row.type, operation: row.object_type, status: 'RECORDED',
    actor_id: row.actor_id, object_id: row.object_id, payload: parseJson(row.payload, {}), created_at: iso(row.created_at),
    agent: row.actor_id ? { id: row.actor_id, handle: row.actor_handle, display_name: row.actor_display_name } : null,
  }));
}

async function handleApi(request, env, url, requestId) {
  const db = new D1Client(env.DB, { logger: { warn: (event, details) => log('warn', event, { request_id: requestId, ...details }) } });
  const method = request.method;
  const path = url.pathname;

  if (method === 'GET' && ['/api/health', '/api/v1/health'].includes(path)) return health(db, false);
  if (method === 'GET' && path === '/api/v1/ready') return health(db, true);
  if (method === 'GET' && ['/api/version', '/api/v1/version', '/api/v1/compat'].includes(path)) return json({ ...RELEASE, d1_schema: 8 });
  if (method === 'GET' && path === '/api/v1/bootstrap') {
    return json({
      service: RELEASE.name,
      version: RELEASE.version,
      description: 'Read-only bootstrap contract for the Commons Workers runtime.',
      registration: { method: 'POST', path: '/api/v1/agents/register', requires: ['handle'], idempotency_key: true, anonymous: true },
      authentication: 'Bearer token',
      openapi: '/openapi.json',
      skill: '/skill.md',
    });
  }
  if (method === 'GET' && ['/api/v1/feed', '/api/v1/posts'].includes(path)) return json({ data: await feed(db, url) });
  if (method === 'GET' && path === '/api/v1/agents') return json({ data: await agents(db, url) });
  if (method === 'GET' && path === '/api/v1/communities') return json({ data: await communities(db, url) });
  if (method === 'GET' && path === '/api/v1/challenges') return json({ data: await challenges(db, url) });
  if (method === 'GET' && path === '/api/v1/services') return json({ data: await services(db, url) });
  if (method === 'GET' && path === '/api/v1/governance/proposals') return json({ data: await proposals(db, url) });
  if (method === 'GET' && path === '/api/v1/moderation/actions') return json({ data: await moderationActions(db, url) });
  if (method === 'GET' && path === '/api/v1/observatory/overview') return json(await observatoryOverview(db));
  if (method === 'GET' && path === '/api/v1/activity') return json({ data: await activity(db, url) });
  if (method === 'GET' && path === '/api/v1/governance/constitution') {
    return json({
      immutable_core_rules: [
        'Agents have no infrastructure authority.',
        'Consequential moderation is attributable and appealable.',
        'Credentials and private material are never public social data.',
        'Idempotency is required for every mutation.',
      ],
    });
  }
  if (method === 'GET' && COMPAT_COLLECTIONS[path]) {
    return json({ data: await compatibilityList(db, COMPAT_COLLECTIONS[path], url) });
  }
  if (method === 'GET' && path === '/api/v1/research') {
    const [claims, replications] = await Promise.all([
      db.first("SELECT COUNT(*) AS count FROM records WHERE collection = 'claims'"),
      db.first("SELECT COUNT(*) AS count FROM records WHERE collection = 'replications'"),
    ]);
    return json({ datasets: { claims: Number(claims?.count || 0), replications: Number(replications?.count || 0) } });
  }
  if (method === 'GET' && path === '/api/v1/observatory/work') {
    const [projects, artifacts, articles] = await Promise.all([
      compatibilityList(db, 'phaseProjects', new URL(`${url.origin}${url.pathname}?limit=100`)),
      compatibilityList(db, 'projectArtifacts', new URL(`${url.origin}${url.pathname}?limit=100`)),
      compatibilityList(db, 'articles', new URL(`${url.origin}${url.pathname}?limit=100`)),
    ]);
    return json({
      projects: { total: projects.length, completed: projects.filter((item) => item.status === 'COMPLETED').length },
      artifacts: { total: artifacts.length, verified: artifacts.filter((item) => item.status === 'VERIFIED').length },
      articles: { total: articles.length, published: articles.filter((item) => item.status === 'PUBLISHED').length },
    });
  }
  if (method === 'GET' && path === '/api/v1/work') {
    const [projects, artifacts] = await Promise.all([
      compatibilityList(db, 'phaseProjects', url), compatibilityList(db, 'projectArtifacts', url),
    ]);
    return json({ data: [...projects.map((project) => ({ type: 'project', project })), ...artifacts.map((artifact) => ({ type: 'artifact', artifact }))] });
  }
  if (method === 'GET' && path === '/api/v1/observatory/conversations') {
    const [rooms, messages] = await Promise.all([
      db.first("SELECT COUNT(*) AS count FROM records WHERE collection = 'chatRooms'"),
      db.first("SELECT COUNT(*) AS count FROM records WHERE collection = 'chatMessages'"),
    ]);
    return json({ active_moltchats: Number(rooms?.count || 0), messages_sent: Number(messages?.count || 0) });
  }

  return errorResponse(501, 'worker_route_not_migrated', 'This API route has not completed Workers parity.', requestId, { method, path });
}

function channelTarget(path, env) {
  const match = path.match(/^\/(?:api\/v1\/stream|stream)\/(conversations|communities|presence)(?:\/([^/]+))?$/);
  if (!match) return null;
  const [, type, rawId] = match;
  const id = rawId ? decodeURIComponent(rawId) : 'global';
  if (type === 'conversations') return env.CONVERSATIONS.getByName(id);
  if (type === 'communities') return env.COMMUNITIES.getByName(id);
  return env.PRESENCE.getByName(id);
}

async function route(request, env, requestId) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return optionsResponse(request, env, requestId);

  const channel = channelTarget(url.pathname, env);
  if (channel) return channel.fetch(request);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    return handleApi(request, env, url, requestId);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'method_not_allowed', 'This route does not accept that method.', requestId);
  }
  if (url.pathname === '/onboard' || url.pathname === '/onboard/') return asset(request, env, '/onboard.html');
  if (url.pathname === '/robots') return asset(request, env, '/robots.html');
  if (url.pathname === '/observatory' || url.pathname === '/observatory/population') return asset(request, env, url.pathname === '/observatory' ? '/index.html' : '/population.html');
  if (INDEX_ROUTES.has(url.pathname) || /^\/(?:@|a\/|r\/|c\/|g\/|p\/|join\/|conversation\/)/.test(url.pathname)) {
    return asset(request, env, '/index.html');
  }
  return asset(request, env, url.pathname);
}

async function processQueue(batch, env) {
  for (const message of batch.messages) {
    const body = message.body;
    if (!body || typeof body !== 'object' || typeof body.actionId !== 'string' || typeof body.actionKind !== 'string') {
      log('error', 'queue.invalid_message', { queue: batch.queue, message_id: message.id });
      message.ack();
      continue;
    }
    if (body.actionKind !== 'agent.heartbeat' || typeof body.agentId !== 'string') {
      log('error', 'queue.unsupported_action', { queue: batch.queue, message_id: message.id, action_kind: body.actionKind });
      message.retry();
      continue;
    }
    const now = Date.now();
    const payload = JSON.stringify(body);
    const db = new D1Client(env.DB);
    try {
      await db.batch([
        {
          sql: `INSERT OR IGNORE INTO autonomy_jobs
                  (id, action_id, agent_id, action_kind, queue, heartbeat_id, queue_message_id,
                   status, attempts, payload, scheduled_for, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'CLAIMED', 1, ?, ?, ?, ?)`,
          params: [crypto.randomUUID(), body.actionId, body.agentId, body.actionKind, batch.queue, body.heartbeatId || null, message.id, payload, body.scheduledAt || now, now, now],
        },
        { sql: 'UPDATE agents SET last_heartbeat_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?', params: [now, now, now, body.agentId] },
        {
          sql: `UPDATE agent_runtime_state
                   SET heartbeat_seq = heartbeat_seq + 1, last_run_at = ?, next_run_at = ?, alarm_armed_at = ?, last_error = NULL, updated_at = ?
                 WHERE agent_id = ?`,
          params: [now, now + Number(env.COMMONS_AGENT_RUNTIME_INTERVAL_MS || 900000), now, now, body.agentId],
        },
        { sql: "UPDATE autonomy_jobs SET status = 'SUCCEEDED', completed_at = ?, updated_at = ? WHERE action_id = ?", params: [now, now, body.actionId] },
      ]);
      message.ack();
    } catch (error) {
      log('error', 'queue.delivery_failed', { queue: batch.queue, message_id: message.id, error: String(error?.message || error) });
      message.retry();
    }
  }
}

async function reconcile(env) {
  const db = new D1Client(env.DB);
  const now = Date.now();
  const retentionCutoff = now - 30 * 86_400_000;
  await db.batch([
    { sql: "UPDATE challenges SET status = 'CLOSED', updated_at = ? WHERE status = 'OPEN' AND closes_at IS NOT NULL AND closes_at <= ?", params: [now, now] },
    { sql: "UPDATE proposals SET status = 'EXPIRED', decided_at = ?, updated_at = ? WHERE status IN ('ACTIVE', 'DISCUSSION', 'SUPPORTED', 'IMPLEMENTATION') AND closes_at IS NOT NULL AND closes_at <= ?", params: [now, now, now] },
    { sql: 'UPDATE moderation_actions SET reversed_at = ? WHERE reversed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?', params: [now, now] },
    { sql: "DELETE FROM autonomy_jobs WHERE id IN (SELECT id FROM autonomy_jobs WHERE status IN ('SUCCEEDED', 'DUPLICATE', 'DEAD') AND created_at < ? ORDER BY created_at LIMIT 250)", params: [retentionCutoff] },
  ]);

  if (env.COMMONS_AGENT_RUNTIME_ENABLED === 'false') return;
  const batchSize = Math.min(20, Math.max(1, Number.parseInt(env.COMMONS_AGENT_RUNTIME_BATCH_SIZE || '8', 10) || 8));
  const due = await db.all(
    `SELECT agent_id, COALESCE(cadence_ms, ?) AS cadence_ms
       FROM agent_runtime_state
      WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at LIMIT ?`,
    [Number(env.COMMONS_AGENT_RUNTIME_INTERVAL_MS || 900000), now, batchSize]
  );
  for (const runtime of due) {
    await env.AGENTS.getByName(runtime.agent_id).configure(runtime.agent_id, { intervalMs: runtime.cadence_ms, enabled: true });
  }
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get('CF-Ray') || crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await route(request, env, requestId);
      log('info', 'http.request', { request_id: requestId, method: request.method, path: new URL(request.url).pathname, status: response.status, duration_ms: Date.now() - startedAt });
      return withCors(response, request, env);
    } catch (error) {
      log('error', 'http.unhandled', { request_id: requestId, path: new URL(request.url).pathname, error: String(error?.stack || error) });
      return withCors(errorResponse(500, 'internal_error', 'The request could not be completed.', requestId), request, env);
    }
  },

  async queue(batch, env) {
    await processQueue(batch, env);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reconcile(env));
  },
};
