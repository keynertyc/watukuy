import { ConfigError } from '../../core/errors.ts';

/** Table name suffixes used by `PostgresStore`; the configured prefix is prepended to each. */
export const POSTGRES_TABLES = [
  'pollers',
  'items',
  'outbox',
  'parked',
  'validators',
  'log',
] as const;

/** One of the six store tables. */
export type PostgresTable = (typeof POSTGRES_TABLES)[number];

/** Default schema. */
export const DEFAULT_SCHEMA = 'public';

/** Default table prefix (`watukuy_pollers`, `watukuy_items`, ...). */
export const DEFAULT_TABLE_PREFIX = 'watukuy_';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reject schema names and table prefixes that could break out of a quoted identifier.
 * @throws ConfigError
 */
export function assertPgIdentifier(value: string, what: string, allowEmpty: boolean): void {
  if (value === '' && allowEmpty) return;
  if (!IDENTIFIER.test(value)) {
    throw new ConfigError(
      `${what} must contain only letters, digits and underscores and must not start with a digit; got '${value}'`,
    );
  }
}

/** Fully qualified, quoted table names for a schema/prefix pair. */
export function postgresTableNames(schema: string, prefix: string): Record<PostgresTable, string> {
  const q = (name: PostgresTable): string => `"${schema}"."${prefix}${name}"`;
  return {
    pollers: q('pollers'),
    items: q('items'),
    outbox: q('outbox'),
    parked: q('parked'),
    validators: q('validators'),
    log: q('log'),
  };
}

/**
 * Idempotent migration statements for the Postgres store (`CREATE ... IF NOT EXISTS`). Apply
 * them in order inside one transaction; `PostgresStore.migrate()` does exactly this, holding an
 * advisory lock so concurrent starters do not race.
 *
 * Epoch-millisecond timestamps, sequences and epochs are `BIGINT`; JSON documents are `JSONB`.
 */
export function postgresMigrations(
  schema: string = DEFAULT_SCHEMA,
  prefix: string = DEFAULT_TABLE_PREFIX,
): string[] {
  assertPgIdentifier(schema, 'schema', false);
  assertPgIdentifier(prefix, 'tablePrefix', true);
  const t = postgresTableNames(schema, prefix);
  const idx = (name: string): string => `"${prefix}${name}"`;
  const out: string[] = [];
  if (schema !== 'public') out.push(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  out.push(
    `CREATE TABLE IF NOT EXISTS ${t.pollers} (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  state JSONB,
  lease_owner TEXT,
  lease_epoch BIGINT NOT NULL DEFAULT 0,
  lease_expires_at BIGINT,
  epoch_counter BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (poller, "partition")
)`,
    `CREATE TABLE IF NOT EXISTS ${t.items} (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  identity TEXT NOT NULL,
  version TEXT,
  hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload JSONB,
  seen_at BIGINT NOT NULL,
  PRIMARY KEY (poller, "partition", identity)
)`,
    `CREATE TABLE IF NOT EXISTS ${t.outbox} (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  seq BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  event JSONB NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  last_error JSONB,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (poller, "partition", event_id)
)`,
    `CREATE INDEX IF NOT EXISTS ${idx('outbox_pending_idx')} ON ${t.outbox} (poller, "partition", status, seq)`,
    `CREATE TABLE IF NOT EXISTS ${t.parked} (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event JSONB,
  item JSONB,
  error JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  parked_at BIGINT NOT NULL,
  hold_key TEXT,
  PRIMARY KEY (poller, "partition", id)
)`,
    `CREATE INDEX IF NOT EXISTS ${idx('parked_order_idx')} ON ${t.parked} (poller, "partition", parked_at)`,
    `CREATE TABLE IF NOT EXISTS ${t.validators} (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  stored_at BIGINT NOT NULL,
  PRIMARY KEY (poller, "partition", url_hash)
)`,
    `CREATE TABLE IF NOT EXISTS ${t.log} (
  poller TEXT NOT NULL,
  "partition" TEXT NOT NULL,
  seq BIGINT NOT NULL,
  event JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (poller, "partition", seq)
)`,
    `CREATE INDEX IF NOT EXISTS ${idx('log_time_idx')} ON ${t.log} (poller, "partition", created_at)`,
  );
  return out;
}
