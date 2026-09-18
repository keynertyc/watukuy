/**
 * watukuy/store-sqlite — `StateStore` on Node's built-in `node:sqlite`.
 *
 * No native add-on to install. Suited to single-process deployments and to several processes
 * on one host sharing a file (WAL mode plus the lease protocol).
 *
 * @example
 * import { SqliteStore } from 'watukuy/store-sqlite';
 *
 * const store = new SqliteStore({ path: './watukuy.db' });
 * await store.migrate();
 * @packageDocumentation
 */

export {
  DEFAULT_TABLE_PREFIX,
  SQLITE_DDL,
  SQLITE_TABLES,
  type SqliteTable,
  sqliteMigrations,
} from './schema.ts';
export { SqliteStore, type SqliteStoreOptions } from './sqlite-store.ts';
