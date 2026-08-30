/**
 * COMMONS — TableRepository: the normalized backing.
 *
 * Implements the same contract as CompatRecordRepository against real columns in
 * a real table. Callers cannot tell which one they hold, which is the whole
 * point (see repository.js).
 *
 * Driven by a declarative table descriptor rather than hand-written SQL per
 * domain, because the descriptor is what makes the column allowlist, the
 * timestamp/boolean/JSON codecs and the index-awareness checks possible in one
 * place. Domain repositories extend this class and add only the queries that are
 * genuinely domain-specific — a feed query, a tally reconstruction — instead of
 * re-implementing CRUD.
 *
 * INDEX AWARENESS
 *
 * The descriptor declares which columns are indexed. Filtering or ordering on an
 * unindexed column is logged as a warning, because on D1 that is a table scan
 * charged against the 5,000,000 rows-read/day budget. This is the same guard
 * CompatRecordRepository applies to `json_extract`, applied to normalized tables
 * so a missing index is caught in development rather than discovered when the
 * daily budget runs out.
 */

import {
  Repository,
  RepositoryError,
  fieldSpec,
  isoToMs,
  recordToRow,
  rowToRecord,
  translateError,
} from './repository.js';
import { placeholders } from './d1-client.js';

/**
 * @typedef {object} TableDescriptor
 * @property {string}   table          physical table name
 * @property {string}   collection     legacy collection name (for parity/logging)
 * @property {string[]} columns        every column, in declaration order
 * @property {string}   [idColumn]     defaults to 'id'
 * @property {string[]} [timestamps]   INTEGER ms columns exposed as ISO strings
 * @property {string[]} [booleans]     INTEGER 0/1 columns exposed as booleans
 * @property {string[]} [json]         TEXT columns holding serialized JSON
 * @property {object}   [aliases]      column -> record field renames
 * @property {string[]} [indexed]      columns backed by an index
 * @property {string}   [orderColumn]  default sort column, defaults to created_at
 */

export class TableRepository extends Repository {
  #db;
  #logger;

  constructor(descriptor, database, { logger = null } = {}) {
    super({ collection: descriptor.collection || descriptor.table, backing: 'normalized' });
    if (!descriptor.table) throw new Error('TableRepository requires a table name.');
    if (!Array.isArray(descriptor.columns) || !descriptor.columns.length) {
      throw new Error(`TableRepository(${descriptor.table}) requires an explicit columns list.`);
    }

    this.table = descriptor.table;
    this.idColumn = descriptor.idColumn || 'id';
    this.columns = descriptor.columns;
    this.orderColumn = descriptor.orderColumn || (descriptor.columns.includes('created_at') ? 'created_at' : this.idColumn);
    this.indexed = new Set(descriptor.indexed || []);
    this.spec = fieldSpec({
      timestamps: descriptor.timestamps || [],
      booleans: descriptor.booleans || [],
      json: descriptor.json || [],
      aliases: descriptor.aliases || {},
    });

    this.#db = database;
    this.#logger = logger;
  }

  get db() {
    return this.#db;
  }

  get logger() {
    return this.#logger;
  }

  /* --------------------------------------------------------------- mapping */

  toRecord(row) {
    return rowToRecord(row, this.spec);
  }

  toRow(record) {
    return recordToRow(record, this.spec, this.columns);
  }

