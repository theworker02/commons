const SIGNAL_KINDS = Object.freeze([
  'OFFER',
  'SEEK',
  'AVAILABILITY',
  'INTEREST',
  'CAPABILITY',
  'COLLABORATION'
]);

const SIGNAL_VISIBILITIES = Object.freeze(['PUBLIC', 'PRIVATE']);

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function tags(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))].slice(0, 16);
}

function normalizeSignalInput(input = {}, now = Date.now()) {
  const kind = text(input.kind).toUpperCase();
  if (!SIGNAL_KINDS.includes(kind)) {
    throw new Error(`kind must be one of ${SIGNAL_KINDS.join(', ')}.`);
  }

  const subject = text(input.subject).slice(0, 240);
  const normalizedTags = tags(input.tags);
  if (!subject && !normalizedTags.length) throw new Error('subject or tags is required.');

  const visibility = text(input.visibility || 'PUBLIC').toUpperCase();
  if (!SIGNAL_VISIBILITIES.includes(visibility)) throw new Error('visibility must be PUBLIC or PRIVATE.');

  const confidence = input.confidence === undefined ? 1 : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1.');

  let expiresAt = null;
  if (input.expires_at) {
    const date = new Date(input.expires_at);
    if (Number.isNaN(date.getTime())) throw new Error('expires_at must be an ISO-8601 date.');
    if (date.getTime() <= now) throw new Error('expires_at must be in the future.');
    expiresAt = date.toISOString();
  }

  return {
    kind,
    subject,
    tags: normalizedTags,
    context_type: text(input.context_type).slice(0, 80),
    context_id: text(input.context_id).slice(0, 120),
    visibility,
    confidence: Math.round(confidence * 100) / 100,
    expires_at: expiresAt
  };
}

function isActiveSignal(signal, now = Date.now()) {
  if (!signal || signal.revoked_at) return false;
  return !signal.expires_at || new Date(signal.expires_at).getTime() > now;
}

function signalTerms(signal) {
  return [signal?.subject, ...(signal?.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((term) => term.length > 2);
}

function publicSignal(signal) {
  return {
    id: signal.id,
    agent_id: signal.agent_id,
    kind: signal.kind,
    subject: signal.subject,
    tags: signal.tags || [],
    context_type: signal.context_type || '',
    context_id: signal.context_id || '',
    visibility: signal.visibility,
    confidence: signal.confidence,
    expires_at: signal.expires_at,
    created_at: signal.created_at,
    updated_at: signal.updated_at
  };
}

module.exports = {
  SIGNAL_KINDS,
  SIGNAL_VISIBILITIES,
  normalizeSignalInput,
  isActiveSignal,
  signalTerms,
  publicSignal
};
