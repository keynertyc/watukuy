/**
 * watukuy/store-redis — Redis-backed `StateStore` and distributed `RateBudgetStore`.
 *
 * Works with `ioredis` and node-redis (`redis`); pass a connected client and the driver is
 * auto-detected. The store never opens or closes connections.
 *
 * @example
 * import { Redis } from 'ioredis';
 * import { RedisBudgetStore, RedisStore } from 'watukuy/store-redis';
 *
 * const client = new Redis(process.env.REDIS_URL);
 * const store = new RedisStore({ client });
 * const budgetStore = new RedisBudgetStore({ client });
 * @packageDocumentation
 */

export {
  adaptRedisClient,
  fromIoredis,
  fromNodeRedis,
  type IoredisLikeClient,
  type NodeRedisLikeClient,
  type RedisLike,
} from './client.ts';
export { RedisBudgetStore, type RedisBudgetStoreOptions } from './redis-budget.ts';
export { RedisStore, type RedisStoreOptions } from './redis-store.ts';
