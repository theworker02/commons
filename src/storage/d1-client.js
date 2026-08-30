/**
 * COMMONS — D1 client wrapper.
 *
 * Every database call in the application goes through here. Nothing else calls
 * `env.DB.prepare()` directly, which is the rule from §6: business logic must
 * not be able to scatter raw SQL across the codebase.
 *
 * The wrapper exists for three reasons that are specific to D1 on the free plan.
 *
 * 1. THE 50-QUERY CEILING IS A HARD CAP, NOT A BUDGET.
 *    D1 allows 50 queries per Worker invocation on the free plan. Exceeding it
 *    throws from D1 itself, mid-request, with an error that says nothing about
 *    which code path was responsible. This wrapper counts queries per request
 *    and fails first, with the table and statement that tipped it over, so an
 *    N+1 introduced during development is diagnosed at the point of insertion
 *    rather than in production logs.
 *
 * 2. ROWS READ MEANS ROWS SCANNED.
 *    The 5,000,000/day read budget is consumed by rows the planner touches, not
 *    rows returned. `meta.rows_read` is therefore recorded per statement and
 *    aggregated onto the request, so an unindexed filter shows up as a scan
 *    count instead of staying invisible behind a fast response.
 *
 * 3. 100 BOUND PARAMETERS PER QUERY.
 *    `WHERE id IN (...)` is the correct way to avoid an N+1, but it breaks at
 *    101 ids. `chunked()` splits oversized lists automatically so callers can
 *    pass an arbitrary array without hand-rolling pagination every time.
 */

/** D1 free-plan limits that this module enforces or reports against. */
export const D1_LIMITS = Object.freeze({
  queriesPerInvocation: 50,
  boundParametersPerQuery: 100,
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  maxStatementBytes: 100_000,
  maxRowBytes: 2_000_000,
});

/**
 * Reserve a margin below the hard cap. A request that has already issued 46
 * queries is one loop away from failing, and failing our own check produces a
 * far better error than D1's. The reserve is also what leaves room for the
 * idempotency write and the event insert that most mutations still owe.
 */
const QUERY_SOFT_LIMIT = 44;

export class D1QueryBudgetExceeded extends Error {
  constructor(count, statement) {
    super(
      `D1 query budget exceeded: ${count} queries in one Worker invocation ` +
        `(free-plan hard cap is ${D1_LIMITS.queriesPerInvocation}, soft limit ${QUERY_SOFT_LIMIT}). ` +
        `The statement that tripped it: ${summarise(statement)}. ` +
        'This is almost always an N+1: batch it with getMany(), a join, or db.batch().'
    );
    this.name = 'D1QueryBudgetExceeded';
    this.status = 500;
    this.code = 'query_budget_exceeded';
    this.queryCount = count;
  }
}

