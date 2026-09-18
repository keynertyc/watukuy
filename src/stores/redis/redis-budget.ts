import { StoreError } from '../../core/errors.ts';
import type { BudgetPolicy, RateBudgetStore } from '../../core/store-types.ts';
import { adaptRedisClient, type RedisLike } from './client.ts';
import { BUDGET_TAKE } from './scripts.ts';

/** Options for {@link RedisBudgetStore}. */
export interface RedisBudgetStoreOptions {
  /** A connected ioredis or node-redis client, or any object implementing `RedisLike`. */
  client: unknown;
  /** Key prefix. Bucket `name` lives at `{prefix}budget:{name}`. @default 'watukuy:' */
  prefix?: string | undefined;
}

/**
 * Distributed token bucket (see docs/how-it-works.md, G6): every engine instance sharing a Redis sees the same
 * budget. One Lua script per `take` performs refill + deduction atomically, with arithmetic that
 * mirrors `MemoryBudgetStore` exactly (scaled token-milliseconds, same epsilon and clamping), so a
 * sequence of calls produces identical results on both stores.
 *
 * Entirely driven by the caller's `now` argument (never Redis `TIME`), which keeps it deterministic
 * under a fake clock. Buckets are hashes `{scaled, updated_at}` and are created full on first use.
 *
 * @example
 * const budgets = new RedisBudgetStore({ client: new Redis(url) });
 * const engine = createWatukuy({ store, budgetStore: budgets, budgets: { erp: { requests: 100, per: '1m' } } });
 */
export class RedisBudgetStore implements RateBudgetStore {
  private readonly client: RedisLike;
  private readonly prefix: string;

  constructor(options: RedisBudgetStoreOptions) {
    this.client = adaptRedisClient(options.client);
    this.prefix = options.prefix ?? 'watukuy:';
  }

  private bucketKey(name: string): string {
    return `${this.prefix}budget:${encodeURIComponent(name)}`;
  }

  private async run(
    name: string,
    cost: number,
    policy: BudgetPolicy,
    now: number,
  ): Promise<[ok: boolean, value: number]> {
    const reply = await this.client.eval(
      BUDGET_TAKE,
      [this.bucketKey(name)],
      [
        String(cost),
        String(policy.requests),
        String(policy.perMs),
        String(policy.burst),
        String(now),
      ],
    );
    if (!Array.isArray(reply) || reply.length !== 2) {
      throw new StoreError(`RedisBudgetStore: unexpected script reply ${JSON.stringify(reply)}`);
    }
    return [String(reply[0]) === '1', Number(reply[1])];
  }

  async take(
    name: string,
    cost: number,
    policy: BudgetPolicy,
    now: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; retryInMs: number }> {
    const [ok, value] = await this.run(name, cost, policy, now);
    return ok ? { ok: true, remaining: value } : { ok: false, retryInMs: value };
  }

  async peek(name: string, policy: BudgetPolicy, now: number): Promise<number> {
    const [, remaining] = await this.run(name, 0, policy, now);
    return remaining;
  }

  /** Forget a bucket (tests, or when a budget is reconfigured). */
  async reset(name: string): Promise<void> {
    await this.client.del([this.bucketKey(name)]);
  }
}
