/**
 * watukuy/store-postgres — `StateStore` on PostgreSQL.
 *
 * Driver-agnostic: pass a `pg.Pool` (or anything with the same `query()`/`connect()` shape) or a
 * PGlite instance. The store never opens connections and only closes the client when asked to
 * (`closeClient: true`).
 *
 * @example
 * import pg from 'pg';
 * import { PostgresStore } from 'watukuy/store-postgres';
 *
 * const store = new PostgresStore({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 * await store.migrate();
 * @packageDocumentation
 */

export {
  type PgClientLike,
  type PgLiteLike,
  type PgPoolClientLike,
  type PgPoolLike,
  type PgQueryable,
  type PgQueryResultLike,
  PostgresStore,
  type PostgresStoreOptions,
} from './postgres-store.ts';
export {
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  POSTGRES_TABLES,
  type PostgresTable,
  postgresMigrations,
  postgresTableNames,
} from './schema.ts';
