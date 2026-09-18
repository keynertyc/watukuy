import { ConfigError } from '../../core/errors.ts';

/** Table name suffixes used by `SqliteStore`; the configured prefix is prepended to each. */
export const SQLITE_TABLES = ['pollers', 'items', 'outbox', 'parked', 'validators', 'log'] as const;

/** One of the six store tables. */
export type SqliteTable = (typeof SQLITE_TABLES)[number];

/** Default table prefix (`watukuy_pollers`, `watukuy_items`, ...). */
export const DEFAULT_TABLE_PREFIX = 'watukuy_';

/** Poller state plus lease columns; one row per `(poller, partition)`. `{prefix}` is substituted by {@link sqliteMigrations}. */
export const SQLITE_DDL_POLLERS = `CREATE TABLE IF NOT EXISTS "{prefix}pollers" (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  state TEXT,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  epoch_counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (poller, "partition")
)`;

/** Item snapshot: identity, version, canonical hash and optional retained payload. */
export const SQLITE_DDL_ITEMS = `CREATE TABLE IF NOT EXISTS "{prefix}items" (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  identity TEXT NOT NULL,
  version TEXT,
  hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (poller, "partition", identity)
)`;

/** Outbox of events awaiting delivery. */
export const SQLITE_DDL_OUTBOX = `CREATE TABLE IF NOT EXISTS "{prefix}outbox" (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poller, "partition", event_id)
)`;

/** Index backing `loadPending` (pending rows in sequence order). */
export const SQLITE_DDL_OUTBOX_INDEX = `CREATE INDEX IF NOT EXISTS "{prefix}outbox_pending_idx" ON "{prefix}outbox" (poller, "partition", status, seq)`;

/** Parked events (`poison`) and quarantined items (`invalid`). */
export const SQLITE_DDL_PARKED = `CREATE TABLE IF NOT EXISTS "{prefix}parked" (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event TEXT,
  item TEXT,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  parked_at INTEGER NOT NULL,
  hold_key TEXT,
  PRIMARY KEY (poller, "partition", id)
)`;

/** Index backing `listParked` ordering. */
export const SQLITE_DDL_PARKED_INDEX = `CREATE INDEX IF NOT EXISTS "{prefix}parked_order_idx" ON "{prefix}parked" (poller, "partition", parked_at)`;

/** HTTP validators (ETag / Last-Modified) per URL hash. */
export const SQLITE_DDL_VALIDATORS = `CREATE TABLE IF NOT EXISTS "{prefix}validators" (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  stored_at INTEGER NOT NULL,
  PRIMARY KEY (poller, "partition", url_hash)
)`;

/** Optional event log used by `replay()`. */
export const SQLITE_DDL_LOG = `CREATE TABLE IF NOT EXISTS "{prefix}log" (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poller, "partition", seq)
)`;

/** Index backing time-range reads and `pruneLog`. */
export const SQLITE_DDL_LOG_INDEX = `CREATE INDEX IF NOT EXISTS "{prefix}log_time_idx" ON "{prefix}log" (poller, "partition", created_at)`;

/** Every DDL statement, in application order. All statements are idempotent. */
export const SQLITE_DDL: readonly string[] = [
  SQLITE_DDL_POLLERS,
  SQLITE_DDL_ITEMS,
  SQLITE_DDL_OUTBOX,
  SQLITE_DDL_OUTBOX_INDEX,
  SQLITE_DDL_PARKED,
  SQLITE_DDL_PARKED_INDEX,
  SQLITE_DDL_VALIDATORS,
  SQLITE_DDL_LOG,
  SQLITE_DDL_LOG_INDEX,
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reject table prefixes that could break out of a quoted identifier. Empty prefixes are allowed.
 * @throws ConfigError
 */
export function assertSqlIdentifierPrefix(prefix: string, what: string): void {
  if (prefix !== '' && !IDENTIFIER.test(prefix)) {
    throw new ConfigError(
      `${what} must contain only letters, digits and underscores and must not start with a digit; got '${prefix}'`,
    );
  }
}

/**
 * Idempotent migration statements for the SQLite store, with `{prefix}` resolved.
 * Apply them in order with `db.exec()`; `SqliteStore.migrate()` does exactly this.
 */
export function sqliteMigrations(prefix: string = DEFAULT_TABLE_PREFIX): string[] {
  assertSqlIdentifierPrefix(prefix, 'tablePrefix');
  return SQLITE_DDL.map((statement) => statement.replaceAll('{prefix}', prefix));
}
