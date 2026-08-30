#!/usr/bin/env node
/**
 * COMMONS Phase VIII — D1 migration validator.
 *
 * Applies every file in migrations/ in order to a throwaway in-memory SQLite
 * database and reports the resulting schema. This is the CI gate required by
 * §33 ("validate D1 migrations") and it runs with no Cloudflare account, no
 * credentials, no network and no cost.
 *
 * It uses node:sqlite, which is the same SQLite engine family D1 is built on, so
 * a syntax error, a bad constraint, a reference to a table that does not exist
 * yet, or a migration applied out of order all fail here rather than halfway
 * through a real database.
 *
 * What it checks
 *   1. every migration applies cleanly, in filename order
 *   2. the order is total and gap-free (0001, 0002, ... with no duplicates)
 *   3. each migration records itself in schema_migrations, and the recorded
 *      version matches its filename
 *   4. foreign keys resolve — every REFERENCES target exists
 *   5. every table declared by a normalized domain in the parity ledger is
 *      actually created, so the ledger cannot claim a table that does not exist
 *   6. no index is defined twice, and every table has a primary key
 *
 * Usage:
 *   node scripts/cloudflare/validate-migrations.mjs
 *   node scripts/cloudflare/validate-migrations.mjs --json
 *   node scripts/cloudflare/validate-migrations.mjs --out artifacts/schema.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    'MIGRATION_VALIDATION_UNAVAILABLE node:sqlite is not available in this Node build. ' +
      'Node 22.5+ is required. Falling back is not possible without adding a dependency, ' +
      'so run this on a newer Node or use `wrangler d1 migrations apply --local`.'
  );
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const LEDGER_PATH = path.join(ROOT, 'config', 'cloudflare-parity.json');

const jsonOutput = process.argv.includes('--json');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;

const problems = [];
const fail = (message) => problems.push(message);

/* ------------------------------------------------------------ load migrations */