function summarise(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Per-invocation D1 handle. Construct one per request, queue batch or alarm —
 * never module scope, because the counters are request-scoped and a
 * module-scoped instance would leak state across invocations in a reused
 * isolate.
 */
export class D1Client {
  #db;
  #logger;
  #queries = 0;
  #rowsRead = 0;
  #rowsWritten = 0;
  #slowest = null;
  #enforceBudget;

  constructor(database, { logger = null, enforceBudget = true } = {}) {
    if (!database) throw new Error('D1Client requires the DB binding. Check wrangler.jsonc d1_databases.');
    this.#db = database;
    this.#logger = logger;
    this.#enforceBudget = enforceBudget;
  }

  /** Counters for the structured request log required by §32. */
  get stats() {
    return {
      queries: this.#queries,
      rows_read: this.#rowsRead,
      rows_written: this.#rowsWritten,
      query_budget: D1_LIMITS.queriesPerInvocation,
      slowest_statement: this.#slowest,
    };
  }

  #account(statement) {
    this.#queries += 1;
    if (this.#enforceBudget && this.#queries > QUERY_SOFT_LIMIT) {
      throw new D1QueryBudgetExceeded(this.#queries, statement);
    }
  }

  #record(sql, meta) {
    if (!meta) return;
    if (typeof meta.rows_read === 'number') this.#rowsRead += meta.rows_read;
    if (typeof meta.rows_written === 'number') this.#rowsWritten += meta.rows_written;
    const duration = typeof meta.duration === 'number' ? meta.duration : 0;
    if (!this.#slowest || duration > this.#slowest.duration) {
      this.#slowest = { sql: summarise(sql), duration, rows_read: meta.rows_read ?? null };
    }
    // A statement that scanned far more than it could have returned is the
    // signature of a missing index. Surfacing it here is how index regressions
    // get noticed before they eat the daily read budget.
    if (typeof meta.rows_read === 'number' && meta.rows_read >= 1000 && this.#logger) {
      this.#logger.warn('d1.wide_scan', {
        sql: summarise(sql),
        rows_read: meta.rows_read,
        hint: 'Check that every filtered, joined and ordered column in this statement is indexed.',
      });
    }
  }

  #prepare(sql, params) {
    if (sql.length > D1_LIMITS.maxStatementBytes) {
      throw new Error(`SQL statement exceeds the D1 limit of ${D1_LIMITS.maxStatementBytes} bytes.`);
    }
    if (params.length > D1_LIMITS.boundParametersPerQuery) {
      throw new Error(
        `${params.length} bound parameters exceeds the D1 limit of ${D1_LIMITS.boundParametersPerQuery}. ` +
          'Use chunked() to split the list.'
      );
    }
    const statement = this.#db.prepare(sql);
    return params.length ? statement.bind(...params) : statement;
  }

  /** First row, or null. */
  async first(sql, params = []) {
    this.#account(sql);
    const result = await this.#prepare(sql, params).first();
    // `first()` does not expose meta, so reads are attributed conservatively.
    this.#record(sql, { rows_read: result ? 1 : 0, duration: 0 });
    return result ?? null;
  }

  /** All rows. */
  async all(sql, params = []) {
    this.#account(sql);
    const result = await this.#prepare(sql, params).all();
    this.#record(sql, result.meta);
    return result.results ?? [];
  }

  /** Write. Returns { changes, lastRowId, success }. */
  async run(sql, params = []) {
    this.#account(sql);
    const result = await this.#prepare(sql, params).run();
    this.#record(sql, result.meta);
    return {
      changes: result.meta?.changes ?? 0,
      lastRowId: result.meta?.last_row_id ?? null,
      success: result.success !== false,
    };
  }

  /**
   * Atomic multi-statement write. D1 runs a batch in a single implicit
   * transaction, which is the only transaction primitive available: there is no
   * interactive BEGIN/COMMIT across awaits. Anything that must not half-apply —
   * a post plus its tags plus its event, a vote plus the tally increment — has
   * to be expressed as one batch.
   *
   * Counts as one query against the ceiling regardless of statement count,
   * which is the other reason to prefer it.
   */
  async batch(statements) {
    const prepared = statements.filter(Boolean);
    if (!prepared.length) return [];
    this.#account(`batch(${prepared.length} statements)`);
    const results = await this.#db.batch(
      prepared.map(({ sql, params = [] }) => {
        if (params.length > D1_LIMITS.boundParametersPerQuery) {
          throw new Error(`Batched statement has ${params.length} bound parameters; the limit is ${D1_LIMITS.boundParametersPerQuery}.`);
        }
        const statement = this.#db.prepare(sql);
        return params.length ? statement.bind(...params) : statement;
      })
    );
    for (let index = 0; index < results.length; index += 1) {
      this.#record(prepared[index].sql, results[index]?.meta);
    }
    return results;
  }

  /**
   * Split an id list into chunks that fit inside the bound-parameter limit and
   * run `handler` once per chunk, concatenating results.
   *
   * `reserved` accounts for parameters the caller adds alongside the list, such
   * as a collection name or a status filter.
   */
  async chunked(values, handler, { reserved = 0 } = {}) {
    const size = D1_LIMITS.boundParametersPerQuery - reserved;
    if (size < 1) throw new Error('No room left for a bound-parameter list after reserved parameters.');
    const unique = [...new Set(values)];
    if (!unique.length) return [];
    const output = [];
    for (let index = 0; index < unique.length; index += size) {
      output.push(...(await handler(unique.slice(index, index + size))));
    }
    return output;
  }

  /** `(?, ?, ?)` placeholder list of the requested length. */
  static placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
  }

  /** Escape hatch for `db.batch()` construction outside a repository. */
  get raw() {
    return this.#db;
  }
}

export const placeholders = D1Client.placeholders;