  #assertIndexed(column, usage) {
    if (this.indexed.has(column) || column === this.idColumn) return;
    if (!this.#logger) return;
    this.#logger.warn('storage.unindexed_access', {
      table: this.table,
      column,
      usage,
      hint:
        `${this.table}.${column} is used in a ${usage} but is not declared as indexed. ` +
        'On D1 this is a table scan charged against the daily rows-read budget. Add an index in migrations/.',
    });
  }

  /**
   * Build a WHERE clause from criteria.
   *
   * Supported value forms:
   *   field: value            equality
   *   field: null             IS NULL
   *   field: [a, b]           IN (...)
   *   field: { gt, gte, lt, lte, ne, like, in, isNull }
   */
  #where(criteria = {}) {
    const clauses = [];
    const params = [];

    for (const [field, value] of Object.entries(criteria)) {
      if (value === undefined) continue;
      const column = this.spec.reverseAliases[field] || field;
      if (!this.columns.includes(column)) {
        throw new RepositoryError(`${this.table} has no column "${column}" (criteria field "${field}").`, {
          status: 500,
          code: 'unknown_column',
        });
      }
      this.#assertIndexed(column, 'filter');

      const encode = (raw) => {
        if (this.spec.timestamps.has(column)) return isoToMs(raw);
        if (this.spec.booleans.has(column)) return raw ? 1 : 0;
        return raw;
      };

      if (value === null) {
        clauses.push(`${column} IS NULL`);
        continue;
      }
      if (Array.isArray(value)) {
        if (!value.length) {
          // An empty IN list matches nothing. Emitting `1 = 0` keeps the query
          // valid instead of producing `IN ()`, which is a syntax error.
          clauses.push('1 = 0');
          continue;
        }
        clauses.push(`${column} IN (${placeholders(value.length)})`);
        params.push(...value.map(encode));
        continue;
      }
      if (typeof value === 'object') {
        const operators = {
          gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '!=', like: 'LIKE',
        };
        for (const [operator, sqlOperator] of Object.entries(operators)) {
          if (value[operator] === undefined) continue;
          clauses.push(`${column} ${sqlOperator} ?`);
          params.push(encode(value[operator]));
        }
        if (value.in !== undefined) {
          const list = value.in || [];
          if (!list.length) clauses.push('1 = 0');
          else {
            clauses.push(`${column} IN (${placeholders(list.length)})`);
            params.push(...list.map(encode));
          }
        }
        if (value.isNull === true) clauses.push(`${column} IS NULL`);
        if (value.isNull === false) clauses.push(`${column} IS NOT NULL`);
        continue;
      }
      clauses.push(`${column} = ?`);
      params.push(encode(value));
    }

    return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  #selectList() {
    return this.columns.join(', ');
  }

  /* ----------------------------------------------------------------- reads */

  async get(id) {
    if (!id) return null;
    const row = await this.#db.first(
      `SELECT ${this.#selectList()} FROM ${this.table} WHERE ${this.idColumn} = ?`,
      [id]
    );
    return this.toRecord(row);
  }

  async getMany(ids) {
    const wanted = [...new Set((ids || []).filter(Boolean))];
    if (!wanted.length) return [];
    const rows = await this.#db.chunked(wanted, (chunk) =>
      this.#db.all(
        `SELECT ${this.#selectList()} FROM ${this.table} WHERE ${this.idColumn} IN (${placeholders(chunk.length)})`,
        chunk
      )
    );
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * Same-order, same-length lookup keyed by id. The shape most callers actually
   * want when hydrating a list of references, and the reason a feed page costs
   * one query for authors instead of one per post.
   */
  async getManyMap(ids) {
    const records = await this.getMany(ids);
    return new Map(records.map((record) => [record[this.idColumn], record]));
  }

  async find(criteria = {}) {
    const { items } = await this.list(criteria, { limit: 1 });
    return items[0] ?? null;
  }

  async list(criteria = {}, { limit = 50, cursor = null, direction = 'DESC', orderBy = null } = {}) {
    const order = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const sortColumn = orderBy ? this.spec.reverseAliases[orderBy] || orderBy : this.orderColumn;
    if (!this.columns.includes(sortColumn)) {
      throw new RepositoryError(`${this.table} cannot order by unknown column "${sortColumn}".`, {
        status: 500,
        code: 'unknown_column',
      });
    }
    this.#assertIndexed(sortColumn, 'sort');

    const { sql: whereSql, params } = this.#where(criteria);
    const clauses = [whereSql];

    if (cursor) {
      const decoded = decodeCursor(cursor);
      const comparison = order === 'DESC' ? '<' : '>';
      // Tie-broken keyset pagination. Without the id tiebreak, rows sharing a
      // timestamp can be skipped or repeated across pages.
      clauses.push(`(${sortColumn} ${comparison} ? OR (${sortColumn} = ? AND ${this.idColumn} ${comparison} ?))`);
      params.push(decoded.sort, decoded.sort, decoded.id);
    }

    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
    const rows = await this.#db.all(
      `SELECT ${this.#selectList()} FROM ${this.table} WHERE ${clauses.join(' AND ')} ` +
        `ORDER BY ${sortColumn} ${order}, ${this.idColumn} ${order} LIMIT ?`,
      [...params, capped + 1]
    );

    const page = rows.slice(0, capped);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.toRecord(row)),
      cursor: rows.length > capped && last ? encodeCursor(last[sortColumn], last[this.idColumn]) : null,
    };
  }

  async count(criteria = {}) {
    const { sql, params } = this.#where(criteria);
    const row = await this.#db.first(`SELECT COUNT(*) AS total FROM ${this.table} WHERE ${sql}`, params);
    return Number(row?.total ?? 0);
  }

  /* ---------------------------------------------------------------- writes */

  /** Statement objects, so callers can compose a create into a larger batch. */
  insertStatement(record) {
    const row = this.toRow(record);
    const columns = Object.keys(row);
    if (!columns.length) throw new RepositoryError(`${this.table}.create received no known columns.`, { status: 422 });
    return {
      sql: `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`,
      params: columns.map((column) => row[column]),
    };
  }

  updateStatement(id, patch) {
    const row = this.toRow(patch);
    delete row[this.idColumn];
    const columns = Object.keys(row);
    if (!columns.length) return null;
    return {
      sql: `UPDATE ${this.table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${this.idColumn} = ?`,
      params: [...columns.map((column) => row[column]), id],
    };
  }

  async create(record) {
    const statement = this.insertStatement(record);
    try {
      await this.#db.run(statement.sql, statement.params);
    } catch (error) {
      throw translateError(error, this.collection);
    }
    return this.get(record[this.idColumn] ?? record.id);
  }

  async update(id, patch) {
    const statement = this.updateStatement(id, patch);
    if (!statement) return this.get(id);
    try {
      const result = await this.#db.run(statement.sql, statement.params);
      if (!result.changes) return null;
    } catch (error) {
      throw translateError(error, this.collection);
    }
    return this.get(id);
  }

  async replace(id, record) {
    const existing = await this.exists(id);
    if (!existing) return this.create({ ...record, [this.idColumn]: id });
    return this.update(id, record);
  }

  async remove(id) {
    const result = await this.#db.run(`DELETE FROM ${this.table} WHERE ${this.idColumn} = ?`, [id]);
    return result.changes > 0;
  }

  async exists(id) {
    const row = await this.#db.first(
      `SELECT 1 AS present FROM ${this.table} WHERE ${this.idColumn} = ?`,
      [id]
    );
    return Boolean(row);
  }

  /** Bulk insert in one batch. Used by the JSON->D1 migration. */
  async createMany(records) {
    const statements = records.map((record) => this.insertStatement(record));
    if (!statements.length) return 0;
    try {
      await this.#db.batch(statements);
    } catch (error) {
      throw translateError(error, this.collection);
    }
    return statements.length;
  }

  /**
   * Insert, ignoring a duplicate-key collision.
   *
   * This is the workhorse of at-least-once safety: a queue retry re-inserting a
   * row whose `action_id` is already present is a no-op returning false, not an
   * error and not a duplicate side effect.
   */
  async createIfAbsent(record) {
    const statement = this.insertStatement(record);
    try {
      const result = await this.#db.run(
        statement.sql.replace(/^INSERT INTO/, 'INSERT OR IGNORE INTO'),
        statement.params
      );
      return result.changes > 0;
    } catch (error) {
      throw translateError(error, this.collection);
    }
  }
}

/* ---------------------------------------------------------------- cursors */

function encodeCursor(sort, id) {
  return btoa(JSON.stringify({ s: sort ?? 0, i: id })).replace(/=+$/, '');
}

function decodeCursor(cursor) {
  try {
    const decoded = JSON.parse(atob(cursor));
    return { sort: decoded.s ?? 0, id: String(decoded.i ?? '') };
  } catch {
    throw new RepositoryError('Malformed pagination cursor.', { status: 400, code: 'invalid_cursor' });
  }
}

export { encodeCursor, decodeCursor };
