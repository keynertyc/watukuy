import { RedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createClient } from 'redis';

/**
 * Test-only helpers shared by the Redis store and budget suites: start one Redis (Testcontainers,
 * or `WATUKUY_REDIS_URL` when set) and connect with each supported driver.
 */
export interface RedisHarness {
  url: string;
  stop(): Promise<void>;
}

/** A connected driver plus the few raw operations the tests need around the store. */
export interface TestClient {
  /** The driver instance handed to `RedisStore` / `RedisBudgetStore`. */
  raw: unknown;
  flush(): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  close(): Promise<void>;
}

export type Connect = (url: string) => Promise<TestClient>;

/**
 * Start Redis for a test file. Returns `null` (after logging why) when neither `WATUKUY_REDIS_URL`
 * nor Docker is available, so suites can `describe.skipIf`.
 */
export async function startRedis(): Promise<RedisHarness | null> {
  const external = process.env.WATUKUY_REDIS_URL;
  if (external) return { url: external, stop: async () => {} };
  try {
    const container = await new RedisContainer('redis:7-alpine').start();
    return {
      url: container.getConnectionUrl(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    console.warn(
      `[watukuy] could not start a Redis Testcontainer, skipping Redis suites: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** One entry per driver flavour; feed to `describe.each`. */
export const clientCases: Array<[name: string, connect: Connect]> = [
  [
    'ioredis',
    async (url) => {
      const client = new Redis(url, { lazyConnect: true });
      await client.connect();
      return {
        raw: client,
        flush: async () => {
          await client.flushdb();
        },
        keys: (pattern) => client.keys(pattern),
        close: async () => {
          await client.quit();
        },
      };
    },
  ],
  [
    'node-redis (RESP2)',
    async (url) => {
      const client = await createClient({ url }).connect();
      return {
        raw: client,
        flush: async () => {
          await client.flushDb();
        },
        keys: (pattern) => client.keys(pattern),
        close: async () => {
          await client.close();
        },
      };
    },
  ],
  [
    'node-redis (RESP3)',
    async (url) => {
      const client = await createClient({ url, RESP: 3 }).connect();
      return {
        raw: client,
        flush: async () => {
          await client.flushDb();
        },
        keys: (pattern) => client.keys(pattern),
        close: async () => {
          await client.close();
        },
      };
    },
  ],
];
