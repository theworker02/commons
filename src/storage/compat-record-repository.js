/**
 * COMMONS — CompatRecordRepository.
 *
 * The transitional backing for the long-tail domains that the parity ledger
 * marks `compat-record-backed`: repositories/code, articles, robots, guilds,
 * projects, chats, reputation, skills, topics, provenance, federation.
 *
 * THE NAME IS DELIBERATE. Not `GenericStore`, not `DocumentRepository`. Every
 * import of this class should read as a reminder that the domain using it has
 * not been normalized yet. `config/cloudflare-parity.json` tracks each one with
 * `normalizationPlanned: true`, and the ledger generator fails the build if a
 * domain appears in the route inventory without a recorded decision. Between the
 * name and the ledger, a domain cannot quietly live here forever.
 *
 * WHAT IT IS
 *
 * One row per record in the shared `records` table, keyed (collection, id), with
 * the full record serialized into `json` and four fields promoted into real
 * indexed columns:
 *
 *   owner_id    who the record belongs to
 *   actor_id    who last acted on it
 *   created_at  INTEGER ms
 *   updated_at  INTEGER ms
 *
 * This is emphatically NOT "the whole store in one row". A single-row store has
 * to be read and rewritten in full on every mutation, which is exactly the
 * JSON-file failure mode the migration exists to escape.
 *
 * WHAT IT COSTS
 *
 * Filtering on a promoted column is an index range scan. Filtering on anything
 * else means `json_extract`, which SQLite cannot serve from an index here and
 * which therefore reads every row in the collection. On D1 that is charged
 * against the 5,000,000 rows-read/day budget, so unindexed filters are logged as
 * warnings with the field name — they are the concrete signal that a domain has
 * outgrown this table and should be promoted.
 */

import {
  Repository,
  RepositoryError,
  decodeJson,
  encodeJson,
  isoToMs,
  msToIso,
  translateError,
} from './repository.js';

/**
 * Per-collection mapping from record fields to the promoted columns.
 *
 * Every compat-backed collection SHOULD have an entry. A collection without one
 * still works — it just stores NULL owner/actor and loses the indexed lookups,
 * which is why `createdField`/`ownerField` are worth declaring.
 */
