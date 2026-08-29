'use strict';

const fs = require('node:fs');
const {
  assetPath,
  cleanupDirectory,
  commitEvidenceAsset,
  displayUrl,
  fetchJson,
  loadPlaywright,
  normalizeBaseUrl,
  playwrightGuidance,
  readEvidenceManifest,
  skipFixture,
  temporaryAssetPath,
  urlFor
} = require('./media-utils');
const { ensureDemoFixture } = require('./demo-fixture');

const DESKTOP_VIEWPORT = { width: 1440, height: 1000 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const CAPTURES = [
  { id: 'home-screenshot', path: '/home', viewport: 'desktop' },
  { id: 'discover-screenshot', path: '/discover', viewport: 'desktop' },
  { id: 'work-screenshot', path: '/work', viewport: 'desktop' },
  { id: 'research-screenshot', path: '/research', viewport: 'desktop' },
  { id: 'projects-screenshot', path: '/projects', viewport: 'desktop' },
  { id: 'repositories-screenshot', path: '/repositories', viewport: 'desktop' },
  { id: 'governance-screenshot', path: '/governance', viewport: 'desktop' },
  { id: 'moderation-screenshot', path: '/moderation', viewport: 'desktop' },
  { id: 'observatory-screenshot', path: '/observatory', viewport: 'desktop', observatory: true },
  { id: 'agent-profile-screenshot', pathFor: (fixture) => `/@${fixture.builder.handle}`, viewport: 'desktop', profile: true },
  { id: 'mobile-home-screenshot', path: '/home', viewport: 'mobile' },
  { id: 'mobile-observatory-screenshot', path: '/observatory', viewport: 'mobile', observatory: true }
];

function viewportFor(kind) {
  return kind === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
}

async function waitForFonts(page) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
}

async function waitForSurface(page, capture) {
  if (capture.observatory) {
    await page.waitForFunction(() => {
      const metric = document.querySelector('#metric-agents')?.textContent?.trim();
      const feed = document.querySelector('#feed');
      return Boolean(metric && metric !== '—' && feed && !feed.querySelector('.loading'));
    }, { timeout: 30000 });
  } else if (capture.profile) {
    await page.waitForFunction(() => {
      const total = document.querySelector('#total')?.textContent?.trim();
      return Boolean(total && total !== '—' && document.querySelector('#profile')?.textContent?.trim());
    }, { timeout: 30000 });
  } else {
    await page.waitForSelector('#app[aria-busy="false"]', { timeout: 30000 });
  }
  await waitForFonts(page);
}

async function captureOne(page, baseUrl, capture, fixture) {
  const pathname = capture.pathFor ? capture.pathFor(fixture) : capture.path;
  const response = await page.goto(urlFor(baseUrl, pathname), { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!response || response.status() >= 400) throw new Error(`${pathname} returned HTTP ${response?.status() || 'unknown'}.`);
  await waitForSurface(page, capture);
  const manifest = readEvidenceManifest();
  const item = manifest.items.find((candidate) => candidate.id === capture.id);
  if (!item) throw new Error(`Evidence item not found: ${capture.id}`);
  const target = assetPath(item);
  fs.mkdirSync(require('node:path').dirname(target), { recursive: true });
  const temporaryPath = temporaryAssetPath(target);
  try {
    await page.screenshot({ path: temporaryPath, fullPage: true });
    return commitEvidenceAsset({ id: capture.id, temporaryPath });
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) throw new Error(playwrightGuidance('media:screenshots'));
  const baseUrl = normalizeBaseUrl(process.env.COMMONS_URL);
  await fetchJson(baseUrl, '/api/health');
  const fixture = skipFixture() ? null : await ensureDemoFixture({ baseUrl });
  if (!fixture && !process.env.COMMONS_MEDIA_HANDLE) throw new Error('COMMONS_MEDIA_SKIP_FIXTURE=true requires COMMONS_MEDIA_HANDLE for the profile capture.');
  if (fixture) process.env.COMMONS_MEDIA_HANDLE = fixture.builder.handle;
  const effectiveFixture = fixture || { builder: { handle: process.env.COMMONS_MEDIA_HANDLE } };

  const browser = await playwright.chromium.launch({ headless: true });
  const completed = [];
  const failures = [];
  try {
    for (const viewportKind of ['desktop', 'mobile']) {
      const context = await browser.newContext({ viewport: viewportFor(viewportKind), deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' });
      const page = await context.newPage();
      try {
        for (const capture of CAPTURES.filter((candidate) => candidate.viewport === viewportKind)) {
          try {
            const result = await captureOne(page, baseUrl, capture, effectiveFixture);
            completed.push(result);
            console.log(`SCREENSHOT_OK ${capture.id} ${capture.pathFor ? capture.pathFor(effectiveFixture) : capture.path}`);
          } catch (error) {
            failures.push({ id: capture.id, error: error.message });
            console.error(`SCREENSHOT_FAILED ${capture.id}: ${error.message}`);
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length) throw new Error(`${failures.length} screenshot capture(s) failed. Existing evidence was not replaced when a capture failed.`);
  console.log(`MEDIA_SCREENSHOTS_OK ${JSON.stringify({ base_url: displayUrl(baseUrl), count: completed.length, fixture: fixture?.fixture_id || null })}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`MEDIA_SCREENSHOTS_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CAPTURES, DESKTOP_VIEWPORT, MOBILE_VIEWPORT, waitForSurface };
