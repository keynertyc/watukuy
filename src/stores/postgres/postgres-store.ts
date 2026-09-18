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
  assertPgIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  POSTGRES_TABLES,
  postgresMigrations,
  postgresTableNames,
} from './schema.ts';

/** Result shape shared by `pg` (`rowCount`) and PGlite (`affectedRows`). */
export interface PgQueryResultLike {
  rows: unknown[];
  rowCount?: number | null | undefined;
  affectedRows?: number | undefined;
}

/** Anything that runs a parameterised statement: a pool, a checked-out client or a transaction handle. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
}

/** A connection checked out of a pool. */
export interface PgPoolClientLike extends PgQueryable {
  release(): void;
}

/** `pg.Pool` shape: transactions run on a checked-out connection that is always released. */
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgPoolClientLike>;
  end?(): Promise<void>;
}

/** PGlite shape (or any driver exposing a `transaction(fn)` helper that rolls back on throw). */
export interface PgLiteLike extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Accepted clients: a `pg.Pool`-compatible pool or a PGlite-compatible instance. */
export type PgClientLike = PgPoolLike | PgLiteLike;

/** Options for {@link PostgresStore}. */
export interface PostgresStoreOptions {
  /** A `pg.Pool` (or compatible) or a PGlite instance. A bare `pg.Client` is not supported. */
  client: PgClientLike;
  /** Schema that holds the tables; created by `migrate()` when missing. @default 'public' */
  schema?: string | undefined;
  /** Prefix applied to every table name. @default 'watukuy_' */
  tablePrefix?: string | undefined;
  /**
   * Whether `close()` also ends the injected client (`pool.end()` / `pglite.close()`). Off by
   * default because the caller usually owns the connection. @default false
   */
  closeClient?: boolean | undefined;
}

interface Driver {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  withTransaction<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Row = Record<string, unknown>;
/** Partial poller state accepted by `saveState` / `commitPoll`. */
type StatePatch = Partial<Omit<PollerState, 'createdAt'>>;
type PgSql = ReturnType<typeof buildSql>;

/** Bind JSON text through `text` so neither driver re-serialises it, then cast server-side. */
const JSONB = '::text::jsonb';
const ITEM_CASTS = ['', '', '', '', '', '', JSONB, ''] as const;
const OUTBOX_CASTS = ['', '', '', '', JSONB, '', '', '', JSONB, ''] as const;
const PARKED_CASTS = ['', '', '', '', JSONB, JSONB, JSONB, '', '', ''] as const;
const LOG_CASTS = ['', '', '', JSONB, ''] as const;
const ITEM_ROWS_PER_STATEMENT = 200;
const OUTBOX_ROWS_PER_STATEMENT = 100;
const IDS_PER_STATEMENT = 5_000;

function isPoolClient(value: unknown): value is PgPoolClientLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PgPoolClientLike).query === 'function' &&
    typeof (value as PgPoolClientLike).release === 'function'
  );
}

