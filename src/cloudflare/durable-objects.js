import { DurableObject } from 'cloudflare:workers';

const DEFAULT_RUNTIME_INTERVAL_MS = 15 * 60 * 1000;

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function structuredLog(level, event, details = {}) {
  const entry = JSON.stringify({ level, event, at: new Date().toISOString(), ...details });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class AgentRuntime extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runtime (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          agent_id TEXT NOT NULL,
          heartbeat_seq INTEGER NOT NULL DEFAULT 0,
          interval_ms INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );
      `);
    });
  }

  async configure(agentId, options = {}) {
    if (typeof agentId !== 'string' || !agentId.trim()) throw new TypeError('agentId is required.');
    const intervalMs = asPositiveInteger(options.intervalMs, asPositiveInteger(this.env.COMMONS_AGENT_RUNTIME_INTERVAL_MS, DEFAULT_RUNTIME_INTERVAL_MS));
    const enabled = options.enabled !== false;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime (singleton, agent_id, heartbeat_seq, interval_ms, enabled, updated_at)
       VALUES (1, ?, 0, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         agent_id = excluded.agent_id,
         interval_ms = excluded.interval_ms,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      agentId.trim(), intervalMs, enabled ? 1 : 0, now
    );
    if (enabled) await this.ctx.storage.setAlarm(now + intervalMs);
    else await this.ctx.storage.deleteAlarm();
    return this.status();
  }

  status() {
    const row = this.ctx.storage.sql.exec(
      'SELECT agent_id, heartbeat_seq, interval_ms, enabled, updated_at FROM runtime WHERE singleton = 1'
    ).toArray()[0];
    return row ?? null;
  }

  async alarm() {
    const row = this.status();
    if (!row || row.enabled !== 1 || this.env.COMMONS_AGENT_RUNTIME_ENABLED === 'false') return;

    const heartbeatSeq = Number(row.heartbeat_seq) + 1;
    const heartbeatId = `${row.agent_id}:${heartbeatSeq}`;
    const actionKind = 'agent.heartbeat';
    const actionId = await sha256(`${heartbeatId}:${actionKind}`);
    const now = Date.now();

    this.ctx.storage.sql.exec(
      'UPDATE runtime SET heartbeat_seq = ?, updated_at = ? WHERE singleton = 1',
      heartbeatSeq, now
    );
    await this.env.AUTONOMY_QUEUE.send({
      version: 1,
      actionId,
      actionKind,
      agentId: row.agent_id,
      heartbeatId,
      scheduledAt: now,
    });
    await this.ctx.storage.setAlarm(now + Number(row.interval_ms));
  }
}

class HibernatingChannel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS channel_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_channel_events_created ON channel_events(created_at);
      `);
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: { code: 'websocket_required', message: 'Upgrade to WebSocket.' } }, { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const sessionId = crypto.randomUUID();
    server.serializeAttachment({ sessionId, connectedAt: Date.now() });
    this.ctx.acceptWebSocket(server, [sessionId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  publish(payload) {
    const envelope = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      payload,
    };
    const serialized = JSON.stringify(envelope);
    this.ctx.storage.sql.exec(
      'INSERT INTO channel_events (event_id, payload, created_at) VALUES (?, ?, ?)',
      envelope.id, serialized, Date.now()
    );
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch (error) {
        structuredLog('warn', 'durable_object.websocket_send_failed', { error: String(error) });
      }
    }
    return envelope;
  }

  webSocketMessage(socket, message) {
    if (typeof message === 'string' && message === 'ping') socket.send('pong');
  }

  webSocketError(_socket, error) {
    structuredLog('warn', 'durable_object.websocket_error', { error: String(error) });
  }
}

export class ConversationRuntime extends HibernatingChannel {}
export class CommunityRuntime extends HibernatingChannel {}
export class PresenceRuntime extends HibernatingChannel {}

export class CouncilRuntime extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS serialized_votes (
          action_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          voter_id TEXT NOT NULL,
          choice TEXT NOT NULL,
          weight REAL NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_serialized_votes_voter
          ON serialized_votes(proposal_id, voter_id);
      `);
    });
  }

  recordVote(vote) {
    if (!vote || typeof vote !== 'object') throw new TypeError('vote is required.');
    const { actionId, proposalId, voterId, choice } = vote;
    const weight = Number(vote.weight ?? 1);
    if (![actionId, proposalId, voterId, choice].every((value) => typeof value === 'string' && value)) {
      throw new TypeError('actionId, proposalId, voterId, and choice are required.');
    }
    if (!['SUPPORT', 'OPPOSE', 'ABSTAIN'].includes(choice) || !Number.isFinite(weight) || weight <= 0) {
      throw new TypeError('Invalid vote choice or weight.');
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO serialized_votes (action_id, proposal_id, voter_id, choice, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      actionId, proposalId, voterId, choice, weight, Date.now()
    );
    return { actionId, proposalId, voterId, choice, weight };
  }
}

export class RateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_windows (
          key TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (key, window_start)
        );
      `);
    });
  }

  consume(key, options = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('Rate-limit key is required.');
    const limit = asPositiveInteger(options.limit, 60);
    const windowMs = asPositiveInteger(options.windowMs, 60_000);
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_windows (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
      key, windowStart
    );
    const row = this.ctx.storage.sql.exec(
      'SELECT count FROM rate_windows WHERE key = ? AND window_start = ?', key, windowStart
    ).one();
    this.ctx.storage.sql.exec('DELETE FROM rate_windows WHERE window_start < ?', windowStart - windowMs);
    return {
      allowed: Number(row.count) <= limit,
      limit,
      remaining: Math.max(0, limit - Number(row.count)),
      resetAt: windowStart + windowMs,
    };
  }
}

