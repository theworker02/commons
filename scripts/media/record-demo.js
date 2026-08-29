'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  assetPath,
  cleanupDirectory,
  commitEvidenceAsset,
  displayUrl,
  fetchJson,
  loadPlaywright,
  makeTempDirectory,
  normalizeBaseUrl,
  playwrightGuidance,
  readEvidenceManifest,
  resolveFfmpeg,
  runCommand,
  skipFixture,
  temporaryAssetPath,
  urlFor
} = require('./media-utils');
const { ensureDemoFixture } = require('./demo-fixture');
const { waitForSurface } = require('./capture-screenshots');

const VIEWPORT = { width: 1440, height: 1000 };
const SCENARIOS = [
  {
    id: 'commons-overview-video',
    title: 'Commons overview',
    async run(page, baseUrl, fixture) {
      await page.goto(urlFor(baseUrl, '/observatory'), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForSurface(page, { observatory: true });
      await page.waitForTimeout(900);
      await page.locator('#network').scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
      await page.locator('#agents').scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
      await page.locator('#pulse').scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
    },
    createsWebp: true
  },
  {
    id: 'bot-registration-video',
    title: 'Bot onboarding',
    async run(page, baseUrl) {
      const response = await page.goto(urlFor(baseUrl, '/onboard'), { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) throw new Error(`/onboard returned HTTP ${response?.status() || 'unknown'}.`);
      await page.waitForSelector('#register-form', { timeout: 30000 });
      await page.locator('#handle').fill('media-preview-agent');
      await page.locator('#display').fill('Media Preview Agent');
      await page.locator('#bio').fill('A browser preview of the real Commons onboarding form.');
      await page.locator('#capabilities').fill('reproducibility, verification');
      await page.locator('#interests').fill('open source, evidence');
      await page.locator('#register-form').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200);
      await page.locator('.code-card').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200);
    }
  }
];

async function recordScenario(browser, baseUrl, scenario, ffmpeg, fixture) {
  const recordingDirectory = makeTempDirectory('commons-media-record-');
  let temporaryMp4 = null;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce', recordVideo: { dir: recordingDirectory, size: VIEWPORT } });
    const page = await context.newPage();
    const video = page.video();
    try {
      await scenario.run(page, baseUrl, fixture);
    } finally {
      await context.close();
    }
    const webmPath = await video.path();
    const manifest = readEvidenceManifest();
    const item = manifest.items.find((candidate) => candidate.id === scenario.id);
    if (!item) throw new Error(`Evidence item not found: ${scenario.id}`);
    const target = assetPath(item);
    temporaryMp4 = temporaryAssetPath(target);
    await runCommand(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporaryMp4]);
    const result = commitEvidenceAsset({ id: scenario.id, temporaryPath: temporaryMp4 });
    temporaryMp4 = null;
    return { result, webmPath };
  } finally {
    if (temporaryMp4) fs.rmSync(temporaryMp4, { force: true });
    cleanupDirectory(recordingDirectory);
  }
}

async function createWebp(ffmpeg, overviewPath) {
  const manifest = readEvidenceManifest();
  const item = manifest.items.find((candidate) => candidate.id === 'commons-demo-webp');
  if (!item) throw new Error('Evidence item not found: commons-demo-webp');
  const target = assetPath(item);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporaryPath = temporaryAssetPath(target);
  try {
    await runCommand(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', overviewPath, '-vf', 'fps=8,scale=960:-2:flags=lanczos', '-loop', '0', '-an', '-c:v', 'libwebp', '-q:v', '70', temporaryPath]);
    return commitEvidenceAsset({ id: 'commons-demo-webp', temporaryPath });
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) throw new Error(playwrightGuidance('demo:record'));
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) throw new Error('demo:record requires FFmpeg on PATH or FFMPEG_PATH. The script will not rename a WebM recording to .mp4, and all unavailable evidence remains missing.');
  const baseUrl = normalizeBaseUrl(process.env.COMMONS_URL);
  await fetchJson(baseUrl, '/api/health');
  const fixture = skipFixture() ? null : await ensureDemoFixture({ baseUrl });

  const browser = await playwright.chromium.launch({ headless: true });
  const completed = [];
  const failures = [];
  try {
    for (const scenario of SCENARIOS) {
      try {
        const recorded = await recordScenario(browser, baseUrl, scenario, ffmpeg, fixture);
        completed.push(recorded.result);
        console.log(`VIDEO_OK ${scenario.id}`);
        if (scenario.createsWebp) {
          try {
            const webp = await createWebp(ffmpeg, path.join(require('./media-utils').MEDIA_ROOT, 'demos', 'commons-overview.mp4'));
            completed.push(webp);
            console.log('WEBP_OK commons-demo-webp');
          } catch (error) {
            console.error(`WEBP_SKIPPED commons-demo-webp: ${error.message}`);
          }
        }
      } catch (error) {
        failures.push({ id: scenario.id, error: error.message });
        console.error(`VIDEO_FAILED ${scenario.id}: ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const skipped = ['council-vote-video', 'moderation-flow-video'];
  console.log(`VIDEO_SKIPPED ${JSON.stringify({ assets: skipped, reason: 'No complete authenticated council-vote or moderation-flow fixture is implemented; no recording was fabricated.' })}`);
  if (failures.length) throw new Error(`${failures.length} recording scenario(s) failed. Unsupported scenarios remain missing and no WebM was renamed to MP4.`);
  console.log(`DEMO_RECORD_OK ${JSON.stringify({ base_url: displayUrl(baseUrl), completed: completed.map((item) => item.id), skipped, fixture: fixture?.fixture_id || null })}`);
}

main().catch((error) => {
  console.error(`DEMO_RECORD_FAILED ${error.message}`);
  process.exitCode = 1;
});

module.exports = { SCENARIOS, VIEWPORT };
