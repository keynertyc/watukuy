import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import type { SerializedError } from '../../core/errors.ts';
import { ConfigError, LeaseLostError, StoreError, WatukuyError } from '../../core/errors.ts';
import type { WatukuyEvent } from '../../core/event.ts';
import type {
  CommitBatch,
  ItemRow,
  Lease,
  LoggedEvent,
  OutboxRow,
  OutboxStatus,
  ParkedError,
  ParkedRow,
  PKey,
  PollerState,
  StateStore,
  StoreCapabilities,
  Validator,
} from '../../core/store-types.ts';
import { emptyPollerState } from '../memory/memory-store.ts';
import {
  assertSqlIdentifierPrefix,
  DEFAULT_TABLE_PREFIX,
  SQLITE_TABLES,
  type SqliteTable,
  sqliteMigrations,
} from './schema.ts';

/** Options for {@link SqliteStore}. */
export interface SqliteStoreOptions {
  /**
   * Database file path, or `':memory:'` for a private in-process database that disappears on
   * `close()`. The file and its parent tables are created on first use.
   */
  path: string;
  /** Prefix applied to every table name. @default 'watukuy_' */
  tablePrefix?: string | undefined;
  /**
   * Milliseconds a statement waits for a lock held by another connection (another process on
   * the same file) before failing with `StoreError`. @default 5000
   */
  busyTimeoutMs?: number | undefined;
}

type Row = Record<string, SQLOutputValue>;
/** Partial poller state accepted by `saveState` / `commitPoll`. */
type StatePatch = Partial<Omit<PollerState, 'createdAt'>>;
type SqlText = ReturnType<typeof buildSql>;

/** Max bound parameters per `IN (...)` list; well under SQLite's 32k limit. */
const IN_CHUNK = 500;

function num(v: SQLOutputValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new StoreError(`SqliteStore: expected an integer column, got ${typeof v}`);
}

function numOrNull(v: SQLOutputValue | undefined): number | null {
  return v === null || v === undefined ? null : num(v);
}

function str(v: SQLOutputValue | undefined): string {
  if (typeof v === 'string') return v;
  throw new StoreError(`SqliteStore: expected a text column, got ${typeof v}`);
}

function strOrNull(v: SQLOutputValue | undefined): string | null {
  return v === null || v === undefined ? null : str(v);
}

function parseJson<T>(v: SQLOutputValue | undefined): T {
  return JSON.parse(str(v)) as T;
}

function parseJsonOrNull<T>(v: SQLOutputValue | undefined): T | null {
  return v === null || v === undefined ? null : parseJson<T>(v);
}

