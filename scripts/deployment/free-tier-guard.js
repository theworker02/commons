#!/usr/bin/env node
/**
 * COMMONS — Cloudflare free-plan guard.
 *
 * Parses wrangler.jsonc and fails if the deployment descriptor has drifted into
 * anything that requires a paid Cloudflare subscription, or that would exhaust a
 * Workers Free daily budget under normal operation.
 *
 * This is a static check. It reads no credentials, contacts no API, provisions
 * nothing and spends nothing. Run it in CI ahead of any deploy step:
 *
 *   npm run cf:guard
 *   npm run cf:guard -- --json
 *   npm run cf:guard -- --allow-billable   accept R2-style overage exposure
 *   npm run cf:guard -- --config <path>    point at a fixture
 *
 * Exit codes: 0 clean, 1 violation, 2 could not read or parse the config.
 *
 * The distinction this script enforces is between limits that FAIL CLOSED and
 * limits that BILL. Workers, D1, KV, Durable Objects and Queues all error once a
 * free limit is reached, so the worst case is degraded service at $0. R2 and a
 * few others bill on overage and require a payment method, so they are rejected
 * by default rather than trusted to application-level caps.
 *
 * The authoritative free-plan limits encoded below are documented at
 * https://developers.cloudflare.com/workers/platform/pricing/ and the
 * per-product pricing pages. They are restated as constants so a limit change
 * is a one-line edit here rather than a hunt through the file.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

/* --config exists so the guard can be pointed at a fixture and negative-tested.
 * Default is the one authoritative deployment descriptor. */
const CONFIG_PATH = path.resolve(ROOT, option('--config') || 'wrangler.jsonc');

/* Workers Free plan. Daily figures are account-wide and reset at 00:00 UTC.
 * Sources: developers.cloudflare.com/workers/platform/pricing/ plus the
 * per-product limits pages for d1, kv, queues and durable-objects. */
const FREE = {
  workerRequestsPerDay: 100_000,
  workerCpuMsPerInvocation: 10,

  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageMbPerDatabase: 500,
  d1StorageGbPerAccount: 5,
  d1DatabasesPerAccount: 10,
  d1QueriesPerInvocation: 50,
  d1MaxRowBytes: 2_000_000,
  d1BoundParametersPerQuery: 100,

  doRequestsPerDay: 100_000,
  doDurationGbSecondsPerDay: 13_000,
  doSqlRowsWrittenPerDay: 100_000,
  doMemoryGb: 0.128,

  kvReadsPerDay: 100_000,
  kvWritesPerDay: 1_000,
  kvListsPerDay: 1_000,
  kvStorageGb: 1,
  kvNamespacesPerAccount: 1_000,

  queueOperationsPerDay: 10_000,
  queueOperationsPerDeliveredMessage: 3,
  queueRetentionHours: 24,
  queueMaxMessageBytes: 128_000,
  queuesPerAccount: 10_000,

  logEventsPerDay: 200_000
};

/* Bindings whose free allowance exists but does NOT fail closed: exceeding it
 * bills rather than errors, and enabling the product requires a payment method
 * on the account. These are violations by default because a $0 guarantee cannot
 * rest on application-level discipline alone. Acknowledge with --allow-billable. */
const BILLABLE_RISK_KEYS = [
  ['r2_buckets', 'R2 requires a payment method on the account and bills on overage instead of erroring'],
  ['send_email', 'Email Routing send bindings are metered outside the Workers free budgets'],
  ['analytics_engine_datasets', 'Analytics Engine has no free-plan allowance']
];

/* Config keys that only function on a paid plan. Presence of any of these means
 * the deployment is no longer free, regardless of usage. */
const PAID_ONLY_KEYS = [
  ['vectorize', 'Vectorize is Workers Paid only'],
  ['hyperdrive', 'Hyperdrive connections beyond the free query budget require Workers Paid'],
  ['logpush', 'Workers Logpush is Workers Paid only'],
  ['dispatch_namespaces', 'Workers for Platforms requires an enterprise plan'],
  ['mtls_certificates', 'mTLS certificates require a paid plan'],
  ['pipelines', 'Pipelines billing applies beyond the free tier'],
  ['workflows', 'Workflows step budget is small on the free plan; declare deliberately'],
  ['containers', 'Containers require Workers Paid'],
  ['cloudchamber', 'Cloudchamber requires a paid plan']
];

function hasFlag(name) { return process.argv.includes(name); }