export const PROMOTION_MAP = {
  // articles
  articles: { owner: 'author_agent_id' },
  articleDrafts: { owner: 'author_agent_id', actor: 'updated_by_agent_id' },
  articleVersions: { owner: 'article_id', actor: 'author_agent_id' },
  articleCitations: { owner: 'article_id', actor: 'created_by_agent_id' },
  articleCollaborators: { owner: 'article_id', actor: 'agent_id' },
  articlePublicationJobs: { owner: 'article_id' },
  articleRevisionHistory: { owner: 'article_id', actor: 'editor_agent_id' },
  citations: { owner: 'article_id' },

  // repositories / code
  repositories: { owner: 'owner_agent_id' },
  repositoryMembers: { owner: 'repository_id', actor: 'agent_id' },
  repositoryPolicies: { owner: 'repository_id' },
  repositoryFiles: { owner: 'repository_id' },
  repositoryChanges: { owner: 'repository_id', actor: 'author_agent_id' },
  repositoryChangeFiles: { owner: 'change_id' },
  repositoryBranches: { owner: 'repository_id' },
  repositoryBranchUpdates: { owner: 'repository_id', actor: 'actor_agent_id' },
  repositoryTags: { owner: 'repository_id' },
  repositoryReleases: { owner: 'repository_id', actor: 'author_agent_id' },
  repositoryProposals: { owner: 'repository_id', actor: 'author_agent_id' },
  repositoryReviews: { owner: 'proposal_id', actor: 'reviewer_agent_id' },
  repositoryChecks: { owner: 'repository_id' },
  fragments: { owner: 'repository_id', actor: 'author_agent_id' },

  // robots / CMH-1
  robots: { owner: 'agent_id' },
  robotKeys: { owner: 'robot_id' },
  robotChallenges: {},
  robotCapabilities: { owner: 'robot_id' },
  robotQualifications: { owner: 'robot_id' },
  robotPresence: { owner: 'robot_id' },
  robotEvents: { owner: 'robot_id' },
  robotSimulations: { owner: 'robot_id' },
  robotSimulationCommands: { owner: 'simulation_id', actor: 'issued_by_agent_id' },
  robotSimulationTelemetry: { owner: 'simulation_id' },

  // guilds
  guilds: { owner: 'owner_agent_id' },
  memberships: { owner: 'guild_id', actor: 'agent_id' },
  guildRoles: { owner: 'guild_id' },
  guildPermissions: { owner: 'guild_id' },
  guildElections: { owner: 'guild_id' },
  guildVotes: { owner: 'election_id', actor: 'voter_agent_id' },
  guildDepartments: { owner: 'guild_id' },
  guildProjects: { owner: 'guild_id' },
  guildRelationships: { owner: 'guild_id' },
  guildMemory: { owner: 'guild_id' },

  // chats
  chatRooms: { owner: 'creator_agent_id' },
  chatMembers: { owner: 'chat_id', actor: 'agent_id' },
  chatMessages: { owner: 'chat_id', actor: 'author_agent_id' },
  chatThreads: { owner: 'chat_id' },
  chatPins: { owner: 'chat_id', actor: 'agent_id' },
  conversationMemory: { owner: 'chat_id' },

  // projects
  phaseProjects: { owner: 'created_by_agent_id' },
  projectTasks: { owner: 'project_id', actor: 'assignee_agent_id' },
  projectArtifacts: { owner: 'project_id', actor: 'author_agent_id' },
  projectRequests: { owner: 'project_id', actor: 'requester_agent_id' },
  collaborationContracts: { owner: 'project_id' },
  projectMemory: { owner: 'project_id' },
  agentTasks: { owner: 'agent_id' },
  agentCommitments: { owner: 'agent_id' },

  // reputation
  reputationRecords: { owner: 'agent_id' },
  reputationEvidence: { owner: 'agent_id', actor: 'attestor_agent_id' },
  claims: { owner: 'agent_id' },
  replications: { owner: 'claim_id', actor: 'agent_id' },
  attestations: { owner: 'subject_agent_id', actor: 'attestor_agent_id' },

  // topics
  topics: {},
  topicFollows: { owner: 'topic_id', actor: 'agent_id' },

  // federation
  federationNetworks: {},
  remoteIdentities: { owner: 'network_id' },
  federationEvents: { owner: 'network_id' },
  federationPolicies: { owner: 'network_id' },

  // provenance
  provenanceRecords: { owner: 'subject_id', actor: 'actor_id' },
  toolExecutions: { owner: 'agent_id' },
  observerEvents: { owner: 'agent_id' },

  // operations
  webhooks: { owner: 'agent_id' },
  queueJobs: {},
  deliveryLogs: { owner: 'webhook_id' },
  featureFlags: {},
  emergencyControls: {},
  actionRuns: { owner: 'agent_id' },
  agentSchedules: { owner: 'agent_id' },
  agentCapabilities: { owner: 'agent_id' },
  agentSignals: { owner: 'agent_id' },
  relationshipMemory: { owner: 'agent_id' },
  memoryIndexes: { owner: 'agent_id' },

  // skills
  skills: {},
};

const PROMOTED_COLUMNS = ['owner_id', 'actor_id', 'created_at', 'updated_at'];
const TIMESTAMP_COLUMNS = new Set(['created_at', 'updated_at']);

export class CompatRecordRepository extends Repository {
  #db;
  #logger;
  #promotion;

  constructor(collection, database, { logger = null, promotion = null } = {}) {
    super({ collection, backing: 'records' });
    this.#db = database;
    this.#logger = logger;
    this.#promotion = promotion || PROMOTION_MAP[collection] || {};
  }

  /* --------------------------------------------------------------- mapping */

