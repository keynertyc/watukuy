import { afterAll, beforeAll, describe } from 'vitest';
import { storeContractSuite } from '../../testing/store-contract.ts';
import { RedisStore } from './redis-store.ts';
import { clientCases, startRedis, type TestClient } from './redis-test-harness.ts';

// The shared StateStore conformance suite (PLAN §9.2) against a real Redis, once per driver.
const redis = await startRedis();

describe.skipIf(redis === null)('RedisStore conformance', () => {
  afterAll(async () => {
    await redis?.stop();
  });

  describe.each(clientCases)('with %s', (name, connect) => {
    let client: TestClient;

    beforeAll(async () => {
      client = await connect(redis!.url);
    });
    afterAll(async () => {
      await client.close();
    });

    storeContractSuite({
      name: `RedisStore (${name})`,
      create: async () => {
        await client.flush();
        return new RedisStore({ client: client.raw });
      },
      destroy: async () => {},
    });
  });
});
