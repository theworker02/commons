'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const MEDIA_ROOT = path.join(ROOT, 'media');
const EVIDENCE_PATH = path.join(MEDIA_ROOT, 'evidence.json');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';

function normalizeBaseUrl(value = process.env.COMMONS_URL || DEFAULT_BASE_URL) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('COMMONS_URL must use http or https.');
  if (parsed.username || parsed.password) throw new Error('COMMONS_URL must not contain embedded credentials.');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function urlFor(baseUrl, pathname) {
  return new URL(pathname, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function displayUrl(baseUrl) {
  const parsed = new URL(normalizeBaseUrl(baseUrl));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function assertLocalTarget(baseUrl) {
  const parsed = new URL(normalizeBaseUrl(baseUrl));
  if (!isLocalHost(parsed.hostname) && process.env.COMMONS_MEDIA_ALLOW_REMOTE !== 'true') {
    throw new Error(`Refusing to seed a non-local Commons URL (${displayUrl(baseUrl)}). Use a local server, or set COMMONS_MEDIA_ALLOW_REMOTE=true only when remote mutation is explicitly intended.`);
  }
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const url = urlFor(baseUrl, pathname);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
      throw new Error(`${options.method || 'GET'} ${pathname} failed: ${message}`);
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${options.method || 'GET'} ${pathname} timed out after ${options.timeoutMs || 15000}ms.`);
    if (error instanceof TypeError) throw new Error(`Unable to reach ${displayUrl(baseUrl)}${pathname}. Start the Commons server first.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

function playwrightGuidance(commandName) {
  return `${commandName} requires the optional Playwright package and a Chromium browser. Install them explicitly with "npm install --save-dev playwright" and "npx playwright install chromium"; the capture script never installs dependencies automatically.`;
}

function readEvidenceManifest() {
  return JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
}

function evidenceItem(manifest, id) {
  const item = manifest.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Evidence item not found: ${id}`);
  return item;
}

function assetPath(item) {
  const relative = String(item.path || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(relative);
  if (!normalized.startsWith('media/') || normalized === 'media/' || normalized.includes('../')) throw new Error(`Evidence asset path is outside media/: ${item.path}`);
  return path.resolve(ROOT, ...normalized.split('/'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function temporaryAssetPath(targetPath) {
  const directory = path.dirname(targetPath);
  const extension = path.extname(targetPath);
  return path.join(directory, `.commons-media-${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${extension}`);
}

function replaceFile(sourcePath, targetPath) {
  fs.rmSync(targetPath, { force: true });
  fs.renameSync(sourcePath, targetPath);
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    replaceFile(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function commitEvidenceAsset({ id, temporaryPath, capturedAt = new Date().toISOString() }) {
  const manifest = readEvidenceManifest();
  const item = evidenceItem(manifest, id);
  if (!fs.existsSync(temporaryPath) || !fs.statSync(temporaryPath).isFile() || fs.statSync(temporaryPath).size === 0) throw new Error(`Generated asset is empty: ${item.path}`);
  const targetPath = assetPath(item);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const backupPath = fs.existsSync(targetPath) ? `${temporaryPath}.backup` : null;
  if (backupPath) fs.copyFileSync(targetPath, backupPath);
  try {
    replaceFile(temporaryPath, targetPath);
    const digest = sha256(targetPath);
    const nextManifest = {
      ...manifest,
      generated_at: capturedAt,
      items: manifest.items.map((candidate) => candidate.id === id ? { ...candidate, status: 'available', sha256: digest, captured_at: capturedAt } : candidate)
    };
    writeJsonAtomic(EVIDENCE_PATH, nextManifest);
    return { id, path: item.path, status: 'available', sha256: digest, captured_at: capturedAt };
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.rmSync(targetPath, { force: true });
      fs.renameSync(backupPath, targetPath);
    } else {
      fs.rmSync(targetPath, { force: true });
    }
    throw error;
  } finally {
    if (backupPath) fs.rmSync(backupPath, { force: true });
    fs.rmSync(temporaryPath, { force: true });
  }
}

async function resolveFfmpeg() {
  const command = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    await execFileAsync(command, ['-version'], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return command;
  } catch {
    return null;
  }
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { ...options, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim().split(/\r?\n/).slice(-5).join(' ');
    throw new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : '.'}`);
  }
}

function makeTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDirectory(directory) {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

function skipFixture() {
  return String(process.env.COMMONS_MEDIA_SKIP_FIXTURE || '').toLowerCase() === 'true';
}

module.exports = {
  DEFAULT_BASE_URL,
  EVIDENCE_PATH,
  MEDIA_ROOT,
  ROOT,
  assetPath,
  assertLocalTarget,
  cleanupDirectory,
  commitEvidenceAsset,
  displayUrl,
  evidenceItem,
  fetchJson,
  isLocalHost,
  loadPlaywright,
  makeTempDirectory,
  normalizeBaseUrl,
  playwrightGuidance,
  readEvidenceManifest,
  resolveFfmpeg,
  runCommand,
  sha256,
  skipFixture,
  temporaryAssetPath,
  urlFor
};
