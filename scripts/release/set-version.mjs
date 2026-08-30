#!/usr/bin/env node
/**
 * COMMONS — set the release version everywhere at once.
 *
 * Ten files carry the version, and three separate validators fail if any of them
 * disagree:
 *
 *   scripts/validation/validate-repository-metadata.js  root/backend/frontend +
 *                                                       the publishable packages
 *   scripts/deployment/preflight.js                     root/backend/frontend
 *   packages/api/build.mjs                              openapi.info.version
 *
 * Bumping them by hand means ten edits and a coin flip on whether CI agrees, so
 * this does it in one step.
 *
 * Version strings are replaced by TARGETED substitution rather than
 * JSON.parse/stringify, because backend/openapi.json is a large document whose
 * formatting would otherwise be rewritten wholesale and bury a one-line version
 * change in a thousand-line diff. Each file is verified to contain exactly one
 * occurrence before anything is written.
 *
 * Usage:
 *   node scripts/release/set-version.mjs 2.4.0-alpha.1
 *   node scripts/release/set-version.mjs 2.4.0-alpha.1 --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dryRun = process.argv.includes('--dry-run');
const target = process.argv.slice(2).find((argument) => !argument.startsWith('--'));

/**
 * Files carrying the version, and the JSON path it lives at. `info.version` is
 * called out separately because OpenAPI nests it.
 */
const VERSIONED = [
  { file: 'backend/config/release.json', at: 'version', role: 'source of truth' },
  { file: 'package.json', at: 'version', role: 'workspace root' },
  { file: 'backend/package.json', at: 'version', role: 'private workspace' },
  { file: 'frontend/package.json', at: 'version', role: 'private workspace' },
  { file: 'backend/packages/config/package.json', at: 'version', role: 'private workspace' },
  { file: 'packages/mcp/package.json', at: 'version', role: 'private workspace' },
  { file: 'packages/api/package.json', at: 'version', role: 'published' },
  { file: 'packages/sdk/package.json', at: 'version', role: 'published' },
  { file: 'packages/cli/package.json', at: 'version', role: 'published' },
  { file: 'backend/openapi.json', at: 'info.version', role: 'published contract' },
  // Not a `version` field. validate-evidence.js asserts this matches both
  // release.json and package.json, so preflight fails if it is left behind —
  // which is exactly what happened the first time this script ran.
  { file: 'media/evidence.json', at: 'release_version', key: 'release_version', role: 'evidence manifest' },
];

// Accepts 1.2.3 and 1.2.3-alpha.1. Rejects a leading v, because the tag carries
// the v and the manifests must not.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!target) {
  console.error('Usage: node scripts/release/set-version.mjs <version> [--dry-run]');
  process.exit(1);
}
if (target.startsWith('v')) {
  console.error(`SET_VERSION_FAILED "${target}" must not start with "v"; manifests carry 2.4.0, the git tag carries v2.4.0.`);
  process.exit(1);
}
if (!SEMVER.test(target)) {
  console.error(`SET_VERSION_FAILED "${target}" is not a valid semantic version.`);
  process.exit(1);
}

const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/config/release.json'), 'utf8')).version;

/**
 * Each file is matched on its own key against ANY semantic version, rather than
 * against the version release.json currently holds.
 *
 * That makes the script idempotent and, more importantly, self-healing: if one
 * file was missed by an earlier run, re-running fixes it. Keying off
 * release.json's current value instead would make the script exit "unchanged"
 * while the tree was still inconsistent, which is the failure it is supposed to
 * prevent.
 */
const SEMVER_SOURCE = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';

// Validate every file BEFORE writing any of them. A partial bump leaves the tree
// in a state every validator rejects, which is worse than not starting.
const planned = [];
const problems = [];

for (const entry of VERSIONED) {
  const absolute = path.join(ROOT, entry.file);
  if (!fs.existsSync(absolute)) {
    problems.push(`${entry.file} is missing`);
    continue;
  }
  const key = entry.key || 'version';
  const pattern = new RegExp(`("${key}"\\s*:\\s*)"${SEMVER_SOURCE}"`, 'g');
  const source = fs.readFileSync(absolute, 'utf8');
  const matches = source.match(pattern);
  if (!matches) {
    problems.push(`${entry.file} contains no "${key}" field holding a semantic version`);
    continue;
  }
  if (matches.length !== 1) {
    problems.push(`${entry.file} contains ${matches.length} "${key}" version fields; expected exactly 1`);
    continue;
  }
  const found = /"(?:[^"]+)"\s*:\s*"([^"]+)"/.exec(matches[0])?.[1] ?? null;
  planned.push({
    ...entry,
    absolute,
    from: found,
    changed: found !== target,
    next: source.replace(pattern, `$1"${target}"`),
  });
}

if (problems.length) {
  console.error('SET_VERSION_FAILED');
  for (const problem of problems) console.error(`  ! ${problem}`);
  process.exit(1);
}

if (!dryRun) {
  for (const entry of planned) {
    if (entry.changed) fs.writeFileSync(entry.absolute, entry.next, 'utf8');
  }
}

const prerelease = target.includes('-');
const changed = planned.filter((entry) => entry.changed);

console.log(
  JSON.stringify(
    {
      command: 'release:version',
      status: dryRun ? 'dry-run' : changed.length ? 'written' : 'already-consistent',
      release_json_version: current,
      to: target,
      prerelease,
      files_total: planned.length,
      files_changed: changed.length,
      files: planned.map((entry) => ({
        file: entry.file,
        at: entry.at,
        role: entry.role,
        from: entry.from,
        changed: entry.changed,
      })),
      next_steps: dryRun
        ? ['re-run without --dry-run']
        : [
            'npm run api:build          regenerate the contract, which embeds the version',
            'npm run parity:ledger      the ledger records the source hash',
            'node scripts/validation/validate-repository-metadata.js',
            'npm run deploy:check',
            prerelease
              ? 'publishing a prerelease must use an npm dist-tag other than latest'
              : 'ready to tag',
          ],
    },
    null,
    2
  )
);