if (!fs.existsSync(MIGRATIONS_DIR)) {
  console.error(`MIGRATION_VALIDATION_FAILED migrations/ not found at ${MIGRATIONS_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (!files.length) {
  console.error('MIGRATION_VALIDATION_FAILED migrations/ contains no .sql files');
  process.exit(1);
}

// Filenames must be NNNN_name.sql, and the numbers must form a gap-free sequence
// starting at 1. Out-of-order or duplicated numbers make "applied once, in
// order" unverifiable.
const parsed = files.map((name) => {
  const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(name);
  if (!match) fail(`migration filename is not NNNN_snake_case.sql: ${name}`);
  return { name, version: match ? Number(match[1]) : null, slug: match ? match[2] : null };
});

const versions = parsed.map((entry) => entry.version).filter((value) => value !== null);
for (let index = 0; index < versions.length; index += 1) {
  if (versions[index] !== index + 1) {
    fail(
      `migration versions must be gap-free starting at 0001; expected ${String(index + 1).padStart(4, '0')} ` +
        `at position ${index} but found ${String(versions[index]).padStart(4, '0')}`
    );
    break;
  }
}

/* ----------------------------------------------------------------- apply them */

const database = new DatabaseSync(':memory:');
// Match D1: foreign keys enforced, so a REFERENCES pointing at a table created
// in a LATER migration fails here instead of in production.
database.exec('PRAGMA foreign_keys = ON;');

const applied = [];
for (const entry of parsed) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, entry.name), 'utf8');
  try {
    database.exec(sql);
    applied.push(entry);
  } catch (error) {
    fail(`${entry.name} failed to apply: ${error.message}`);
    // Stop at the first failure: everything after it would report noise.
    break;
  }
}

/* -------------------------------------------------------------- inspect schema */

const query = (sql) => database.prepare(sql).all();

const tables = query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).map((row) => row.name);

const indexes = query(
  "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
);

// Every table needs a primary key. A table without one cannot be updated or
// deduplicated safely, and on D1 it also cannot be efficiently pruned.
for (const table of tables) {
  const columns = query(`PRAGMA table_info(${table})`);
  if (!columns.some((column) => column.pk)) fail(`table "${table}" has no primary key`);
}

// Foreign keys must resolve. PRAGMA foreign_key_check reports violations of
// declared constraints; with empty tables it validates that the targets exist.
for (const table of tables) {
  const keys = query(`PRAGMA foreign_key_list(${table})`);
  for (const key of keys) {
    if (!tables.includes(key.table)) {
      fail(`table "${table}" has a foreign key to "${key.table}", which no migration creates`);
    }
  }
}

const duplicateIndexes = indexes
  .map((index) => index.name)
  .filter((name, position, all) => all.indexOf(name) !== position);
for (const name of new Set(duplicateIndexes)) fail(`index "${name}" is defined more than once`);

/* --------------------------------------------- schema_migrations bookkeeping */

let recorded = [];
if (tables.includes('schema_migrations')) {
  recorded = query('SELECT version, name FROM schema_migrations ORDER BY version');
  for (const entry of applied) {
    const match = recorded.find((row) => row.version === entry.version);
    if (!match) {
      fail(`${entry.name} applied but did not insert a schema_migrations row for version ${entry.version}`);
    } else if (match.name !== entry.name.replace(/\.sql$/, '')) {
      fail(
        `schema_migrations version ${entry.version} records name "${match.name}" ` +
          `but the file is "${entry.name}"`
      );
    }
  }
} else if (applied.length) {
  fail('schema_migrations table was never created');
}

/* ------------------------------------------- cross-check the parity ledger */

let ledgerCheck = { checked: false };
if (fs.existsSync(LEDGER_PATH)) {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const declared = new Map();
  for (const domain of ledger.domains || []) {
    if (domain.status !== 'normalized') continue;
    for (const table of Array.isArray(domain.storage) ? domain.storage : []) {
      if (!declared.has(table)) declared.set(table, []);
      declared.get(table).push(domain.domain);
    }
  }
  const missing = [...declared.keys()].filter((table) => !tables.includes(table)).sort();
  for (const table of missing) {
    fail(
      `parity ledger claims table "${table}" for normalized domain(s) ` +
        `${declared.get(table).join(', ')}, but no migration creates it`
    );
  }
  // The compat table must exist as long as any domain is compat-record-backed.
  const compatDomains = (ledger.domains || []).filter((domain) => domain.status === 'compat-record-backed');
  if (compatDomains.length && !tables.includes('records')) {
    fail(`${compatDomains.length} domains are compat-record-backed but the "records" table does not exist`);
  }
  ledgerCheck = {
    checked: true,
    declared_tables: declared.size,
    missing_tables: missing,
    compat_domains: compatDomains.length,
  };
}

/* ---------------------------------------------------------------------- report */

const report = {
  command: 'db:validate',
  migrations: parsed.length,
  applied: applied.length,
  tables: tables.length,
  indexes: indexes.length,
  schema_migrations_rows: recorded.length,
  ledger: ledgerCheck,
  table_names: tables,
  problems,
  ok: problems.length === 0,
};

if (outPath) {
  const resolved = path.resolve(ROOT, outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

database.close();

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('COMMONS D1 migration validation');
  console.log(`  migrations applied : ${applied.length}/${parsed.length}`);
  console.log(`  tables created     : ${tables.length}`);
  console.log(`  indexes created    : ${indexes.length}`);
  console.log(`  schema_migrations  : ${recorded.length} rows`);
  if (ledgerCheck.checked) {
    console.log(
      `  parity ledger      : ${ledgerCheck.declared_tables} normalized tables declared, ` +
        `${ledgerCheck.missing_tables.length} missing`
    );
  }
  if (problems.length) {
    console.error('\nProblems');
    for (const problem of problems) console.error(`  ! ${problem}`);
  } else {
    console.log('\nEvery migration applies cleanly, in order, with resolvable foreign keys.');
  }
}

process.exit(problems.length ? 1 : 0);
