#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MANIFEST = path.join(ROOT, 'media', 'evidence.json');
const ALLOWED_KINDS = new Set(['gif', 'screenshot', 'video']);
const ALLOWED_STATUSES = new Set(['missing', 'available']);

class EvidenceValidationError extends Error {
  constructor(errors) {
    super(`Evidence manifest validation failed:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    this.name = 'EvidenceValidationError';
    this.errors = errors;
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function parseIso(value, field, errors) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) errors.push(`${field} must be null or an ISO timestamp`);
}
function manifestPath(value) {
  const candidate = path.resolve(ROOT, value || path.relative(ROOT, DEFAULT_MANIFEST));
  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${path.sep}`)) throw new Error('Manifest path must stay inside the repository.');
  return candidate;
}
function containsSecret(value) {
  const serialized = JSON.stringify(value);
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:commons|cba_live)_[A-Za-z0-9_-]{24,}|(?:access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^\s,}]+/i.test(serialized);
}

function validateEvidenceManifest(file = DEFAULT_MANIFEST) {
  const filePath = manifestPath(file);
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new EvidenceValidationError([`cannot read JSON manifest ${path.relative(ROOT, filePath)}: ${error.message}`]);
  }
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'config', 'release.json'), 'utf8'));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) errors.push('manifest must be a JSON object');
  if (manifest?.schema_version !== 1) errors.push('schema_version must be 1');
  if (manifest?.release_version !== release.version) errors.push(`release_version must match backend/config/release.json (${release.version})`);
  if (manifest?.release_version !== packageMetadata.version) errors.push(`release_version must match package.json (${packageMetadata.version})`);
  parseIso(manifest?.generated_at, 'generated_at', errors);
  if (!Array.isArray(manifest?.items)) errors.push('items must be an array');
  if (containsSecret(manifest)) errors.push('manifest contains token, secret, or private-key material');

  const ids = new Set();
  const paths = new Set();
  const checked = [];
  for (const [index, item] of (manifest?.items || []).entries()) {
    const label = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label} must be an object`); continue; }
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(item.id || '')) errors.push(`${label}.id must be a lowercase kebab-case identifier`);
    if (ids.has(item.id)) errors.push(`${label}.id is duplicated: ${item.id}`); else ids.add(item.id);
    if (!ALLOWED_KINDS.has(item.kind)) errors.push(`${label}.kind must be gif, screenshot, or video`);
    if (!ALLOWED_STATUSES.has(item.status)) errors.push(`${label}.status must be missing or available`);
    if (typeof item.description !== 'string' || !item.description.trim()) errors.push(`${label}.description is required`);
    if (typeof item.path !== 'string' || !item.path.trim()) { errors.push(`${label}.path is required`); continue; }
    const relativePath = item.path.replace(/\\/g, '/');
    const normalized = path.posix.normalize(relativePath);
    if (path.isAbsolute(item.path) || normalized === '..' || normalized.startsWith('../') || !normalized.startsWith('media/')) errors.push(`${label}.path must be a repository-relative path under media/`);
    if (paths.has(normalized)) errors.push(`${label}.path is duplicated: ${normalized}`); else paths.add(normalized);
    const assetPath = path.resolve(ROOT, ...normalized.split('/'));
    const exists = fs.existsSync(assetPath);
    if (item.status === 'missing') {
      if (exists) errors.push(`${label} is marked missing but the asset exists: ${normalized}`);
      if (item.sha256 !== null) errors.push(`${label}.sha256 must be null while status is missing`);
      if (item.captured_at !== null) errors.push(`${label}.captured_at must be null while status is missing`);
    }
    if (item.status === 'available') {
      if (!exists || !fs.statSync(assetPath).isFile()) errors.push(`${label} is marked available but the asset is absent: ${normalized}`);
      if (!/^[a-f0-9]{64}$/i.test(item.sha256 || '')) errors.push(`${label}.sha256 must be a 64-character SHA-256 digest`);
      else if (exists && fs.statSync(assetPath).isFile() && sha256(assetPath) !== item.sha256.toLowerCase()) errors.push(`${label}.sha256 does not match ${normalized}`);
      parseIso(item.captured_at, `${label}.captured_at`, errors);
      if (!item.captured_at) errors.push(`${label}.captured_at is required when status is available`);
    }
    checked.push({ id: item.id, path: normalized, status: item.status, exists });
  }
  if (errors.length) throw new EvidenceValidationError(errors);
  return { manifest: path.relative(ROOT, filePath).replace(/\\/g, '/'), release_version: manifest.release_version, checked, available: checked.filter((item) => item.status === 'available').length, missing: checked.filter((item) => item.status === 'missing').length };
}

if (require.main === module) {
  try {
    const argumentIndex = process.argv.indexOf('--file');
    const result = validateEvidenceManifest(argumentIndex >= 0 ? process.argv[argumentIndex + 1] : DEFAULT_MANIFEST);
    console.log(`EVIDENCE_OK ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { EvidenceValidationError, validateEvidenceManifest };
