import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, StoreError } from '../../core/errors.ts';
import type { PKey } from '../../core/store-types.ts';
import { storeContractSuite } from '../../testing/store-contract.ts';
import { type PgClientLike, type PgQueryable, PostgresStore } from './postgres-store.ts';
import { POSTGRES_TABLES, postgresMigrations } from './schema.ts';

const KEY: PKey = { poller: 'orders', partition: '' };

async function dropTables(client: PgQueryable, schema: string, prefix: string): Promise<void> {
  for (const name of POSTGRES_TABLES) {
    await client.query(`DROP TABLE IF EXISTS "${schema}"."${prefix}${name}" CASCADE`);
  }
}

// PGlite: always runs, fully in-process.
const pglite = new PGlite();
afterAll(async () => {
  await pglite.close();
});

storeContractSuite({
  name: 'PostgresStore (PGlite)',
  create: () => new PostgresStore({ client: pglite, tablePrefix: 'wk_' }),
  destroy: async (store) => {
    await store.close();
    await dropTables(pglite, 'public', 'wk_');
  },
});

describe('PostgresStore options', () => {
  it('rejects clients that are neither pool-like nor PGlite-like', () => {
    const bare = { query: async () => ({ rows: [] }) } as unknown as PgClientLike;
    expect(() => new PostgresStore({ client: bare })).toThrow(StoreError);
    expect(() => new PostgresStore({ client: null as unknown as PgClientLike })).toThrow(
      ConfigError,
    );
  });

  it('rejects invalid identifiers eagerly', () => {
    expect(() => new PostgresStore({ client: pglite, schema: 'bad schema' })).toThrow(ConfigError);
    expect(() => new PostgresStore({ client: pglite, tablePrefix: 'x-y' })).toThrow(ConfigError);
    expect(() => postgresMigrations('public', '1abc')).toThrow(ConfigError);
  });

  it('creates tables in a custom schema and migrates idempotently', async () => {
    const store = new PostgresStore({ client: pglite, schema: 'wk_custom', tablePrefix: 'p_' });
    try {
      await store.migrate();
      await store.migrate();
      const res = await pglite.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'wk_custom' ORDER BY table_name",
      );
      expect(res.rows.map((r) => r.table_name)).toEqual(
        POSTGRES_TABLES.map((n) => `p_${n}`).sort(),
      );
      const lease = await store.acquireLease(KEY, 'node-a', 1_000, 0);
      expect(lease?.epoch).toBe(1);
    } finally {
      await store.close();
      await pglite.query('DROP SCHEMA IF EXISTS wk_custom CASCADE');
    }
  });

  it('does not close an injected client unless closeClient is set', async () => {
    const store = new PostgresStore({ client: pglite, tablePrefix: 'c_' });
    await store.migrate();
    await store.close();
    expect(pglite.closed).toBe(false);
    // Usable again after close(): tables are re-ensured lazily.
    await store.saveStateUnfenced(KEY, { paused: true, updatedAt: 1 });
    expect((await store.loadState(KEY))?.paused).toBe(true);
    await dropTables(pglite, 'public', 'c_');
  });

  it('a lease taken by one store instance fences another instance on the same tables', async () => {
    const a = new PostgresStore({ client: pglite, tablePrefix: 'f_' });
    const b = new PostgresStore({ client: pglite, tablePrefix: 'f_' });
    try {
      const lease = await a.acquireLease(KEY, 'node-a', 30_000, 1_000);
      expect(lease).not.toBeNull();
      expect(await b.acquireLease(KEY, 'node-b', 30_000, 2_000)).toBeNull();
      expect(await b.getLease(KEY)).toEqual(lease);
    } finally {
      await dropTables(pglite, 'public', 'f_');
    }
  });
});

// Real Postgres through Testcontainers: forced with WATUKUY_TEST_CONTAINERS=1, otherwise
// attempted whenever Docker answers. A container that fails to start (or whose image pull
// stalls) skips the block with a message instead of failing or hanging the run, unless forced.
// WATUKUY_TEST_PG_IMAGE overrides the image, e.g. to reuse one that is already cached locally.
function dockerReachable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const forced = process.env.WATUKUY_TEST_CONTAINERS === '1';
const image = process.env.WATUKUY_TEST_PG_IMAGE ?? 'postgres:17-alpine';
let real: { container: StartedPostgreSqlContainer; pool: pg.Pool } | null = null;
if (forced || dockerReachable()) {
  try {
    const container = await withTimeout(
      new PostgreSqlContainer(image).start(),
      forced ? Number.POSITIVE_INFINITY : 120_000,
      `starting ${image}`,
    );
    const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
    real = { container, pool };
  } catch (err) {
    if (forced) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[watukuy] Docker is reachable but the Postgres container (${image}) could not start; skipping the Testcontainers suite: ${reason}`,
    );
  }
}

describe.skipIf(real === null)(`PostgresStore (Testcontainers ${image}, pg.Pool)`, () => {
  afterAll(async () => {
    if (!real) return;
    await real.pool.end();
    await real.container.stop();
  });

  storeContractSuite({
    name: 'PostgresStore (pg.Pool)',
    create: () => new PostgresStore({ client: real!.pool, tablePrefix: 'tc_' }),
    destroy: async (store) => {
      await store.close();
      await dropTables(real!.pool, 'public', 'tc_');
    },
  });

  it('runs concurrent migrate() calls without racing', async () => {
    const stores = Array.from(
      { length: 4 },
      () => new PostgresStore({ client: real!.pool, tablePrefix: 'race_' }),
    );
    try {
      await Promise.all(stores.map((s) => s.migrate()));
      const lease = await stores[0]!.acquireLease(KEY, 'node-a', 1_000, 0);
      expect(lease?.epoch).toBe(1);
    } finally {
      await dropTables(real!.pool, 'public', 'race_');
    }
  });
});
