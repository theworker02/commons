/**
 * COMMONS — the repository contract.
 *
 * ONE interface, TWO backings. This is the load-bearing idea of the hybrid
 * migration: a normalized domain and a compatibility-record-backed domain are
 * indistinguishable to their callers.
 *
 *     const post    = await repositories.posts.get(id);     // normalized tables
 *     const article = await repositories.articles.get(id);   // records table
 *
 * Nothing in the service layer, the router, the auth layer or the Durable
 * Objects may branch on which backing a domain uses. That is what makes
 * promoting a long-tail domain to normalized a storage change plus a ledger
 * update, instead of a rewrite of every call site.
 *
 * THE CONTRACT
 *
 *   get(id)                      -> record | null
 *   getMany(ids)                 -> record[]            batched, never N+1
 *   find(criteria)               -> record | null
 *   list(criteria, options)      -> { items, cursor }
 *   count(criteria)              -> number
 *   create(record)               -> record
 *   update(id, patch)            -> record | null
 *   replace(id, record)          -> record
 *   remove(id)                   -> boolean
 *   exists(id)                   -> boolean
 *
 *   collection                   the legacy collection name
 *   backing                      'normalized' | 'records'
 *
 * RECORD SHAPE AT THE BOUNDARY
 *
 * Records crossing this boundary look like the legacy JSON store, not like SQL
 * rows. Repositories are the only place that knows the difference:
 *
 *   timestamps  INTEGER ms in the database  <->  ISO 8601 strings in records
 *   booleans    INTEGER 0/1                 <->  true/false
 *   json        TEXT                        <->  parsed value
 *
 * The ISO conversion is exact. The legacy kernel wrote
 * `new Date().toISOString()`, and `new Date(ms).toISOString()` reproduces that
 * string byte for byte at millisecond precision, so ported handlers can emit
 * records unchanged and API responses stay identical to the JSON kernel's.
 */

/* ------------------------------------------------------------------ codecs */