function createDriver(client: PgClientLike): Driver {
  if ('connect' in client && typeof client.connect === 'function') {
    const pool = client;
    return {
      query: (text, values) => pool.query(text, values ?? []),
      async withTransaction(fn) {
        const conn: unknown = await pool.connect();
        if (!isPoolClient(conn)) {
          throw new StoreError(
            'PostgresStore: client.connect() did not return a pooled connection with query() and release(); pass a pg.Pool (a bare pg.Client is not supported)',
          );
        }
        let began = false;
        try {
          await conn.query('BEGIN');
          began = true;
          const out = await fn(conn);
          await conn.query('COMMIT');
          return out;
        } catch (err) {
          if (began) await conn.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          conn.release();
        }
      },
      close: async () => {
        await pool.end?.();
      },
    };
  }
  if ('transaction' in client && typeof client.transaction === 'function') {
    const lite = client;
    return {
      query: (text, values) => lite.query(text, values ?? []),
      withTransaction: (fn) => lite.transaction(fn),
      close: async () => {
        await lite.close?.();
      },
    };
  }
  throw new StoreError(
    'PostgresStore: unsupported client. Pass a pg.Pool (query() plus connect() returning a client with release()) or a PGlite instance (query() plus transaction()).',
  );
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new StoreError(`PostgresStore: expected a numeric column, got ${typeof v}`);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  throw new StoreError(`PostgresStore: expected a text column, got ${typeof v}`);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

/** JSONB columns are selected as `::text`, so a JSON `null` arrives as the string `'null'` and SQL NULL as `null`. */
function parseJson<T>(v: unknown): T {
  return JSON.parse(str(v)) as T;
}

function parseJsonOrNull<T>(v: unknown): T | null {
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
  throw new StoreError(`PostgresStore: unknown outbox status '${v}'`);
}

function asKind(v: string): ParkedRow['kind'] {
  if (v === 'poison' || v === 'invalid') return v;
  throw new StoreError(`PostgresStore: unknown parked kind '${v}'`);
}

function toStoreError(err: unknown): Error {
  if (err instanceof WatukuyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new StoreError(`PostgresStore: ${message}`, { cause: err });
}

function rows(res: PgQueryResultLike): Row[] {
  return res.rows as Row[];
}

function first(res: PgQueryResultLike): Row | undefined {
  return res.rows[0] as Row | undefined;
}

function affected(res: PgQueryResultLike): number {
  if (typeof res.affectedRows === 'number') return res.affectedRows;
  return res.rowCount ?? 0;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Last write wins, as with a `Map`; Postgres rejects the same key twice in one `INSERT ... ON CONFLICT`. */
function dedupe<T>(list: readonly T[], keyOf: (row: T) => string | number): T[] {
  const map = new Map<string | number, T>();
  for (const row of list) map.set(keyOf(row), row);
  return [...map.values()];
}

/** `($1, $2::text::jsonb, ...), ($n, ...)` for `rowCount` rows using the given per-column casts. */
function valuesClause(rowCount: number, casts: readonly string[]): string {
  const tuples: string[] = [];
  let i = 1;
  for (let r = 0; r < rowCount; r++) {
    tuples.push(`(${casts.map((cast) => `$${i++}${cast}`).join(', ')})`);
  }
  return tuples.join(', ');
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

function outboxParams(key: PKey, row: OutboxRow): unknown[] {
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

function parkedParams(key: PKey, row: ParkedRow): unknown[] {
  return [
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
  ];
}

function buildSql(schema: string, prefix: string) {
  const t = postgresTableNames(schema, prefix);
  const K = 'poller = $1 AND "partition" = $2';
  return {
    // The target is aliased `p` so the existing row and EXCLUDED (the attempted insert) are
    // distinguishable; both epoch columns advance from the stored counter in one statement.
    acquire: `INSERT INTO ${t.pollers} AS p (poller, "partition", lease_owner, lease_epoch, lease_expires_at, epoch_counter)
VALUES ($1, $2, $3, 1, $4, 1)
ON CONFLICT (poller, "partition") DO UPDATE SET
  lease_owner = EXCLUDED.lease_owner,
  epoch_counter = p.epoch_counter + 1,
  lease_epoch = p.epoch_counter + 1,
  lease_expires_at = EXCLUDED.lease_expires_at
WHERE p.lease_owner IS NULL OR p.lease_expires_at <= $5 OR p.lease_owner = EXCLUDED.lease_owner
RETURNING lease_epoch, lease_expires_at`,
    renew: `UPDATE ${t.pollers} SET lease_expires_at = $5 WHERE ${K} AND lease_owner = $3 AND lease_epoch = $4`,
    release: `UPDATE ${t.pollers} SET lease_owner = NULL, lease_expires_at = NULL WHERE ${K} AND lease_owner = $3 AND lease_epoch = $4`,
    lease: `SELECT lease_owner, lease_epoch, lease_expires_at FROM ${t.pollers} WHERE ${K}`,
    lockPoller: `SELECT lease_owner, lease_epoch, state::text AS state FROM ${t.pollers} WHERE ${K} FOR UPDATE`,
    loadState: `SELECT state::text AS state FROM ${t.pollers} WHERE ${K}`,
    saveState: `INSERT INTO ${t.pollers} (poller, "partition", state) VALUES ($1, $2, $3${JSONB}) ON CONFLICT (poller, "partition") DO UPDATE SET state = EXCLUDED.state`,
    listKeys: `SELECT poller, "partition" FROM ${t.pollers} ORDER BY poller, "partition"`,
    listKeysOf: `SELECT poller, "partition" FROM ${t.pollers} WHERE poller = $1 ORDER BY "partition"`,
    deleteAll: POSTGRES_TABLES.map((name) => `DELETE FROM ${t[name]} WHERE ${K}`),
    deleteItemsAll: `DELETE FROM ${t.items} WHERE ${K}`,
    upsertItems: (n: number) =>
      `INSERT INTO ${t.items} (poller, "partition", identity, version, hash, schema_version, payload, seen_at) VALUES ${valuesClause(n, ITEM_CASTS)} ON CONFLICT (poller, "partition", identity) DO UPDATE SET version = EXCLUDED.version, hash = EXCLUDED.hash, schema_version = EXCLUDED.schema_version, payload = EXCLUDED.payload, seen_at = EXCLUDED.seen_at`,
    deleteItems: `DELETE FROM ${t.items} WHERE ${K} AND identity = ANY($3::text[])`,
    selectItems: `SELECT identity, version, hash, schema_version, payload::text AS payload, seen_at FROM ${t.items} WHERE ${K} AND identity = ANY($3::text[])`,
    streamFirst: `SELECT identity FROM ${t.items} WHERE ${K} ORDER BY identity LIMIT $3`,
    streamNext: `SELECT identity FROM ${t.items} WHERE ${K} AND identity > $3 ORDER BY identity LIMIT $4`,
    countItems: `SELECT COUNT(*)::int AS n FROM ${t.items} WHERE ${K}`,
    upsertOutbox: (n: number) =>
      `INSERT INTO ${t.outbox} (poller, "partition", seq, event_id, event, status, attempts, next_attempt_at, last_error, created_at) VALUES ${valuesClause(n, OUTBOX_CASTS)} ON CONFLICT (poller, "partition", event_id) DO UPDATE SET seq = EXCLUDED.seq, event = EXCLUDED.event, status = EXCLUDED.status, attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at, last_error = EXCLUDED.last_error, created_at = EXCLUDED.created_at`,
    loadPending: `SELECT event_id, seq, event::text AS event, status, attempts, next_attempt_at, last_error::text AS last_error, created_at FROM ${t.outbox} WHERE ${K} AND status = 'pending' ORDER BY seq LIMIT $3`,
    countPending: `SELECT COUNT(*)::int AS n FROM ${t.outbox} WHERE ${K} AND status = 'pending'`,
    deleteOutbox: `DELETE FROM ${t.outbox} WHERE ${K} AND event_id = ANY($3::text[])`,
    recordAttempt: `UPDATE ${t.outbox} SET attempts = attempts + 1, last_error = $3${JSONB}, next_attempt_at = $4 WHERE ${K} AND event_id = $5`,
    upsertParked: (n: number) =>
      `INSERT INTO ${t.parked} (poller, "partition", id, kind, event, item, error, attempts, parked_at, hold_key) VALUES ${valuesClause(n, PARKED_CASTS)} ON CONFLICT (poller, "partition", id) DO UPDATE SET kind = EXCLUDED.kind, event = EXCLUDED.event, item = EXCLUDED.item, error = EXCLUDED.error, attempts = EXCLUDED.attempts, parked_at = EXCLUDED.parked_at, hold_key = EXCLUDED.hold_key`,
    selectParked: `SELECT id, kind, event::text AS event, item::text AS item, error::text AS error, attempts, parked_at, hold_key FROM ${t.parked} WHERE ${K}`,
    lockPoisonParked: `SELECT event::text AS event, parked_at FROM ${t.parked} WHERE ${K} AND id = $3 AND kind = 'poison' AND event IS NOT NULL FOR UPDATE`,
    countParked: `SELECT COUNT(*)::int AS n FROM ${t.parked} WHERE ${K}`,
    deleteParked: `DELETE FROM ${t.parked} WHERE ${K} AND id = ANY($3::text[])`,
    deleteParkedOne: `DELETE FROM ${t.parked} WHERE ${K} AND id = $3`,
    heldKeys: `SELECT DISTINCT hold_key FROM ${t.parked} WHERE ${K} AND hold_key IS NOT NULL`,
    getValidator: `SELECT etag, last_modified, stored_at FROM ${t.validators} WHERE ${K} AND url_hash = $3`,
    upsertValidator: `INSERT INTO ${t.validators} (poller, "partition", url_hash, etag, last_modified, stored_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (poller, "partition", url_hash) DO UPDATE SET etag = EXCLUDED.etag, last_modified = EXCLUDED.last_modified, stored_at = EXCLUDED.stored_at`,
    upsertLog: (n: number) =>
      `INSERT INTO ${t.log} (poller, "partition", seq, event, created_at) VALUES ${valuesClause(n, LOG_CASTS)} ON CONFLICT (poller, "partition", seq) DO UPDATE SET event = EXCLUDED.event, created_at = EXCLUDED.created_at`,
    selectLog: `SELECT seq, event::text AS event, created_at FROM ${t.log} WHERE ${K}`,
    pruneLog: `DELETE FROM ${t.log} WHERE ${K} AND created_at < $3`,
  };
}

/**
 * `StateStore` on PostgreSQL. Driver-agnostic: pass a `pg.Pool` (or anything with the same
 * `query()`/`connect()` shape) or a PGlite instance; the store detects which one it received.
 * Every fenced write runs in a transaction that locks the poller row and verifies the lease
 * owner and epoch first, so a stale instance can never commit (see docs/how-it-works.md).
 *
 * The constructor performs no I/O. Tables are created by `migrate()` or lazily on first use;
 * both are idempotent and safe to run from several instances at once.
 *
 * @example
 * import pg from 'pg';
 * import { PostgresStore } from 'watukuy/store-postgres';
 *
 * const store = new PostgresStore({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 * await store.migrate();
 */
export class PostgresStore implements StateStore {
  readonly capabilities: StoreCapabilities = { transactions: true, log: true, streaming: true };
  private readonly driver: Driver;
  private readonly schema: string;
  private readonly prefix: string;
  private readonly closeClient: boolean;
  private readonly sql: PgSql;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresStoreOptions) {
    if (typeof options.client !== 'object' || options.client === null) {
      throw new ConfigError('PostgresStore requires `client`: a pg.Pool or a PGlite instance');
    }
    this.driver = createDriver(options.client);
    this.schema = options.schema ?? DEFAULT_SCHEMA;
    this.prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
    assertPgIdentifier(this.schema, 'PostgresStore schema', false);
    assertPgIdentifier(this.prefix, 'PostgresStore tablePrefix', true);
    this.closeClient = options.closeClient ?? false;
    this.sql = buildSql(this.schema, this.prefix);
  }

  /** Create the schema, tables and indexes when missing. Serialised across instances with an advisory lock. */
  async migrate(): Promise<void> {
    try {
      await this.applyMigrations();
      this.ready = Promise.resolve();
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /** Release resources. Ends the injected client only when `closeClient` is set. */
  async close(): Promise<void> {
    try {
      if (this.closeClient) await this.driver.close();
    } catch (err) {
      throw toStoreError(err);
    } finally {
      this.ready = null;
    }
  }

  async acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null> {
    return this.run(async () => {
      const row = first(
        await this.driver.query(this.sql.acquire, [
          key.poller,
          key.partition,
          owner,
          now + ttlMs,
          now,
        ]),
      );
      if (!row) return null;
      return { owner, epoch: num(row.lease_epoch), expiresAt: num(row.lease_expires_at) };
    });
  }

  async renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean> {
    return this.run(async () => {
      const res = await this.driver.query(this.sql.renew, [
        key.poller,
        key.partition,
        lease.owner,
        lease.epoch,
        now + ttlMs,
      ]);
      return affected(res) === 1;
    });
  }

  async releaseLease(key: PKey, lease: Lease): Promise<void> {
    await this.run(() =>
      this.driver.query(this.sql.release, [key.poller, key.partition, lease.owner, lease.epoch]),
    );
  }

  async getLease(key: PKey): Promise<Lease | null> {
    return this.run(async () => {
      const row = first(await this.driver.query(this.sql.lease, [key.poller, key.partition]));
      return row ? toLease(row) : null;
    });
  }

  async loadState(key: PKey): Promise<PollerState | null> {
    return this.run(async () => {
      const row = first(await this.driver.query(this.sql.loadState, [key.poller, key.partition]));
      return parseJsonOrNull<PollerState>(row?.state);
    });
  }

  async saveState(key: PKey, lease: Lease, patch: StatePatch): Promise<void> {
    await this.fenced(key, lease, (q, state) => this.writeState(q, key, state, patch));
  }

  async saveStateUnfenced(key: PKey, patch: StatePatch): Promise<void> {
    await this.run(() =>
      this.driver.withTransaction(async (q) => {
        const row = first(await q.query(this.sql.lockPoller, [key.poller, key.partition]));
        await this.writeState(q, key, parseJsonOrNull<PollerState>(row?.state), patch);
      }),
    );
  }

  async listKeys(poller?: string): Promise<PKey[]> {
    return this.run(async () => {
      const res =
        poller === undefined
          ? await this.driver.query(this.sql.listKeys)
          : await this.driver.query(this.sql.listKeysOf, [poller]);
      return rows(res).map((r) => ({ poller: str(r.poller), partition: str(r.partition) }));
    });
  }

  async deleteKey(key: PKey): Promise<void> {
    await this.run(() =>
      this.driver.withTransaction(async (q) => {
        for (const sql of this.sql.deleteAll) await q.query(sql, [key.poller, key.partition]);
      }),
    );
  }

  async clearItems(key: PKey): Promise<void> {
    await this.run(() => this.driver.query(this.sql.deleteItemsAll, [key.poller, key.partition]));
  }

  async loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>> {
    return this.run(async () => {
      const out = new Map<string, ItemRow>();
      for (const chunk of chunks(identities, IDS_PER_STATEMENT)) {
        const res = await this.driver.query(this.sql.selectItems, [
          key.poller,
          key.partition,
          chunk,
        ]);
        for (const r of rows(res)) {
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
      const page = await this.run(async () =>
        rows(
          after === null
            ? await this.driver.query(this.sql.streamFirst, [key.poller, key.partition, size])
            : await this.driver.query(this.sql.streamNext, [
                key.poller,
                key.partition,
                after,
                size,
              ]),
        ),
      );
      if (page.length === 0) return;
      const ids = page.map((r) => str(r.identity));
      yield ids;
      if (ids.length < size) return;
      after = ids[ids.length - 1] ?? null;
    }
  }

  async countItems(key: PKey): Promise<number> {
    return this.run(async () =>
      num(first(await this.driver.query(this.sql.countItems, [key.poller, key.partition]))?.n),
    );
  }

  async commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void> {
    await this.fenced(key, lease, async (q, state) => {
      const { poller, partition } = key;
      for (const chunk of chunks(
        dedupe(batch.upserts, (r) => r.identity),
        ITEM_ROWS_PER_STATEMENT,
      )) {
        await q.query(
          this.sql.upsertItems(chunk.length),
          chunk.flatMap((r) => [
            poller,
            partition,
            r.identity,
            r.version,
            r.hash,
            r.schemaVersion,
            encodeOptionalJson(r.payload),
            r.seenAt,
          ]),
        );
      }
      if (batch.deletes.length > 0) {
        for (const chunk of chunks(batch.deletes, IDS_PER_STATEMENT)) {
          await q.query(this.sql.deleteItems, [poller, partition, chunk]);
        }
      }
      const events = dedupe(batch.events, (r) => r.eventId);
      for (const chunk of chunks(events, OUTBOX_ROWS_PER_STATEMENT)) {
        await q.query(
          this.sql.upsertOutbox(chunk.length),
          chunk.flatMap((r) => outboxParams(key, r)),
        );
      }
      for (const chunk of chunks(
        dedupe(batch.parked ?? [], (r) => r.id),
        OUTBOX_ROWS_PER_STATEMENT,
      )) {
        await q.query(
          this.sql.upsertParked(chunk.length),
          chunk.flatMap((r) => parkedParams(key, r)),
        );
      }
      if (batch.log) {
        for (const chunk of chunks(
          dedupe(events, (r) => r.sequence),
          ITEM_ROWS_PER_STATEMENT,
        )) {
          await q.query(
            this.sql.upsertLog(chunk.length),
            chunk.flatMap((r) => [
              poller,
              partition,
              r.sequence,
              JSON.stringify(r.event),
              r.createdAt,
            ]),
          );
        }
      }
      await this.writeState(q, key, state, batch.statePatch);
    });
  }

  async loadPending(key: PKey, limit: number): Promise<OutboxRow[]> {
    return this.run(async () =>
      rows(await this.driver.query(this.sql.loadPending, [key.poller, key.partition, limit])).map(
        toOutbox,
      ),
    );
  }

  async countPending(key: PKey): Promise<number> {
    return this.run(async () =>
      num(first(await this.driver.query(this.sql.countPending, [key.poller, key.partition]))?.n),
    );
  }

  async ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void> {
    await this.fenced(key, lease, async (q) => {
      for (const chunk of chunks(eventIds, IDS_PER_STATEMENT)) {
        await q.query(this.sql.deleteOutbox, [key.poller, key.partition, chunk]);
      }
    });
  }

  async recordAttempt(
    key: PKey,
    lease: Lease,
    eventId: string,
    error: SerializedError,
    nextAttemptAt: number | null,
  ): Promise<void> {
    await this.fenced(key, lease, async (q) => {
      await q.query(this.sql.recordAttempt, [
        key.poller,
        key.partition,
        encodeNullableJson(error),
        nextAttemptAt,
        eventId,
      ]);
    });
  }

  async parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void> {
    await this.fenced(key, lease, async (q) => {
      await q.query(this.sql.upsertParked(1), parkedParams(key, row));
      if (row.event) {
        await q.query(this.sql.deleteOutbox, [key.poller, key.partition, [row.event.id]]);
      }
    });
  }

  async listParked(
    key: PKey,
    opts: { kind?: 'poison' | 'invalid'; limit?: number } = {},
  ): Promise<ParkedRow[]> {
    return this.run(async () => {
      const params: unknown[] = [key.poller, key.partition];
      let sql = this.sql.selectParked;
      if (opts.kind !== undefined) {
        params.push(opts.kind);
        sql += ` AND kind = $${params.length}`;
      }
      sql += ' ORDER BY parked_at, id';
      if (opts.limit !== undefined) {
        params.push(opts.limit);
        sql += ` LIMIT $${params.length}`;
      }
      return rows(await this.driver.query(sql, params)).map(toParked);
    });
  }

  async countParked(key: PKey): Promise<number> {
    return this.run(async () =>
      num(first(await this.driver.query(this.sql.countParked, [key.poller, key.partition]))?.n),
    );
  }

  async retryParked(key: PKey, ids: string[]): Promise<number> {
    return this.run(() =>
      this.driver.withTransaction(async (q) => {
        let moved = 0;
        for (const id of ids) {
          const row = first(
            await q.query(this.sql.lockPoisonParked, [key.poller, key.partition, id]),
          );
          if (!row) continue;
          const event = parseJson<WatukuyEvent<unknown>>(row.event);
          await q.query(
            this.sql.upsertOutbox(1),
            outboxParams(key, {
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
          await q.query(this.sql.deleteParkedOne, [key.poller, key.partition, id]);
          moved++;
        }
        return moved;
      }),
    );
  }

  async discardParked(key: PKey, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.run(async () => {
      let removed = 0;
      for (const chunk of chunks(ids, IDS_PER_STATEMENT)) {
        removed += affected(
          await this.driver.query(this.sql.deleteParked, [key.poller, key.partition, chunk]),
        );
      }
      return removed;
    });
  }

  async heldKeys(key: PKey): Promise<Set<string>> {
    return this.run(
      async () =>
        new Set(
          rows(await this.driver.query(this.sql.heldKeys, [key.poller, key.partition])).map((r) =>
            str(r.hold_key),
          ),
        ),
    );
  }

  async getValidator(key: PKey, urlHash: string): Promise<Validator | null> {
    return this.run(async () => {
      const row = first(
        await this.driver.query(this.sql.getValidator, [key.poller, key.partition, urlHash]),
      );
      return row ? toValidator(row) : null;
    });
  }

  async setValidator(
    key: PKey,
    lease: Lease,
    urlHash: string,
    validator: Validator,
  ): Promise<void> {
    await this.fenced(key, lease, async (q) => {
      await q.query(this.sql.upsertValidator, [
        key.poller,
        key.partition,
        urlHash,
        validator.etag,
        validator.lastModified,
        validator.storedAt,
      ]);
    });
  }

  async readLog(
    key: PKey,
    range: { afterSequence?: number; fromTime?: number; toTime?: number },
    limit: number,
  ): Promise<LoggedEvent[]> {
    return this.run(async () => {
      const params: unknown[] = [key.poller, key.partition];
      let sql = this.sql.selectLog;
      if (range.afterSequence !== undefined) {
        params.push(range.afterSequence);
        sql += ` AND seq > $${params.length}`;
      }
      if (range.fromTime !== undefined) {
        params.push(range.fromTime);
        sql += ` AND created_at >= $${params.length}`;
      }
      if (range.toTime !== undefined) {
        params.push(range.toTime);
        sql += ` AND created_at <= $${params.length}`;
      }
      params.push(limit);
      sql += ` ORDER BY seq LIMIT $${params.length}`;
      return rows(await this.driver.query(sql, params)).map(toLogged);
    });
  }

  async pruneLog(key: PKey, olderThan: number): Promise<number> {
    return this.run(async () =>
      affected(await this.driver.query(this.sql.pruneLog, [key.poller, key.partition, olderThan])),
    );
  }

  private async applyMigrations(): Promise<void> {
    await this.driver.withTransaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `watukuy:migrate:${this.schema}.${this.prefix}`,
      ]);
      for (const statement of postgresMigrations(this.schema, this.prefix)) {
        await q.query(statement);
      }
    });
  }

  private ensureReady(): Promise<void> {
    if (this.ready === null) {
      const pending = this.applyMigrations();
      this.ready = pending;
      pending.catch(() => {
        if (this.ready === pending) this.ready = null;
      });
    }
    return this.ready;
  }

  /** Migrate lazily, run `fn`, and wrap driver failures in `StoreError`. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.ensureReady();
      return await fn();
    } catch (err) {
      throw toStoreError(err);
    }
  }

  /**
   * Transaction that first locks the poller row and verifies the lease. Throws `LeaseLostError`
   * (rolling back) when the stored owner or epoch differ, or when no lease exists.
   */
  private fenced<T>(
    key: PKey,
    lease: Lease,
    fn: (q: PgQueryable, state: PollerState | null) => Promise<T>,
  ): Promise<T> {
    return this.run(() =>
      this.driver.withTransaction(async (q) => {
        const row = first(await q.query(this.sql.lockPoller, [key.poller, key.partition]));
        const current = row ? toLease(row) : null;
        if (!current || current.owner !== lease.owner || current.epoch !== lease.epoch) {
          throw new LeaseLostError(key.poller, key.partition, lease.epoch);
        }
        return fn(q, parseJsonOrNull<PollerState>(row?.state));
      }),
    );
  }

  /** Top-level replace of the provided fields; `createdAt` is preserved (or seeded from `updatedAt`). */
  private async writeState(
    q: PgQueryable,
    key: PKey,
    current: PollerState | null,
    patch: StatePatch,
  ): Promise<void> {
    const base = current ?? emptyPollerState(patch.updatedAt ?? 0);
    const next: PollerState = { ...base, ...patch, createdAt: base.createdAt };
    await q.query(this.sql.saveState, [key.poller, key.partition, JSON.stringify(next)]);
  }
}