/** `undefined` becomes SQL NULL; every other value (including `null`) becomes JSON text, so absence round-trips. */
function encodeOptionalJson(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

/** `null`/`undefined` become SQL NULL; every other value becomes JSON text. */
function encodeNullableJson(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

function asStatus(v: string): OutboxStatus {
  if (v === 'pending' || v === 'delivered') return v;
  throw new StoreError(`SqliteStore: unknown outbox status '${v}'`);
}

function asKind(v: string): ParkedRow['kind'] {
  if (v === 'poison' || v === 'invalid') return v;
  throw new StoreError(`SqliteStore: unknown parked kind '${v}'`);
}

function toStoreError(err: unknown): Error {
  if (err instanceof WatukuyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new StoreError(`SqliteStore: ${message}`, { cause: err });
}

function toLease(r: Row): Lease | null {
  if (r.lease_owner === null || r.lease_owner === undefined) return null;
  return {
    owner: str(r.lease_owner),
    epoch: num(r.lease_epoch),
    expiresAt: numOrNull(r.lease_expires_at) ?? 0,
  };
}

function toItem(r: Row): ItemRow {
  const item: ItemRow = {
    identity: str(r.identity),
    version: strOrNull(r.version),
    hash: str(r.hash),
    schemaVersion: num(r.schema_version),
    seenAt: num(r.seen_at),
  };
  if (r.payload !== null && r.payload !== undefined) item.payload = parseJson<unknown>(r.payload);
  return item;
}

function toOutbox(r: Row): OutboxRow {
  return {
    eventId: str(r.event_id),
    sequence: num(r.seq),
    event: parseJson<WatukuyEvent<unknown>>(r.event),
    status: asStatus(str(r.status)),
    attempts: num(r.attempts),
    nextAttemptAt: numOrNull(r.next_attempt_at),
    lastError: parseJsonOrNull<SerializedError>(r.last_error),
    createdAt: num(r.created_at),
  };
}

function toParked(r: Row): ParkedRow {
  return {
    id: str(r.id),
    kind: asKind(str(r.kind)),
    event: parseJsonOrNull<WatukuyEvent<unknown>>(r.event),
    item: r.item === null || r.item === undefined ? undefined : parseJson<unknown>(r.item),
    error: parseJson<ParkedError>(r.error),
    attempts: num(r.attempts),
    parkedAt: num(r.parked_at),
    holdKey: strOrNull(r.hold_key),
  };
}

function toValidator(r: Row): Validator {
  return {
    etag: strOrNull(r.etag),
    lastModified: strOrNull(r.last_modified),
    storedAt: num(r.stored_at),
  };
}

function toLogged(r: Row): LoggedEvent {
  return {
    sequence: num(r.seq),
    event: parseJson<WatukuyEvent<unknown>>(r.event),
    createdAt: num(r.created_at),
  };
}

function outboxParams(key: PKey, row: OutboxRow): SQLInputValue[] {
  return [
    key.poller,
    key.partition,
    row.sequence,
    row.eventId,
    JSON.stringify(row.event),
    row.status,
    row.attempts,
    row.nextAttemptAt,
    encodeNullableJson(row.lastError),
    row.createdAt,
  ];
}

function tableNames(prefix: string): Record<SqliteTable, string> {
  return {
    pollers: `"${prefix}pollers"`,
    items: `"${prefix}items"`,
    outbox: `"${prefix}outbox"`,
    parked: `"${prefix}parked"`,
    validators: `"${prefix}validators"`,
    log: `"${prefix}log"`,
  };
}

function buildSql(prefix: string) {
  const t = tableNames(prefix);
  const K = 'poller = ? AND "partition" = ?';
  return {
    // In an UPSERT's DO UPDATE clause unqualified columns are the existing row and `excluded.*`
    // is the row we tried to insert, so both epoch columns advance from the stored counter.
    acquire: `INSERT INTO ${t.pollers} (poller, "partition", lease_owner, lease_epoch, lease_expires_at, epoch_counter)
VALUES (?, ?, ?, 1, ?, 1)
ON CONFLICT (poller, "partition") DO UPDATE SET
  lease_owner = excluded.lease_owner,
  epoch_counter = epoch_counter + 1,
  lease_epoch = epoch_counter + 1,
  lease_expires_at = excluded.lease_expires_at
WHERE lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = excluded.lease_owner
RETURNING lease_epoch, lease_expires_at`,
    renew: `UPDATE ${t.pollers} SET lease_expires_at = ? WHERE ${K} AND lease_owner = ? AND lease_epoch = ?`,
    release: `UPDATE ${t.pollers} SET lease_owner = NULL, lease_expires_at = NULL WHERE ${K} AND lease_owner = ? AND lease_epoch = ?`,
    lease: `SELECT lease_owner, lease_epoch, lease_expires_at FROM ${t.pollers} WHERE ${K}`,
    loadState: `SELECT state FROM ${t.pollers} WHERE ${K}`,
    saveState: `INSERT INTO ${t.pollers} (poller, "partition", state) VALUES (?, ?, ?) ON CONFLICT (poller, "partition") DO UPDATE SET state = excluded.state`,
    listKeys: `SELECT poller, "partition" FROM ${t.pollers} ORDER BY poller, "partition"`,
    listKeysOf: `SELECT poller, "partition" FROM ${t.pollers} WHERE poller = ? ORDER BY "partition"`,
    deleteAll: SQLITE_TABLES.map((name) => `DELETE FROM ${t[name]} WHERE ${K}`),
    deleteItemsAll: `DELETE FROM ${t.items} WHERE ${K}`,
    upsertItem: `INSERT INTO ${t.items} (poller, "partition", identity, version, hash, schema_version, payload, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (poller, "partition", identity) DO UPDATE SET version = excluded.version, hash = excluded.hash, schema_version = excluded.schema_version, payload = excluded.payload, seen_at = excluded.seen_at`,
    deleteItem: `DELETE FROM ${t.items} WHERE ${K} AND identity = ?`,
    selectItems: `SELECT identity, version, hash, schema_version, payload, seen_at FROM ${t.items} WHERE ${K} AND identity IN (`,
    streamFirst: `SELECT identity FROM ${t.items} WHERE ${K} ORDER BY identity LIMIT ?`,
    streamNext: `SELECT identity FROM ${t.items} WHERE ${K} AND identity > ? ORDER BY identity LIMIT ?`,
    countItems: `SELECT COUNT(*) AS n FROM ${t.items} WHERE ${K}`,
    upsertOutbox: `INSERT INTO ${t.outbox} (poller, "partition", seq, event_id, event, status, attempts, next_attempt_at, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (poller, "partition", event_id) DO UPDATE SET seq = excluded.seq, event = excluded.event, status = excluded.status, attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, created_at = excluded.created_at`,
    loadPending: `SELECT event_id, seq, event, status, attempts, next_attempt_at, last_error, created_at FROM ${t.outbox} WHERE ${K} AND status = 'pending' ORDER BY seq LIMIT ?`,
    countPending: `SELECT COUNT(*) AS n FROM ${t.outbox} WHERE ${K} AND status = 'pending'`,
    deleteOutbox: `DELETE FROM ${t.outbox} WHERE ${K} AND event_id = ?`,
    recordAttempt: `UPDATE ${t.outbox} SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE ${K} AND event_id = ?`,
    upsertParked: `INSERT INTO ${t.parked} (poller, "partition", id, kind, event, item, error, attempts, parked_at, hold_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (poller, "partition", id) DO UPDATE SET kind = excluded.kind, event = excluded.event, item = excluded.item, error = excluded.error, attempts = excluded.attempts, parked_at = excluded.parked_at, hold_key = excluded.hold_key`,
    selectParked: `SELECT id, kind, event, item, error, attempts, parked_at, hold_key FROM ${t.parked} WHERE ${K}`,
    poisonParked: `SELECT event, parked_at FROM ${t.parked} WHERE ${K} AND id = ? AND kind = 'poison' AND event IS NOT NULL`,
    countParked: `SELECT COUNT(*) AS n FROM ${t.parked} WHERE ${K}`,
    deleteParked: `DELETE FROM ${t.parked} WHERE ${K} AND id = ?`,
    heldKeys: `SELECT DISTINCT hold_key FROM ${t.parked} WHERE ${K} AND hold_key IS NOT NULL`,
    getValidator: `SELECT etag, last_modified, stored_at FROM ${t.validators} WHERE ${K} AND url_hash = ?`,
    upsertValidator: `INSERT INTO ${t.validators} (poller, "partition", url_hash, etag, last_modified, stored_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (poller, "partition", url_hash) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, stored_at = excluded.stored_at`,
    upsertLog: `INSERT INTO ${t.log} (poller, "partition", seq, event, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (poller, "partition", seq) DO UPDATE SET event = excluded.event, created_at = excluded.created_at`,
    selectLog: `SELECT seq, event, created_at FROM ${t.log} WHERE ${K}`,
    pruneLog: `DELETE FROM ${t.log} WHERE ${K} AND created_at < ?`,
  };
}

/**
 * `StateStore` backed by SQLite through Node's built-in `node:sqlite` (no native add-on to
 * install). Single-writer, crash-safe, and a good default for one-process deployments; several
 * processes on the same host may share one file thanks to WAL mode and the lease protocol.
 *
 * The constructor does not touch the file system. Tables are created by `migrate()` or lazily on
 * first use; both are idempotent.
 *
 * @example
 * import { SqliteStore } from 'watukuy/store-sqlite';
 *
 * const store = new SqliteStore({ path: './watukuy.db' });
 * const engine = createWatukuy({ store, pollers: { orders } });
 */
export class SqliteStore implements StateStore {
  readonly capabilities: StoreCapabilities = { transactions: true, log: true, streaming: true };
  private readonly path: string;
  private readonly prefix: string;
  private readonly busyTimeoutMs: number;
  private readonly sql: SqlText;
  private db: DatabaseSync | null = null;
  private migrated = false;
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: SqliteStoreOptions) {
    if (typeof options.path !== 'string' || options.path.length === 0) {
      throw new ConfigError("SqliteStore requires `path`: a file path or ':memory:'");
    }
    this.path = options.path;
    this.prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
    assertSqlIdentifierPrefix(this.prefix, 'SqliteStore tablePrefix');
    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new ConfigError(
        `SqliteStore busyTimeoutMs must be a non-negative number; got ${timeout}`,
      );
    }
    this.busyTimeoutMs = Math.floor(timeout);
    this.sql = buildSql(this.prefix);
  }

  /** Create the tables and indexes when missing. Safe to call repeatedly and from several processes. */
  async migrate(): Promise<void> {
    this.run((db) => this.applyMigrations(db));
  }

  /** Close the underlying connection. The store reopens lazily if it is used again. */
  async close(): Promise<void> {
    const db = this.db;
    if (!db) return;
    this.db = null;
    this.migrated = false;
    this.statements.clear();
    try {
      db.close();
    } catch (err) {
      throw toStoreError(err);
    }
  }

  async acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null> {
    return this.run(() => {
      const row = this.stmt(this.sql.acquire).get(
        key.poller,
        key.partition,
        owner,
        now + ttlMs,
        now,
      );
      if (!row) return null;
      return { owner, epoch: num(row.lease_epoch), expiresAt: num(row.lease_expires_at) };
    });
  }

  async renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean> {
    return this.run(() => {
      const result = this.stmt(this.sql.renew).run(
        now + ttlMs,
        key.poller,
        key.partition,
        lease.owner,
        lease.epoch,
      );
      return Number(result.changes) === 1;
    });
  }

  async releaseLease(key: PKey, lease: Lease): Promise<void> {
    this.run(() => {
      this.stmt(this.sql.release).run(key.poller, key.partition, lease.owner, lease.epoch);
    });
  }

  async getLease(key: PKey): Promise<Lease | null> {
    return this.run(() => {
      const row = this.stmt(this.sql.lease).get(key.poller, key.partition);
      return row ? toLease(row) : null;
    });
  }

  async loadState(key: PKey): Promise<PollerState | null> {
    return this.run(() =>
      parseJsonOrNull<PollerState>(
        this.stmt(this.sql.loadState).get(key.poller, key.partition)?.state,
      ),
    );
  }

  async saveState(key: PKey, lease: Lease, patch: StatePatch): Promise<void> {
    this.tx(() => {
      this.fence(key, lease);
      this.writeState(key, patch);
    });
  }

  async saveStateUnfenced(key: PKey, patch: StatePatch): Promise<void> {
    this.tx(() => this.writeState(key, patch));
  }

  async listKeys(poller?: string): Promise<PKey[]> {
    return this.run(() => {
      const rows =
        poller === undefined
          ? this.stmt(this.sql.listKeys).all()
          : this.stmt(this.sql.listKeysOf).all(poller);
      return rows.map((r) => ({ poller: str(r.poller), partition: str(r.partition) }));
    });
  }

  async deleteKey(key: PKey): Promise<void> {
    this.tx(() => {
      for (const sql of this.sql.deleteAll) this.stmt(sql).run(key.poller, key.partition);
    });
  }

  async clearItems(key: PKey): Promise<void> {
    this.run(() => {
      this.stmt(this.sql.deleteItemsAll).run(key.poller, key.partition);
    });
  }

  async loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>> {
    return this.run(() => {
      const out = new Map<string, ItemRow>();
      for (let i = 0; i < identities.length; i += IN_CHUNK) {
        const chunk = identities.slice(i, i + IN_CHUNK);
        const sql = `${this.sql.selectItems}${chunk.map(() => '?').join(', ')})`;
        for (const r of this.stmt(sql).all(key.poller, key.partition, ...chunk)) {
          const item = toItem(r);
          out.set(item.identity, item);
        }
      }
      return out;
    });
  }

  async *streamIdentities(key: PKey, batchSize = 1000): AsyncIterable<string[]> {
    const size = Math.max(1, Math.floor(batchSize));
    let after: string | null = null;
    for (;;) {
      const rows = this.run(() =>
        after === null
          ? this.stmt(this.sql.streamFirst).all(key.poller, key.partition, size)
          : this.stmt(this.sql.streamNext).all(key.poller, key.partition, after, size),
      );
      if (rows.length === 0) return;
      const ids = rows.map((r) => str(r.identity));
      yield ids;
      if (ids.length < size) return;
      after = ids[ids.length - 1] ?? null;
    }
  }

  async countItems(key: PKey): Promise<number> {
    return this.run(() => num(this.stmt(this.sql.countItems).get(key.poller, key.partition)?.n));
  }

  async commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void> {
    this.tx(() => {
      this.fence(key, lease);
      const { poller, partition } = key;
      const upsertItem = this.stmt(this.sql.upsertItem);
      for (const row of batch.upserts) {
        upsertItem.run(
          poller,
          partition,
          row.identity,
          row.version,
          row.hash,
          row.schemaVersion,
          encodeOptionalJson(row.payload),
          row.seenAt,
        );
      }
      const deleteItem = this.stmt(this.sql.deleteItem);
      for (const identity of batch.deletes) deleteItem.run(poller, partition, identity);
      const upsertOutbox = this.stmt(this.sql.upsertOutbox);
      for (const row of batch.events) upsertOutbox.run(...outboxParams(key, row));
      for (const row of batch.parked ?? []) this.writeParked(key, row);
      if (batch.log) {
        const upsertLog = this.stmt(this.sql.upsertLog);
        for (const row of batch.events) {
          upsertLog.run(poller, partition, row.sequence, JSON.stringify(row.event), row.createdAt);
        }
      }
      this.writeState(key, batch.statePatch);
    });
  }

  async loadPending(key: PKey, limit: number): Promise<OutboxRow[]> {
    return this.run(() =>
      this.stmt(this.sql.loadPending).all(key.poller, key.partition, limit).map(toOutbox),
    );
  }

  async countPending(key: PKey): Promise<number> {
    return this.run(() => num(this.stmt(this.sql.countPending).get(key.poller, key.partition)?.n));
  }

  async ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void> {
    this.tx(() => {
      this.fence(key, lease);
      const del = this.stmt(this.sql.deleteOutbox);
      for (const id of eventIds) del.run(key.poller, key.partition, id);
    });
  }

  async recordAttempt(
    key: PKey,
    lease: Lease,
    eventId: string,
    error: SerializedError,
    nextAttemptAt: number | null,
  ): Promise<void> {
    this.tx(() => {
      this.fence(key, lease);
      this.stmt(this.sql.recordAttempt).run(
        encodeNullableJson(error),
        nextAttemptAt,
        key.poller,
        key.partition,
        eventId,
      );
    });
  }

  async parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void> {
    this.tx(() => {
      this.fence(key, lease);
      this.writeParked(key, row);
      if (row.event) this.stmt(this.sql.deleteOutbox).run(key.poller, key.partition, row.event.id);
    });
  }

  async listParked(
    key: PKey,
    opts: { kind?: 'poison' | 'invalid'; limit?: number } = {},
  ): Promise<ParkedRow[]> {
    return this.run(() => {
      const params: SQLInputValue[] = [key.poller, key.partition];
      let sql = this.sql.selectParked;
      if (opts.kind !== undefined) {
        sql += ' AND kind = ?';
        params.push(opts.kind);
      }
      sql += ' ORDER BY parked_at, id';
      if (opts.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }
      return this.stmt(sql)
        .all(...params)
        .map(toParked);
    });
  }

  async countParked(key: PKey): Promise<number> {
    return this.run(() => num(this.stmt(this.sql.countParked).get(key.poller, key.partition)?.n));
  }

  async retryParked(key: PKey, ids: string[]): Promise<number> {
    return this.tx(() => {
      let moved = 0;
      for (const id of ids) {
        const row = this.stmt(this.sql.poisonParked).get(key.poller, key.partition, id);
        if (!row) continue;
        const event = parseJson<WatukuyEvent<unknown>>(row.event);
        this.stmt(this.sql.upsertOutbox).run(
          ...outboxParams(key, {
            eventId: event.id,
            sequence: event.sequence,
            event,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            createdAt: num(row.parked_at),
          }),
        );
        this.stmt(this.sql.deleteParked).run(key.poller, key.partition, id);
        moved++;
      }
      return moved;
    });
  }

  async discardParked(key: PKey, ids: string[]): Promise<number> {
    return this.tx(() => {
      let removed = 0;
      const del = this.stmt(this.sql.deleteParked);
      for (const id of ids) removed += Number(del.run(key.poller, key.partition, id).changes);
      return removed;
    });
  }

  async heldKeys(key: PKey): Promise<Set<string>> {
    return this.run(
      () =>
        new Set(
          this.stmt(this.sql.heldKeys)
            .all(key.poller, key.partition)
            .map((r) => str(r.hold_key)),
        ),
    );
  }

  async getValidator(key: PKey, urlHash: string): Promise<Validator | null> {
    return this.run(() => {
      const row = this.stmt(this.sql.getValidator).get(key.poller, key.partition, urlHash);
      return row ? toValidator(row) : null;
    });
  }

  async setValidator(
    key: PKey,
    lease: Lease,
    urlHash: string,
    validator: Validator,
  ): Promise<void> {
    this.tx(() => {
      this.fence(key, lease);
      this.stmt(this.sql.upsertValidator).run(
        key.poller,
        key.partition,
        urlHash,
        validator.etag,
        validator.lastModified,
        validator.storedAt,
      );
    });
  }

  async readLog(
    key: PKey,
    range: { afterSequence?: number; fromTime?: number; toTime?: number },
    limit: number,
  ): Promise<LoggedEvent[]> {
    return this.run(() => {
      const params: SQLInputValue[] = [key.poller, key.partition];
      let sql = this.sql.selectLog;
      if (range.afterSequence !== undefined) {
        sql += ' AND seq > ?';
        params.push(range.afterSequence);
      }
      if (range.fromTime !== undefined) {
        sql += ' AND created_at >= ?';
        params.push(range.fromTime);
      }
      if (range.toTime !== undefined) {
        sql += ' AND created_at <= ?';
        params.push(range.toTime);
      }
      sql += ' ORDER BY seq LIMIT ?';
      params.push(limit);
      return this.stmt(sql)
        .all(...params)
        .map(toLogged);
    });
  }

  async pruneLog(key: PKey, olderThan: number): Promise<number> {
    return this.run(() =>
      Number(this.stmt(this.sql.pruneLog).run(key.poller, key.partition, olderThan).changes),
    );
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    const db = new DatabaseSync(this.path);
    db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    db.exec('PRAGMA foreign_keys = ON');
    if (this.path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    this.db = db;
    return db;
  }

  private applyMigrations(db: DatabaseSync): void {
    for (const statement of sqliteMigrations(this.prefix)) db.exec(statement);
    this.migrated = true;
  }

  private ready(): DatabaseSync {
    const db = this.open();
    if (!this.migrated) this.applyMigrations(db);
    return db;
  }

  private stmt(sql: string): StatementSync {
    const db = this.ready();
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Run `fn` against the open database, wrapping driver failures in `StoreError`. */
  private run<T>(fn: (db: DatabaseSync) => T): T {
    try {
      return fn(this.ready());
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /** Run `fn` inside `BEGIN IMMEDIATE ... COMMIT`, rolling back on any throw. */
  private tx<T>(fn: (db: DatabaseSync) => T): T {
    return this.run((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn(db);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original error is what the caller needs; a failed rollback adds nothing.
        }
        throw err;
      }
    });
  }

  /** Must run inside `tx()`: throws `LeaseLostError` unless `lease` is the current holder. */
  private fence(key: PKey, lease: Lease): void {
    const row = this.stmt(this.sql.lease).get(key.poller, key.partition);
    const current = row ? toLease(row) : null;
    if (!current || current.owner !== lease.owner || current.epoch !== lease.epoch) {
      throw new LeaseLostError(key.poller, key.partition, lease.epoch);
    }
  }

  /** Top-level replace of the provided fields; `createdAt` is preserved (or seeded from `updatedAt`). */
  private writeState(key: PKey, patch: StatePatch): void {
    const row = this.stmt(this.sql.loadState).get(key.poller, key.partition);
    const base = parseJsonOrNull<PollerState>(row?.state) ?? emptyPollerState(patch.updatedAt ?? 0);
    const next: PollerState = { ...base, ...patch, createdAt: base.createdAt };
    this.stmt(this.sql.saveState).run(key.poller, key.partition, JSON.stringify(next));
  }

  private writeParked(key: PKey, row: ParkedRow): void {
    this.stmt(this.sql.upsertParked).run(
      key.poller,
      key.partition,
      row.id,
      row.kind,
      encodeNullableJson(row.event),
      encodeOptionalJson(row.item),
      JSON.stringify(row.error),
      row.attempts,
      row.parkedAt,
      row.holdKey,
    );
  }
}
