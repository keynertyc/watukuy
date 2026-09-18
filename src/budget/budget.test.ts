import { describe, expect, it } from 'vitest';
import { BudgetTimeoutError, ConfigError } from '../core/errors.ts';
import type { Clock } from '../core/ports.ts';
import type { BudgetPolicy } from '../core/store-types.ts';
import { type AcquireOptions, BudgetManager } from './manager.ts';
import { MemoryBudgetStore } from './memory-store.ts';
import { resolveBudgetPolicy } from './policy.ts';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Yield to the microtask queue enough times for the manager's take/grant chains to settle. */
async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Deterministic clock: timers are stored and fired only by `advance()`, in due order, with
 * microtasks flushed between them so promise chains triggered by one timer complete before the
 * next fires. No real timers are involved.
 */
class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.push({ id, at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  pending(): number {
    return this.#timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await flush();
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t.id !== due.id);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

/** Degenerate clock that jumps time forward and fires synchronously inside setTimeout. */
class SyncClock implements Clock {
  now_ = 0;
  now(): number {
    return this.now_;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.now_ += ms;
    fn();
    return 1;
  }
  clearTimeout(): void {}
}

const req = (requester: string, over: Partial<AcquireOptions> = {}): AcquireOptions => ({
  requester,
  weight: 1,
  lane: 'live',
  cost: 1,
  ...over,
});

/** Track settlement of a promise without unhandled-rejection noise. */
function track(p: Promise<void>): { done: () => boolean; error: () => unknown } {
  let done = false;
  let error: unknown;
  p.then(
    () => {
      done = true;
    },
    (e: unknown) => {
      done = true;
      error = e;
    },
  );
  return { done: () => done, error: () => error };
}

describe('resolveBudgetPolicy', () => {
  it('applies defaults and parses durations', () => {
    expect(resolveBudgetPolicy('erp', { requests: 100, per: '1m' })).toEqual({
      requests: 100,
      perMs: 60_000,
      burst: 100,
      fairness: 'round-robin',
      maxWaitMs: null,
    });
    expect(
      resolveBudgetPolicy('erp', {
        requests: 10,
        per: 500,
        burst: 3,
        fairness: 'weighted',
        maxWait: '2s',
      }),
    ).toEqual({ requests: 10, perMs: 500, burst: 3, fairness: 'weighted', maxWaitMs: 2_000 });
  });

  it('rejects invalid configs with ConfigError', () => {
    expect(() => resolveBudgetPolicy('x', { requests: 0, per: '1s' })).toThrow(ConfigError);
    expect(() => resolveBudgetPolicy('x', { requests: Number.NaN, per: '1s' })).toThrow(
      ConfigError,
    );
    expect(() => resolveBudgetPolicy('x', { requests: 1, per: '0s' })).toThrow(ConfigError);
    expect(() => resolveBudgetPolicy('x', { requests: 1, per: 'soon' as never })).toThrow(
      ConfigError,
    );
    expect(() => resolveBudgetPolicy('x', { requests: 1, per: '1s', burst: 0 })).toThrow(
      ConfigError,
    );
    expect(() =>
      resolveBudgetPolicy('x', { requests: 1, per: '1s', fairness: 'lottery' as never }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveBudgetPolicy('x', { requests: 1, per: '1s', maxWait: '-1s' as never }),
    ).toThrow(ConfigError);
    expect(() => resolveBudgetPolicy('', { requests: 1, per: '1s' })).toThrow(ConfigError);
    expect(() => resolveBudgetPolicy('x', null as never)).toThrow(ConfigError);
  });
});

describe('MemoryBudgetStore', () => {
  const policy: BudgetPolicy = { requests: 10, perMs: 1_000, burst: 3 };

  it('starts full, honours burst, then reports the exact refill wait', async () => {
    const store = new MemoryBudgetStore();
    expect(await store.take('b', 1, policy, 0)).toEqual({ ok: true, remaining: 2 });
    expect(await store.take('b', 1, policy, 0)).toEqual({ ok: true, remaining: 1 });
    expect(await store.take('b', 1, policy, 0)).toEqual({ ok: true, remaining: 0 });
    // 10 tokens per 1000 ms → one token every 100 ms.
    expect(await store.take('b', 1, policy, 0)).toEqual({ ok: false, retryInMs: 100 });
    expect(await store.take('b', 1, policy, 99)).toEqual({ ok: false, retryInMs: 1 });
    expect(await store.take('b', 1, policy, 100)).toEqual({ ok: true, remaining: 0 });
    expect(await store.take('b', 2, policy, 250)).toEqual({ ok: false, retryInMs: 50 });
    expect(await store.peek('b', policy, 250)).toBe(1.5);
    expect(await store.take('b', 2, policy, 300)).toEqual({ ok: true, remaining: 0 });
  });

  it('caps accumulated tokens at burst', async () => {
    const store = new MemoryBudgetStore();
    await store.take('b', 3, policy, 0);
    expect(await store.peek('b', policy, 100_000)).toBe(3);
    expect(await store.take('b', 3, policy, 100_000)).toEqual({ ok: true, remaining: 0 });
  });

  it('keeps buckets independent per name', async () => {
    const store = new MemoryBudgetStore();
    await store.take('a', 3, policy, 0);
    expect(await store.take('b', 1, policy, 0)).toEqual({ ok: true, remaining: 2 });
    expect(await store.take('a', 1, policy, 0)).toEqual({ ok: false, retryInMs: 100 });
  });

  it('cost 0 always succeeds and charges nothing', async () => {
    const store = new MemoryBudgetStore();
    await store.take('b', 3, policy, 0);
    expect(await store.take('b', 0, policy, 0)).toEqual({ ok: true, remaining: 0 });
    expect(await store.take('b', 0, policy, 50)).toEqual({ ok: true, remaining: 0.5 });
  });

  it('cost above burst waits a finite time as if capacity were cost', async () => {
    const store = new MemoryBudgetStore();
    // bucket holds 3; need 5 → 2 more tokens → 200 ms.
    expect(await store.take('b', 5, policy, 0)).toEqual({ ok: false, retryInMs: 200 });
    expect(await store.take('b', 5, policy, 199)).toEqual({ ok: false, retryInMs: 1 });
    expect(await store.take('b', 5, policy, 200)).toEqual({ ok: true, remaining: 0 });
    // afterwards a normal take clamps back to burst
    expect(await store.take('b', 1, policy, 10_000)).toEqual({ ok: true, remaining: 2 });
  });

  it('is exact with fractional rates (1 request per 3 ms)', async () => {
    const store = new MemoryBudgetStore();
    const p: BudgetPolicy = { requests: 1, perMs: 3, burst: 1 };
    expect(await store.take('c', 1, p, 0)).toEqual({ ok: true, remaining: 0 });
    expect(await store.take('c', 1, p, 1)).toEqual({ ok: false, retryInMs: 2 });
    expect(await store.take('c', 1, p, 2)).toEqual({ ok: false, retryInMs: 1 });
    expect(await store.take('c', 1, p, 3)).toEqual({ ok: true, remaining: 0 });
  });

  it('ignores a clock that moves backwards', async () => {
    const store = new MemoryBudgetStore();
    await store.take('b', 3, policy, 1_000);
    expect(await store.take('b', 1, policy, 500)).toEqual({ ok: false, retryInMs: 100 });
    expect(await store.peek('b', policy, 1_100)).toBe(1);
  });

  it('clear() forgets buckets', async () => {
    const store = new MemoryBudgetStore();
    await store.take('b', 3, policy, 0);
    store.clear();
    expect(await store.peek('b', policy, 0)).toBe(3);
  });
});

describe('BudgetManager', () => {
  function setup(
    budgets: ConstructorParameters<typeof BudgetManager>[0]['budgets'],
    hooks?: ConstructorParameters<typeof BudgetManager>[0]['hooks'],
  ) {
    const clock = new FakeClock(1_000_000);
    const store = new MemoryBudgetStore();
    const manager = new BudgetManager({ budgets, store, clock, ...(hooks ? { hooks } : {}) });
    return { clock, store, manager };
  }

  it('has() and unknown budgets', async () => {
    const { manager } = setup({ erp: { requests: 1, per: '1s' } });
    expect(manager.has('erp')).toBe(true);
    expect(manager.has('nope')).toBe(false);
    expect(() => manager.acquire('nope', req('a'))).toThrow(ConfigError);
    expect(() => manager.peek('nope')).toThrow(ConfigError);
    expect(() => manager.policy('nope')).toThrow(ConfigError);
    expect(manager.waiting('nope')).toBe(0);
    expect(manager.policy('erp').perMs).toBe(1_000);
    expect(() => manager.acquire('erp', req('a', { cost: -1 }))).toThrow(ConfigError);
    expect(() => manager.acquire('erp', req('a', { weight: 0 }))).toThrow(ConfigError);
    expect(
      () =>
        new BudgetManager({
          budgets: { bad: { requests: 0, per: '1s' } },
          store: new MemoryBudgetStore(),
          clock: new FakeClock(),
        }),
    ).toThrow(ConfigError);
  });

  it('grants immediately while tokens are available and never calls onBudgetWait', async () => {
    const waits: unknown[] = [];
    const { manager, clock } = setup(
      { erp: { requests: 2, per: '1s' } },
      {
        onBudgetWait: (info) => waits.push(info),
      },
    );
    await manager.acquire('erp', req('a'));
    await manager.acquire('erp', req('b'));
    expect(await manager.peek('erp')).toBe(0);
    expect(manager.waiting('erp')).toBe(0);
    expect(waits).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('cost 0 is granted immediately even when the budget is empty', async () => {
    const { manager } = setup({ erp: { requests: 1, per: '1s' } });
    await manager.acquire('erp', req('a'));
    await manager.acquire('erp', req('a', { cost: 0 }));
    expect(manager.waiting('erp')).toBe(0);
  });

  it('waits for refill with a single wake-up and reports the actual wait', async () => {
    const waits: Array<{ budget: string; requester: string; waitMs: number }> = [];
    const { manager, clock } = setup(
      { erp: { requests: 1, per: '1s' } },
      {
        onBudgetWait: (info) => waits.push(info),
      },
    );
    await manager.acquire('erp', req('a'));
    const t = track(manager.acquire('erp', req('a/1')));
    await flush();
    expect(t.done()).toBe(false);
    expect(manager.waiting('erp')).toBe(1);
    expect(clock.pending()).toBe(1);

    await clock.advance(999);
    expect(t.done()).toBe(false);
    await clock.advance(1);
    expect(t.done()).toBe(true);
    expect(t.error()).toBeUndefined();
    expect(manager.waiting('erp')).toBe(0);
    expect(clock.pending()).toBe(0);
    expect(waits).toEqual([{ budget: 'erp', requester: 'a/1', waitMs: 1_000 }]);
  });

  it('round-robin alternates between requesters sharing a budget', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '1s' } });
    const order: string[] = [];
    const enqueue = (who: string) => manager.acquire('erp', req(who)).then(() => order.push(who));
    // A floods the queue first, B joins later; B must still get every other token.
    const all = [
      enqueue('A'),
      enqueue('A'),
      enqueue('A'),
      enqueue('B'),
      enqueue('B'),
      enqueue('B'),
    ];
    await flush();
    expect(order).toEqual(['A']);
    for (let i = 0; i < 5; i++) await clock.advance(1_000);
    await Promise.all(all);
    expect(order).toEqual(['A', 'B', 'A', 'B', 'A', 'B']);
  });

  it('weighted fairness serves a weight-3 requester about 3x more often', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '100ms', fairness: 'weighted' } });
    const counts = { heavy: 0, light: 0 };
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      pending.push(
        manager.acquire('erp', req('heavy', { weight: 3 })).then(() => counts.heavy++),
        manager.acquire('erp', req('light', { weight: 1 })).then(() => counts.light++),
      );
    }
    await flush();
    for (let i = 0; i < 59; i++) await clock.advance(100);
    expect(counts.heavy + counts.light).toBe(60);
    expect(counts.heavy).toBeGreaterThanOrEqual(42);
    expect(counts.heavy).toBeLessThanOrEqual(48);
    expect(manager.waiting('erp')).toBe(60);
    // Drain the rest so no promise is left dangling.
    for (let i = 0; i < 60; i++) await clock.advance(100);
    await Promise.all(pending);
    expect(counts.heavy).toBe(60);
    expect(counts.light).toBe(60);
  });

  it('lane priority: live and reconcile jump ahead of backfill and replay', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '1s' } });
    await manager.acquire('erp', req('x'));
    const order: string[] = [];
    const go = (who: string, lane: AcquireOptions['lane']) =>
      manager.acquire('erp', req(who, { lane })).then(() => order.push(who));
    const all = [
      go('replay', 'replay'),
      go('backfill', 'backfill'),
      go('live', 'live'),
      go('reconcile', 'reconcile'),
    ];
    await flush();
    expect(order).toEqual([]);
    for (let i = 0; i < 4; i++) await clock.advance(1_000);
    await Promise.all(all);
    expect(order).toEqual(['live', 'reconcile', 'backfill', 'replay']);
  });

  it('rejects with BudgetTimeoutError when the policy maxWait is exceeded', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '1s', maxWait: '400ms' } });
    await manager.acquire('erp', req('a'));
    const t = track(manager.acquire('erp', req('b')));
    await clock.advance(399);
    expect(t.done()).toBe(false);
    await clock.advance(1);
    expect(t.done()).toBe(true);
    const err = t.error();
    expect(err).toBeInstanceOf(BudgetTimeoutError);
    expect((err as BudgetTimeoutError).budget).toBe('erp');
    expect((err as BudgetTimeoutError).message).toContain('400ms');
    expect(manager.waiting('erp')).toBe(0);
    // The refill wake-up is cancelled once nobody waits.
    await clock.advance(1_000);
    expect(clock.pending()).toBe(0);
  });

  it('maxWaitMs option overrides the policy, and null waits without bound', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '1s', maxWait: '400ms' } });
    await manager.acquire('erp', req('a'));
    const unbounded = track(manager.acquire('erp', req('b', { maxWaitMs: null })));
    await clock.advance(500);
    expect(unbounded.done()).toBe(false);
    await clock.advance(500);
    expect(unbounded.done()).toBe(true);
    expect(unbounded.error()).toBeUndefined();

    const short = track(manager.acquire('erp', req('c', { maxWaitMs: 100 })));
    await clock.advance(100);
    expect(short.done()).toBe(true);
    expect(short.error()).toBeInstanceOf(BudgetTimeoutError);

    // maxWaitMs 0: fail fast when no token is available, without a timer round-trip.
    const zero = track(manager.acquire('erp', req('d', { maxWaitMs: 0 })));
    await flush();
    expect(zero.done()).toBe(true);
    expect(zero.error()).toBeInstanceOf(BudgetTimeoutError);
  });

  it('a timed-out waiter does not block the ones behind it', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '1s' } });
    await manager.acquire('erp', req('a'));
    const first = track(manager.acquire('erp', req('b', { maxWaitMs: 300 })));
    const second = track(manager.acquire('erp', req('c')));
    await clock.advance(300);
    expect(first.error()).toBeInstanceOf(BudgetTimeoutError);
    expect(second.done()).toBe(false);
    await clock.advance(700);
    expect(second.done()).toBe(true);
    expect(second.error()).toBeUndefined();
  });

  it('abort via AbortSignal rejects with the reason and frees the slot', async () => {
    const { manager, clock } = setup({ erp: { requests: 1, per: '1s' } });
    await manager.acquire('erp', req('a'));

    const pre = new AbortController();
    pre.abort(new Error('already gone'));
    const preT = track(manager.acquire('erp', req('p', { signal: pre.signal })));
    await flush();
    expect((preT.error() as Error).message).toBe('already gone');
    expect(manager.waiting('erp')).toBe(0);

    const ctrl = new AbortController();
    const aborted = track(manager.acquire('erp', req('b', { signal: ctrl.signal })));
    const next = track(manager.acquire('erp', req('c')));
    await flush();
    expect(manager.waiting('erp')).toBe(2);
    ctrl.abort();
    await flush();
    expect(aborted.done()).toBe(true);
    expect((aborted.error() as Error).name).toBe('AbortError');
    expect(manager.waiting('erp')).toBe(1);

    await clock.advance(1_000);
    expect(next.done()).toBe(true);
    expect(next.error()).toBeUndefined();

    const custom = new AbortController();
    const withReason = track(manager.acquire('erp', req('d', { signal: custom.signal })));
    await flush();
    custom.abort('stopping');
    await flush();
    expect(withReason.error()).toBe('stopping');
  });

  it('onBudgetWait fires only for requests that actually waited', async () => {
    const waits: Array<{ requester: string; waitMs: number }> = [];
    const { manager, clock } = setup(
      { erp: { requests: 2, per: '1s' } },
      {
        onBudgetWait: ({ requester, waitMs }) => waits.push({ requester, waitMs }),
      },
    );
    await manager.acquire('erp', req('instant-1'));
    await manager.acquire('erp', req('instant-2'));
    const slow = track(manager.acquire('erp', req('slow')));
    await clock.advance(500);
    expect(slow.done()).toBe(true);
    expect(waits).toEqual([{ requester: 'slow', waitMs: 500 }]);
    for (const w of waits) expect(w.waitMs).toBeGreaterThan(0);
  });

  it('swallows exceptions thrown by hooks', async () => {
    const { manager, clock } = setup(
      { erp: { requests: 1, per: '1s' } },
      {
        onBudgetWait: () => {
          throw new Error('hook boom');
        },
      },
    );
    await manager.acquire('erp', req('a'));
    const t = track(manager.acquire('erp', req('b')));
    await clock.advance(1_000);
    expect(t.done()).toBe(true);
    expect(t.error()).toBeUndefined();
  });

  it('rejects the waiter when the store throws and keeps serving others', async () => {
    let failNext = false;
    const inner = new MemoryBudgetStore();
    const store = {
      take: (...args: Parameters<MemoryBudgetStore['take']>) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('redis down'));
        }
        return inner.take(...args);
      },
      peek: (...args: Parameters<MemoryBudgetStore['peek']>) => inner.peek(...args),
    };
    const clock = new FakeClock();
    const manager = new BudgetManager({
      budgets: { erp: { requests: 5, per: '1s' } },
      store,
      clock,
    });
    failNext = true;
    const broken = track(manager.acquire('erp', req('a')));
    const fine = track(manager.acquire('erp', req('b')));
    await flush();
    expect((broken.error() as Error).message).toBe('redis down');
    expect(fine.done()).toBe(true);
    expect(fine.error()).toBeUndefined();
  });

  it('copes with a clock that fires timers synchronously inside setTimeout', async () => {
    const clock = new SyncClock();
    const store = new MemoryBudgetStore();
    const manager = new BudgetManager({
      budgets: { erp: { requests: 1, per: '1s' } },
      store,
      clock,
    });
    await manager.acquire('erp', req('a'));
    await manager.acquire('erp', req('a'));
    await manager.acquire('erp', req('a'));
    expect(clock.now()).toBe(2_000);
    expect(manager.waiting('erp')).toBe(0);
  });

  it('budgets are independent of each other', async () => {
    const { manager } = setup({ a: { requests: 1, per: '1s' }, b: { requests: 1, per: '1s' } });
    await manager.acquire('a', req('x'));
    await manager.acquire('b', req('x'));
    const t = track(manager.acquire('a', req('x')));
    await flush();
    expect(t.done()).toBe(false);
    expect(manager.waiting('a')).toBe(1);
    expect(manager.waiting('b')).toBe(0);
  });
});
