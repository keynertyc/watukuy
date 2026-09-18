import type { BudgetPolicy, RateBudgetStore } from '../core/store-types.ts';

/**
 * Bucket contents are kept scaled by `perMs` (token-milliseconds). With integer `requests`,
 * `perMs`, `cost` and `now`, every operation is exact integer arithmetic, so refill math has no
 * floating-point drift.
 */
interface Bucket {
  scaled: number;
  updatedAt: number;
}

/** Tolerance for fractional costs / fractional clocks. */
const EPSILON = 1e-9;

/**
 * In-memory token bucket per budget name (PLAN §5.7). Entirely driven by the `now` argument:
 * no `Date.now()`, no timers, so it is deterministic under a fake clock.
 *
 * Semantics:
 * - A bucket starts full (`burst` tokens) the first time its name is seen.
 * - Refill rate is `requests / perMs` tokens per millisecond, capped at `burst`.
 * - `take` succeeds when at least `cost` tokens are available and deducts them; otherwise it
 *   reports `retryInMs`, the time until `cost` tokens will have accumulated.
 * - `cost <= 0` always succeeds and charges nothing.
 * - `cost > burst` would never fit in the bucket. For that call the capacity is treated as `cost`,
 *   so `retryInMs` is finite and the caller is served once the extra tokens accrue. The next
 *   smaller take clamps the bucket back to `burst`. Prefer `burst >= cost` in configuration.
 *
 * @example
 * const store = new MemoryBudgetStore();
 * const policy = { requests: 10, perMs: 1_000, burst: 10 };
 * await store.take('erp', 10, policy, 0);   // { ok: true, remaining: 0 }
 * await store.take('erp', 1, policy, 0);    // { ok: false, retryInMs: 100 }
 * await store.take('erp', 1, policy, 100);  // { ok: true, remaining: 0 }
 */
export class MemoryBudgetStore implements RateBudgetStore {
  readonly #buckets = new Map<string, Bucket>();

  take(
    name: string,
    cost: number,
    policy: BudgetPolicy,
    now: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; retryInMs: number }> {
    if (!(cost > 0)) {
      const bucket = this.#refill(name, policy, now, policy.burst);
      return Promise.resolve({ ok: true, remaining: bucket.scaled / policy.perMs });
    }
    const capacity = Math.max(policy.burst, cost);
    const bucket = this.#refill(name, policy, now, capacity);
    const need = cost * policy.perMs;
    if (bucket.scaled + EPSILON >= need) {
      bucket.scaled = Math.max(0, bucket.scaled - need);
      return Promise.resolve({ ok: true, remaining: bucket.scaled / policy.perMs });
    }
    const deficit = need - bucket.scaled;
    const retryInMs = Math.max(1, Math.ceil(deficit / policy.requests - EPSILON));
    return Promise.resolve({ ok: false, retryInMs });
  }

  peek(name: string, policy: BudgetPolicy, now: number): Promise<number> {
    return Promise.resolve(this.#refill(name, policy, now, policy.burst).scaled / policy.perMs);
  }

  /** Forget every bucket (tests, or when budgets are reconfigured). */
  clear(): void {
    this.#buckets.clear();
  }

  #refill(name: string, policy: BudgetPolicy, now: number, capacityTokens: number): Bucket {
    const cap = capacityTokens * policy.perMs;
    let bucket = this.#buckets.get(name);
    if (bucket === undefined) {
      bucket = { scaled: Math.min(cap, policy.burst * policy.perMs), updatedAt: now };
      this.#buckets.set(name, bucket);
      return bucket;
    }
    const elapsed = now - bucket.updatedAt;
    if (elapsed > 0) {
      bucket.scaled = Math.min(cap, bucket.scaled + elapsed * policy.requests);
      bucket.updatedAt = now;
    } else if (bucket.scaled > cap) {
      bucket.scaled = cap;
    }
    return bucket;
  }
}