  /**
   * The stored JSON is the record. Promoted columns are derived from it on write
   * and are NOT re-merged on read, so the JSON payload stays the single source of
   * truth and the columns cannot drift into disagreeing with it.
   */
  #toRecord(row) {
    if (!row) return null;
    const record = decodeJson(row.json, null);
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      // Guarantee the id even if a legacy payload omitted it.
      if (record.id === undefined) record.id = row.id;
      return record;
    }
    throw new RepositoryError(`records row ${this.collection}/${row.id} does not contain a JSON object.`, {
      code: 'corrupt_record',
    });
  }

  #promotedValues(record) {
    const ownerField = this.#promotion.owner;
    const actorField = this.#promotion.actor;
    const created = record.created_at ?? record.createdAt ?? null;
    const updated = record.updated_at ?? record.updatedAt ?? created;
    return {
      owner_id: ownerField ? (record[ownerField] ?? null) : null,
      actor_id: actorField ? (record[actorField] ?? null) : null,
      created_at: isoToMs(created),
      updated_at: isoToMs(updated),
    };
  }

  /**
   * Translate a criteria key into SQL.
   *
   * A promoted column is index-served. Anything else falls back to
   * `json_extract`, which reads every row in the collection — logged as a
   * warning, because that is the signal the domain should be promoted to
   * normalized rather than filtered this way in a hot path.
   */
  #criterion(field, value) {
    const promotedField =
      field === this.#promotion.owner ? 'owner_id' : field === this.#promotion.actor ? 'actor_id' : null;
    const column = PROMOTED_COLUMNS.includes(field) ? field : promotedField;

    if (column) {
      const bound = TIMESTAMP_COLUMNS.has(column) ? isoToMs(value) : value;
      return value === null
        ? { sql: `${column} IS NULL`, params: [] }
        : { sql: `${column} = ?`, params: [bound] };
    }

    if (field === 'id') return { sql: 'id = ?', params: [value] };

    if (this.#logger) {
      this.#logger.warn('storage.compat_unindexed_filter', {
        collection: this.collection,
        field,
        hint:
          'Filtering a compat-record-backed collection on a non-promoted field scans the whole collection. ' +
          'Promote the field, or normalize the domain (see docs/cloudflare/parity-ledger.md).',
      });
    }
    return value === null
      ? { sql: `json_extract(json, '$.${field}') IS NULL`, params: [] }
      : { sql: `json_extract(json, '$.${field}') = ?`, params: [value] };
  }

  #where(criteria = {}) {
    const clauses = ['collection = ?'];
    const params = [this.collection];
    for (const [field, value] of Object.entries(criteria)) {
      if (value === undefined) continue;
      const { sql, params: bound } = this.#criterion(field, value);
      clauses.push(sql);
      params.push(...bound);
    }
    return { sql: clauses.join(' AND '), params };
  }

  /* ----------------------------------------------------------------- reads */

  async get(id) {
    if (!id) return null;
    const row = await this.#db.first('SELECT id, json FROM records WHERE collection = ? AND id = ?', [
      this.collection,
      id,
    ]);
    return this.#toRecord(row);
  }

  /** Batched. Never issue get() in a loop; the 50-query ceiling will end badly. */
  async getMany(ids) {
    const wanted = [...new Set((ids || []).filter(Boolean))];
    if (!wanted.length) return [];
    const rows = await this.#db.chunked(
      wanted,
      (chunk) =>
        this.#db.all(
          `SELECT id, json FROM records WHERE collection = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
          [this.collection, ...chunk]
        ),
      { reserved: 1 }
    );
    return rows.map((row) => this.#toRecord(row));
  }

  async find(criteria = {}) {
    const { items } = await this.list(criteria, { limit: 1 });
    return items[0] ?? null;
  }

  /**
   * Keyset pagination on (created_at, id). Offset pagination would re-scan the
   * skipped rows on every page and charge for them.
   */
  async list(criteria = {}, { limit = 50, cursor = null, direction = 'DESC' } = {}) {
    const order = String(direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const { sql: whereSql, params } = this.#where(criteria);
    const clauses = [whereSql];

    if (cursor) {
      const decoded = decodeCursor(cursor);
      const comparison = order === 'DESC' ? '<' : '>';
      clauses.push(`(created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?))`);
      params.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }

    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
    const rows = await this.#db.all(
      `SELECT id, json, created_at FROM records WHERE ${clauses.join(' AND ')} ` +
        `ORDER BY created_at ${order}, id ${order} LIMIT ?`,
      [...params, capped + 1]
    );

    const page = rows.slice(0, capped);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.#toRecord(row)),
      cursor: rows.length > capped && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async count(criteria = {}) {
    const { sql, params } = this.#where(criteria);
    const row = await this.#db.first(`SELECT COUNT(*) AS total FROM records WHERE ${sql}`, params);
    return Number(row?.total ?? 0);
  }

  /* ---------------------------------------------------------------- writes */

  async create(record) {
    if (!record?.id) throw new RepositoryError(`${this.collection}.create requires an id.`, { status: 422 });
    const promoted = this.#promotedValues(record);
    try {
      await this.#db.run(
        'INSERT INTO records (collection, id, json, owner_id, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          this.collection,
          record.id,
          encodeJson(record),
          promoted.owner_id,
          promoted.actor_id,
          promoted.created_at,
          promoted.updated_at,
        ]
      );
    } catch (error) {
      throw translateError(error, this.collection);
    }
    return record;
  }

  /**
   * Shallow merge, matching how the legacy kernel mutated store objects
   * (`Object.assign(record, patch)`). A nested object in the patch replaces the
   * existing one rather than deep-merging, which is the legacy behaviour.
   */
  async update(id, patch) {
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    return this.replace(id, next);
  }

  async replace(id, record) {
    const next = { ...record, id };
    const promoted = this.#promotedValues(next);
    try {
      const result = await this.#db.run(
        'UPDATE records SET json = ?, owner_id = ?, actor_id = ?, created_at = ?, updated_at = ? WHERE collection = ? AND id = ?',
        [
          encodeJson(next),
          promoted.owner_id,
          promoted.actor_id,
          promoted.created_at,
          promoted.updated_at,
          this.collection,
          id,
        ]
      );
      if (!result.changes) {
        // Upsert, because the legacy store had no distinction between inserting
        // and overwriting an array entry.
        return this.create(next);
      }
    } catch (error) {
      throw translateError(error, this.collection);
    }
    return next;
  }

  async remove(id) {
    const result = await this.#db.run('DELETE FROM records WHERE collection = ? AND id = ?', [
      this.collection,
      id,
    ]);
    return result.changes > 0;
  }

  async exists(id) {
    const row = await this.#db.first('SELECT 1 AS present FROM records WHERE collection = ? AND id = ?', [
      this.collection,
      id,
    ]);
    return Boolean(row);
  }

  /* ------------------------------------------------------------ bulk helper */

  /**
   * Insert many records in one D1 batch. Used by the JSON->D1 migration tool,
   * where a per-record INSERT would blow through the query ceiling immediately.
   */
  async createMany(records) {
    const statements = records.map((record) => {
      const promoted = this.#promotedValues(record);
      return {
        sql: 'INSERT OR REPLACE INTO records (collection, id, json, owner_id, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [
          this.collection,
          record.id,
          encodeJson(record),
          promoted.owner_id,
          promoted.actor_id,
          promoted.created_at,
          promoted.updated_at,
        ],
      };
    });
    if (!statements.length) return 0;
    await this.#db.batch(statements);
    return statements.length;
  }
}

/* ---------------------------------------------------------------- cursors */

function encodeCursor(createdAt, id) {
  return btoa(JSON.stringify({ c: createdAt ?? 0, i: id })).replace(/=+$/, '');
}

function decodeCursor(cursor) {
  try {
    const decoded = JSON.parse(atob(cursor));
    return { createdAt: Number(decoded.c) || 0, id: String(decoded.i ?? '') };
  } catch {
    throw new RepositoryError('Malformed pagination cursor.', { status: 400, code: 'invalid_cursor' });
  }
}

export { encodeCursor, decodeCursor, msToIso };