/** INTEGER ms -> ISO string. Null and unparseable values stay null. */
export function msToIso(value) {
  if (value === null || value === undefined) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * ISO string (or Date, or ms) -> INTEGER ms.
 *
 * Returns null rather than NaN for junk, because a NaN would be silently stored
 * as NULL by SQLite and the bad input would never be noticed.
 */
export function isoToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const parsed = new Date(String(value)).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function toInt(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

export function fromInt(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

export function encodeJson(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function decodeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    // A malformed payload is a data problem, not a reason to fail the read. The
    // raw string is returned so the caller can see what is actually stored.
    return value;
  }
}

/* --------------------------------------------------------------- field spec */

/**
 * Declarative description of how a table's columns map to record fields.
 * Consumed by both backings so the codec logic exists exactly once.
 */
export function fieldSpec({
  timestamps = [],
  booleans = [],
  json = [],
  aliases = {},
  omit = [],
} = {}) {
  return {
    timestamps: new Set(timestamps),
    booleans: new Set(booleans),
    json: new Set(json),
    // column -> record field, for the handful of places where the legacy record
    // name cannot be a column name (`values_json` -> `values`, `window` etc).
    aliases,
    reverseAliases: Object.fromEntries(Object.entries(aliases).map(([column, field]) => [field, column])),
    omit: new Set(omit),
  };
}

export const EMPTY_SPEC = fieldSpec();

/** Database row -> legacy-shaped record. */
export function rowToRecord(row, spec = EMPTY_SPEC) {
  if (!row) return null;
  const record = {};
  for (const [column, value] of Object.entries(row)) {
    if (spec.omit.has(column)) continue;
    const field = spec.aliases[column] || column;
    if (spec.timestamps.has(column)) record[field] = msToIso(value);
    else if (spec.booleans.has(column)) record[field] = fromInt(value);
    else if (spec.json.has(column)) record[field] = decodeJson(value);
    else record[field] = value;
  }
  return record;
}

/**
 * Legacy-shaped record -> column map.
 *
 * `columns` is the authoritative allowlist. A field that is not a real column is
 * dropped rather than passed through to SQL, so a typo in a handler surfaces as
 * a missing value instead of a SQL error naming a column that does not exist.
 */
export function recordToRow(record, spec = EMPTY_SPEC, columns = null) {
  const row = {};
  for (const [field, value] of Object.entries(record ?? {})) {
    const column = spec.reverseAliases[field] || field;
    if (columns && !columns.includes(column)) continue;
    if (spec.omit.has(column)) continue;
    if (spec.timestamps.has(column)) row[column] = isoToMs(value);
    else if (spec.booleans.has(column)) row[column] = toInt(value);
    else if (spec.json.has(column)) row[column] = encodeJson(value);
    else row[column] = value === undefined ? null : value;
  }
  return row;
}

/* ------------------------------------------------------------------- errors */

export class RepositoryError extends Error {
  constructor(message, { status = 500, code = 'storage_error', cause } = {}) {
    super(message);
    this.name = 'RepositoryError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class UniqueViolation extends RepositoryError {
  constructor(collection, detail, cause) {
    super(`Uniqueness constraint violated on ${collection}: ${detail}`, {
      status: 409,
      code: 'conflict',
      cause,
    });
    this.name = 'UniqueViolation';
    this.collection = collection;
  }
}

/**
 * D1 surfaces constraint failures as opaque messages. Recognising them centrally
 * is what lets the deduplication strategy work: a queue retry that races a
 * unique index gets a clean 409 that the consumer can treat as "already done"
 * rather than an unhandled 500 that trips a retry loop.
 */
export function translateError(error, collection) {
  const message = String(error?.message || error);
  if (/UNIQUE constraint failed|constraint failed: UNIQUE/i.test(message)) {
    return new UniqueViolation(collection, message, error);
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new RepositoryError(`Referenced record does not exist (${collection}): ${message}`, {
      status: 422,
      code: 'unresolved_reference',
      cause: error,
    });
  }
  if (/CHECK constraint failed/i.test(message)) {
    return new RepositoryError(`Record violates a schema invariant (${collection}): ${message}`, {
      status: 422,
      code: 'invariant_violation',
      cause: error,
    });
  }
  return error;
}

/** True when the error means "this row already exists", i.e. a safe retry. */
export function isDuplicate(error) {
  return error instanceof UniqueViolation;
}

/* --------------------------------------------------------------- base class */

/**
 * Abstract base. Exists to make the contract explicit and to fail loudly if a
 * backing forgets a method, rather than throwing `undefined is not a function`
 * deep inside a handler.
 */
export class Repository {
  constructor({ collection, backing }) {
    if (!collection) throw new Error('Repository requires a collection name.');
    this.collection = collection;
    this.backing = backing;
  }

  /* eslint-disable class-methods-use-this */
  #unimplemented(method) {
    throw new RepositoryError(`${this.constructor.name} does not implement ${method}().`, {
      code: 'not_implemented',
    });
  }

  async get() { this.#unimplemented('get'); }
  async getMany() { this.#unimplemented('getMany'); }
  async find() { this.#unimplemented('find'); }
  async list() { this.#unimplemented('list'); }
  async count() { this.#unimplemented('count'); }
  async create() { this.#unimplemented('create'); }
  async update() { this.#unimplemented('update'); }
  async replace() { this.#unimplemented('replace'); }
  async remove() { this.#unimplemented('remove'); }

  async exists(id) {
    return (await this.get(id)) !== null;
  }
}

/** The method names every backing must provide. Asserted by the storage tests. */
export const REPOSITORY_CONTRACT = Object.freeze([
  'get',
  'getMany',
  'find',
  'list',
  'count',
  'create',
  'update',
  'replace',
  'remove',
  'exists',
]);
