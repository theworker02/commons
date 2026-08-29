const path = require('node:path');
const { URL } = require('node:url');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DATA_DIR = path.join(REPOSITORY_ROOT, '.commons');

class ConfigurationError extends Error {
  constructor(missing = [], invalid = []) {
    const lines = ['Configuration error'];
    if (missing.length) lines.push(`Missing:\n${missing.map((name) => `  - ${name}`).join('\n')}`);
    if (invalid.length) lines.push(`Invalid:\n${invalid.map(({ name, reason }) => `  - ${name}: ${reason}`).join('\n')}`);
    super(lines.join('\n\n'));
    this.name = 'ConfigurationError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function parseUrl(value, name, invalid, { httpsOnly = false } = {}) {
  if (!nonEmpty(value)) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('must use http or https');
    if (httpsOnly && parsed.protocol !== 'https:') throw new Error('must use HTTPS in production');
    return parsed;
  } catch (error) {
    invalid.push({ name, reason: error.message || 'must be a valid URL' });
    return null;
  }
}

function validateEnvironment({ env = process.env } = {}) {
  const mode = String(env.COMMONS_ENV || env.NODE_ENV || 'development').trim().toLowerCase();
  const production = mode === 'production' || mode === 'staging';
  const missing = [];
  const invalid = [];
  const requireValue = (name) => {
    if (!nonEmpty(env[name])) missing.push(name);
    return env[name];
  };

  if (!['development', 'test', 'staging', 'production'].includes(mode)) invalid.push({ name: 'COMMONS_ENV', reason: 'must be development, test, staging, or production' });
  const publicUrl = parseUrl(env.COMMONS_PUBLIC_URL, 'COMMONS_PUBLIC_URL', invalid, { httpsOnly: production });
  const corsOrigins = String(env.COMMONS_CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of corsOrigins) parseUrl(origin, 'COMMONS_CORS_ORIGINS', invalid, { httpsOnly: production });

  if (production) {
    requireValue('COMMONS_PUBLIC_URL');
    requireValue('COMMONS_DATA_DIR');
    requireValue('COMMONS_CORS_ORIGINS');
    requireValue('COMMONS_INFRASTRUCTURE_OPERATOR_TOKEN');
    if (nonEmpty(env.COMMONS_DATA_DIR) && !path.isAbsolute(env.COMMONS_DATA_DIR)) invalid.push({ name: 'COMMONS_DATA_DIR', reason: 'must be an absolute path outside the repository' });
    if (nonEmpty(env.COMMONS_INFRASTRUCTURE_OPERATOR_TOKEN) && env.COMMONS_INFRASTRUCTURE_OPERATOR_TOKEN.length < 32) invalid.push({ name: 'COMMONS_INFRASTRUCTURE_OPERATOR_TOKEN', reason: 'must contain at least 32 characters' });
  }

  const storage = String(env.COMMONS_STORAGE || 'json').trim().toLowerCase();
  const agentRuntimeEnabled = String(env.COMMONS_AGENT_RUNTIME_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const agentRuntimeIntervalMs = Number(env.COMMONS_AGENT_RUNTIME_INTERVAL_MS || 15000);
  const agentRuntimeBatchSize = Number(env.COMMONS_AGENT_RUNTIME_BATCH_SIZE || 20);
  if (!Number.isInteger(agentRuntimeIntervalMs) || agentRuntimeIntervalMs < 1000 || agentRuntimeIntervalMs > 60 * 60 * 1000) invalid.push({ name: 'COMMONS_AGENT_RUNTIME_INTERVAL_MS', reason: 'must be an integer between 1000 and 3600000 milliseconds' });
  if (!Number.isInteger(agentRuntimeBatchSize) || agentRuntimeBatchSize < 1 || agentRuntimeBatchSize > 100) invalid.push({ name: 'COMMONS_AGENT_RUNTIME_BATCH_SIZE', reason: 'must be an integer between 1 and 100' });
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push({ name: 'PORT', reason: 'must be an integer between 1 and 65535' });
  if (!['json'].includes(storage)) invalid.push({ name: 'COMMONS_STORAGE', reason: 'the reference kernel currently supports only json storage; PostgreSQL requires a separate adapter' });
  if (production && storage === 'json' && !nonEmpty(env.COMMONS_DATA_DIR)) missing.push('COMMONS_DATA_DIR');
  if (missing.length || invalid.length) throw new ConfigurationError([...new Set(missing)], invalid);

  return Object.freeze({
    mode,
    production,
    port,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    dataDir: path.resolve(env.COMMONS_DATA_DIR ? (path.isAbsolute(env.COMMONS_DATA_DIR) ? env.COMMONS_DATA_DIR : path.join(REPOSITORY_ROOT, env.COMMONS_DATA_DIR)) : DEFAULT_DATA_DIR),
    publicUrl: publicUrl ? publicUrl.toString().replace(/\/$/, '') : null,
    corsOrigins,
    storage,
    operatorControlsConfigured: nonEmpty(env.COMMONS_INFRASTRUCTURE_OPERATOR_TOKEN),
    agentRuntimeEnabled,
    agentRuntimeIntervalMs,
    agentRuntimeBatchSize
  });
}

module.exports = { ConfigurationError, validateEnvironment };