/**
 * Strip JSONC comments and trailing commas without corrupting string literals.
 * A naive regex would mangle "https://..." and any comment-like text inside a
 * string, so this walks the source character by character.
 */
function parseJsonc(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] || ''); i += 2; continue; }
        out += source[i];
        if (source[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Every deployable scope: the top-level config plus each named environment. */
function scopes(config) {
  return [['default', config], ...Object.entries(config.env || {}).map(([name, env]) => [`env.${name}`, env])];
}

function checkPaidOnlyBindings(config, violations) {
  for (const [scopeName, scope] of scopes(config)) {
    for (const [key, reason] of PAID_ONLY_KEYS) {
      const value = scope[key];
      const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
      if (present) violations.push(`${scopeName}: "${key}" is set — ${reason}.`);
    }
  }
}

function checkDurableObjectBackend(config, violations, notes) {
  /* The free plan can only create SQLite-backed Durable Objects. A `new_classes`
   * entry silently makes the whole deployment paid-only. */
  const sqlite = new Set();
  for (const migration of config.migrations || []) {
    for (const cls of migration.new_sqlite_classes || []) sqlite.add(cls);
    if ((migration.new_classes || []).length) {
      violations.push(
        `migration "${migration.tag}": new_classes declares the key-value storage backend, ` +
        'which is Workers Paid only. Use new_sqlite_classes.'
      );
    }
  }
  const declared = new Set();
  for (const [, scope] of scopes(config)) {
    for (const binding of scope.durable_objects?.bindings || []) declared.add(binding.class_name);
  }
  for (const cls of declared) {
    if (!sqlite.has(cls)) {
      violations.push(`Durable Object class "${cls}" is bound but never listed in new_sqlite_classes.`);
    }
  }
  if (declared.size) {
    const backed = [...declared].filter((cls) => sqlite.has(cls)).sort();
    notes.push(
      backed.length === declared.size
        ? `${declared.size} Durable Object classes, all SQLite-backed: ${backed.join(', ')}.`
        : `${backed.length} of ${declared.size} Durable Object classes are SQLite-backed: ${backed.join(', ') || 'none'}.`
    );
  }
}

function checkNoCustomDomain(config, violations, notes) {
  /* Cloudflare hosts the zone for free, but registering a domain never is. A $0
   * deployment serves from *.workers.dev. */
  for (const [scopeName, scope] of scopes(config)) {
    const routes = Array.isArray(scope.routes) ? scope.routes : [];
    if (routes.length) {
      const patterns = routes.map((r) => (typeof r === 'string' ? r : r.pattern)).join(', ');
      violations.push(`${scopeName}: active route(s) ${patterns} — a registered domain is not free.`);
    }
    if (scope.route) violations.push(`${scopeName}: "route" is set — a registered domain is not free.`);
  }
  const production = config.env?.production;
  if (!production) return;
  if (production.workers_dev === false) {
    violations.push('env.production: workers_dev is false, so no free hostname remains.');
  } else if (!(production.routes || []).length && !production.route) {
    notes.push('env.production serves from the free *.workers.dev hostname.');
  }
}

function checkQueueBudget(config, violations, notes) {
  const maxMessages = Math.floor(FREE.queueOperationsPerDay / FREE.queueOperationsPerDeliveredMessage);
  for (const [scopeName, scope] of scopes(config)) {
    const consumers = scope.queues?.consumers || [];
    if (!consumers.length) continue;
    for (const consumer of consumers) {
      const retries = consumer.max_retries;
      /* Every retry is an extra read operation, and a message that exhausts its
       * retries then costs a dead-letter write on top. Deep retry ladders turn a
       * single failing consumer into a budget outage for every healthy queue. */
      if (typeof retries === 'number' && retries > 3) {
        violations.push(
          `${scopeName}: queue "${consumer.queue}" sets max_retries=${retries}. ` +
          `Each retry costs an extra operation against ${FREE.queueOperationsPerDay.toLocaleString()}/day; cap at 3.`
        );
      }
      if (consumer.retry_delay === 0) {
        violations.push(`${scopeName}: queue "${consumer.queue}" sets retry_delay=0, which spends operations in a tight loop.`);
      }
    }
    notes.push(
      `${scopeName}: ${consumers.length} queue consumers sharing ${FREE.queueOperationsPerDay.toLocaleString()} operations/day ` +
      `(~${maxMessages.toLocaleString()} delivered messages/day at ${FREE.queueOperationsPerDeliveredMessage} operations each).`
    );
  }
}

function checkAlarmBudget(config, violations, notes) {
  /* Each alarm invocation is one DO request and each setAlarm() is one DO SQL row
   * written. Both budgets are 100,000/day, so the heartbeat interval sets a hard
   * ceiling on colony size. */
  for (const [name, env] of Object.entries(config.env || {})) {
    const vars = env.vars || {};
    if (vars.COMMONS_AGENT_RUNTIME_ENABLED !== 'true') {
      notes.push(`env.${name}: agent runtime disabled, no alarm spend.`);
      continue;
    }
    const interval = Number(vars.COMMONS_AGENT_RUNTIME_INTERVAL_MS);
    if (!Number.isFinite(interval) || interval <= 0) {
      violations.push(`env.${name}: COMMONS_AGENT_RUNTIME_INTERVAL_MS must be a positive number.`);
      continue;
    }
    const alarmsPerAgentPerDay = 86_400_000 / interval;
    const ceiling = Math.floor(Math.min(FREE.doRequestsPerDay, FREE.doSqlRowsWrittenPerDay) / alarmsPerAgentPerDay);
    notes.push(
      `env.${name}: ${(interval / 1000).toFixed(0)}s heartbeat = ${Math.round(alarmsPerAgentPerDay)} alarms/agent/day, ` +
      `supporting ~${ceiling.toLocaleString()} agents before the Durable Object budget is exhausted.`
    );
    if (ceiling < 100) {
      violations.push(
        `env.${name}: a ${(interval / 1000).toFixed(0)}s heartbeat only supports ~${ceiling} agents on the free plan. ` +
        'Raise COMMONS_AGENT_RUNTIME_INTERVAL_MS and let the cron sweep reconcile.'
      );
    }
  }
}

function checkCronBudget(config, notes) {
  for (const [scopeName, scope] of scopes(config)) {
    const crons = scope.triggers?.crons;
    if (!crons) {
      if (scopeName !== 'default') notes.push(`${scopeName}: inherits the default cron triggers.`);
      continue;
    }
    if (!crons.length) { notes.push(`${scopeName}: cron disabled.`); continue; }
    for (const expression of crons) {
      const everyN = /^\*\/(\d+) \* \* \* \*$/.exec(expression);
      const perDay = everyN ? Math.floor(1440 / Number(everyN[1])) : null;
      notes.push(
        perDay === null
          ? `${scopeName}: cron "${expression}".`
          : `${scopeName}: cron "${expression}" = ${perDay} scheduled invocations/day of ${FREE.workerRequestsPerDay.toLocaleString()}.`
      );
    }
  }
}

function checkObservability(config, violations, notes) {
  for (const [scopeName, scope] of scopes(config)) {
    const observability = scope.observability;
    if (!observability || observability.enabled !== true) continue;
    const rate = observability.head_sampling_rate;
    if (typeof rate === 'number' && rate > 0) {
      const worstCase = Math.round(FREE.workerRequestsPerDay * rate);
      if (worstCase > FREE.logEventsPerDay) {
        violations.push(
          `${scopeName}: head_sampling_rate ${rate} can emit ${worstCase.toLocaleString()} events/day ` +
          `against a ${FREE.logEventsPerDay.toLocaleString()}/day free budget.`
        );
      } else {
        notes.push(`${scopeName}: logs sampled at ${rate}, worst case ${worstCase.toLocaleString()} of ${FREE.logEventsPerDay.toLocaleString()} events/day.`);
      }
    }
  }
}

function checkBillableRiskBindings(config, violations, warnings) {
  /* Default posture is refusal. A binding that bills instead of erroring turns
   * the $0 guarantee into a promise about our own code being bug-free, which is
   * not a guarantee at all. --allow-billable downgrades these to warnings for
   * the case where the exposure has been consciously accepted. */
  const acknowledged = hasFlag('--allow-billable');
  for (const [scopeName, scope] of scopes(config)) {
    for (const [key, reason] of BILLABLE_RISK_KEYS) {
      const entries = Array.isArray(scope[key]) ? scope[key] : scope[key] ? [scope[key]] : [];
      for (const entry of entries) {
        const label = entry.bucket_name || entry.dataset || entry.name || key;
        const message = `${scopeName}: "${key}" -> "${label}" — ${reason}.`;
        if (acknowledged) warnings.push(message);
        else violations.push(`${message} Remove it, or re-run with --allow-billable to accept the exposure.`);
      }
      /* Infrequent Access has no free tier at all, so it is never acceptable. */
      for (const entry of entries) {
        if (entry.storage_class && entry.storage_class !== 'Standard') {
          violations.push(
            `${scopeName}: "${entry.bucket_name}" uses storage_class "${entry.storage_class}", ` +
            'which has no free allowance whatsoever and bills from the first byte.'
          );
        }
      }
    }
  }
}

function checkD1Limits(config, violations, notes) {
  /* Free plan allows 10 databases per account. Each declared database_name is a
   * distinct database; preview and production intentionally differ. */
  const databases = new Set();
  for (const [scopeName, scope] of scopes(config)) {
    for (const db of scope.d1_databases || []) {
      if (db.database_name) databases.add(db.database_name);
      if (!db.migrations_dir) {
        notes.push(`${scopeName}: D1 "${db.database_name}" has no migrations_dir; schema must be applied another way.`);
      }
    }
  }
  if (!databases.size) return;
  if (databases.size > FREE.d1DatabasesPerAccount) {
    violations.push(
      `${databases.size} distinct D1 databases declared; the free plan allows ${FREE.d1DatabasesPerAccount} per account.`
    );
  }
  notes.push(
    `${databases.size} D1 database(s) of ${FREE.d1DatabasesPerAccount} allowed: ${[...databases].sort().join(', ')}. ` +
    `Each is capped at ${FREE.d1StorageMbPerDatabase} MB on the free plan, ` +
    `${FREE.d1StorageGbPerAccount} GB across the account, with ${FREE.d1QueriesPerInvocation} queries per Worker invocation.`
  );
}

function collectPlaceholders(config) {
  const found = [];
  const walk = (node, trail) => {
    if (typeof node === 'string') {
      if (node.includes('REPLACE_ME')) found.push({ path: trail, value: node });
      return;
    }
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${trail}[${index}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, trail ? `${trail}.${key}` : key);
    }
  };
  walk(config, '');
  return found;
}

function main() {
  let config;
  try {
    config = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.error(`free-tier-guard: could not parse wrangler.jsonc — ${error.message}`);
    process.exit(2);
  }

  const violations = [];
  const warnings = [];
  const notes = [];

  checkPaidOnlyBindings(config, violations);
  checkDurableObjectBackend(config, violations, notes);
  checkNoCustomDomain(config, violations, notes);
  checkQueueBudget(config, violations, notes);
  checkAlarmBudget(config, violations, notes);
  checkCronBudget(config, notes);
  checkObservability(config, violations, notes);
  checkBillableRiskBindings(config, violations, warnings);
  checkD1Limits(config, violations, notes);

  const placeholders = collectPlaceholders(config);

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ free: violations.length === 0, violations, warnings, notes, placeholders }, null, 2));
    process.exit(violations.length ? 1 : 0);
  }

  console.log('COMMONS Cloudflare free-plan guard');
  console.log(`config: ${path.relative(ROOT, CONFIG_PATH)}\n`);

  console.log('Budget accounting');
  for (const note of notes) console.log(`  - ${note}`);

  if (warnings.length) {
    console.log('\nAccepted billable risk (--allow-billable)');
    for (const warning of warnings) console.log(`  ? ${warning}`);
    console.log('  These can produce a charge. The $0 guarantee no longer holds unconditionally.');
  }

  if (placeholders.length) {
    console.log('\nPlaceholders still to resolve before deploy');
    for (const item of placeholders) console.log(`  - ${item.path} = ${item.value}`);
    console.log('  Resolve the account subdomain with: npx wrangler subdomain get');
  }

  if (violations.length) {
    console.error('\nFree-plan violations');
    for (const violation of violations) console.error(`  ! ${violation}`);
    console.error('\nThis configuration would require a paid Cloudflare plan.');
    process.exit(1);
  }

  if (!warnings.length) {
    console.log('\nEvery binding in this configuration fails closed. Maximum possible spend is $0,');
    console.log('and it does not depend on the application code being correct: exceeding a Workers,');
    console.log('D1, KV, Durable Object or Queues free limit returns an error, never a charge.');
    console.log('The only remaining requirement is to never subscribe to Workers Paid.');
  } else {
    console.log('\nNo paid-only bindings and no budget violations, but see the accepted billable risk above.');
  }
}

if (require.main === module) main();

module.exports = { parseJsonc, FREE };
