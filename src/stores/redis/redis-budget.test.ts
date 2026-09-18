import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryBudgetStore } from '../../budget/memory-store.ts';
import type { BudgetPolicy, RateBudgetStore } from '../../core/store-types.ts';
import { RedisBudgetStore } from './redis-budget.ts';
import { clientCases, startRedis, type TestClient } from './redis-test-harness.ts';

const redis = await startRedis();

const TEN_PER_SECOND: BudgetPolicy = { requests: 10, perMs: 1_000, burst: 10 };
const T0 = 1_700_000_000_000;

describe.skipIf(redis === null)('RedisBudgetStore', () => {
  afterAll(async () => {
    await redis?.stop();
  });

  describe.each(clientCases)('with %s', (_name, connect) => {
    let client: TestClient;
    let budgets: RedisBudgetStore;

    beforeAll(async () => {
      client = await connect(redis!.url);
    });
    afterAll(async () => {
      await client.close();
    });
    beforeEach(async () => {
      await client.flush();
      budgets = new RedisBudgetStore({ client: client.raw });
    });

    it('starts full, deducts, and reports the wait until enough tokens accrue', async () => {
      expect(await budgets.take('erp', 10, TEN_PER_SECOND, T0)).toEqual({ ok: true, remaining: 0 });
      expect(await budgets.take('erp', 1, TEN_PER_SECOND, T0)).toEqual({
        ok: false,
        retryInMs: 100,
      });
      expect(await budgets.take('erp', 1, TEN_PER_SECOND, T0 + 99)).toEqual({
        ok: false,
        retryInMs: 1,
      });
      expect(await budgets.take('erp', 1, TEN_PER_SECOND, T0 + 100)).toEqual({
        ok: true,
        remaining: 0,
      });
    });

    it('refills at requests/perMs and caps at burst', async () => {
      expect(await budgets.take('erp', 10, TEN_PER_SECOND, T0)).toEqual({ ok: true, remaining: 0 });
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0 + 250)).toBe(2.5);
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0 + 60_000)).toBe(10);
      expect(await budgets.take('erp', 4, TEN_PER_SECOND, T0 + 60_000)).toEqual({
        ok: true,
        remaining: 6,
      });
    });

    it('never lets a stale clock add tokens', async () => {
      await budgets.take('erp', 10, TEN_PER_SECOND, T0 + 1000);
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0)).toBe(0);
      expect(await budgets.take('erp', 1, TEN_PER_SECOND, T0 - 5000)).toEqual({
        ok: false,
        retryInMs: 100,
      });
    });

    it('cost 0 always succeeds and charges nothing', async () => {
      expect(await budgets.take('erp', 0, TEN_PER_SECOND, T0)).toEqual({ ok: true, remaining: 10 });
      await budgets.take('erp', 10, TEN_PER_SECOND, T0);
      expect(await budgets.take('erp', 0, TEN_PER_SECOND, T0)).toEqual({ ok: true, remaining: 0 });
      expect(await budgets.take('erp', -3, TEN_PER_SECOND, T0)).toEqual({ ok: true, remaining: 0 });
    });

    it('serves a cost above burst once the extra tokens accrue, then clamps back', async () => {
      expect(await budgets.take('erp', 15, TEN_PER_SECOND, T0)).toEqual({
        ok: false,
        retryInMs: 500,
      });
      expect(await budgets.take('erp', 15, TEN_PER_SECOND, T0 + 500)).toEqual({
        ok: true,
        remaining: 0,
      });
      await budgets.take('erp', 0, TEN_PER_SECOND, T0 + 500);
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0 + 5_000)).toBe(10);
    });

    it('handles fractional rates with the same rounding as the memory store', async () => {
      const slow: BudgetPolicy = { requests: 3, perMs: 1_000, burst: 3 };
      expect(await budgets.take('s', 1, slow, T0)).toEqual({ ok: true, remaining: 2 });
      expect(await budgets.take('s', 3, slow, T0)).toEqual({ ok: false, retryInMs: 334 });
      expect(await budgets.take('s', 3, slow, T0 + 333)).toEqual({ ok: false, retryInMs: 1 });
      expect(await budgets.take('s', 3, slow, T0 + 334)).toMatchObject({ ok: true });
    });

    it('peek refreshes the bucket but does not deduct', async () => {
      await budgets.take('erp', 5, TEN_PER_SECOND, T0);
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0)).toBe(5);
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0)).toBe(5);
      expect(await budgets.peek('erp', TEN_PER_SECOND, T0 + 100)).toBe(6);
      expect(await budgets.take('erp', 6, TEN_PER_SECOND, T0 + 100)).toEqual({
        ok: true,
        remaining: 0,
      });
    });

    it('keeps names, prefixes and instances independent, and reset() forgets a bucket', async () => {
      const other = new RedisBudgetStore({ client: client.raw, prefix: 'other:' });
      const shared = new RedisBudgetStore({ client: client.raw });
      await budgets.take('a', 10, TEN_PER_SECOND, T0);
      expect(await budgets.peek('b', TEN_PER_SECOND, T0)).toBe(10);
      expect(await other.peek('a', TEN_PER_SECOND, T0)).toBe(10);
      // Same prefix + same Redis = the same bucket, which is the whole point.
      expect(await shared.peek('a', TEN_PER_SECOND, T0)).toBe(0);
      expect(await client.keys('watukuy:budget:*')).toEqual(
        expect.arrayContaining(['watukuy:budget:a', 'watukuy:budget:b']),
      );
      await budgets.reset('a');
      expect(await budgets.peek('a', TEN_PER_SECOND, T0)).toBe(10);
    });

    it('produces exactly the same results as MemoryBudgetStore over a mixed sequence', async () => {
      const memory = new MemoryBudgetStore();
      const policies: BudgetPolicy[] = [
        TEN_PER_SECOND,
        { requests: 7, perMs: 3_000, burst: 20 },
        { requests: 100, perMs: 60_000, burst: 100 },
        { requests: 1, perMs: 250, burst: 1 },
      ];
      // Deterministic pseudo-random walk (LCG) so the sequence is reproducible.
      let seed = 42;
      const rnd = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      let now = T0;
      const run = async (s: RateBudgetStore, name: string, cost: number, p: BudgetPolicy) =>
        cost < 0 ? s.peek(name, p, now) : s.take(name, cost, p, now);

      for (let i = 0; i < 120; i++) {
        const policy = policies[i % policies.length]!;
        const name = `b${i % policies.length}`;
        // Occasionally step backwards to exercise the stale-clock branch.
        now += rnd() < 0.1 ? -Math.floor(rnd() * 50) : Math.floor(rnd() * 400);
        const cost = rnd() < 0.15 ? -1 : Math.floor(rnd() * 6) + (rnd() < 0.2 ? 0.5 : 0);
        const expected = await run(memory, name, cost, policy);
        const actual = await run(budgets, name, cost, policy);
        expect(actual, `step ${i} name=${name} cost=${cost} now=${now}`).toEqual(expected);
      }
    });
  });
});
