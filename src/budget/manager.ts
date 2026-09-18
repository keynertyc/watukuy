import type { BudgetConfig } from '../core/engine-types.ts';
import { BudgetTimeoutError, ConfigError } from '../core/errors.ts';
import type { Lane } from '../core/poller-types.ts';
import type { Clock } from '../core/ports.ts';
import type { RateBudgetStore } from '../core/store-types.ts';
import { type ResolvedBudgetPolicy, resolveBudgetPolicy } from './policy.ts';

/** Options for {@link BudgetManager.acquire}. */
export interface AcquireOptions {
  /** Who is asking, `${poller}/${partition}`. Fairness is computed per requester. */
  requester: string;
  /** Share for `fairness: 'weighted'` (the poller's `budgetWeight`). Must be `> 0`. */
  weight: number;
  /** Lane priority: live > reconcile > backfill > replay. */
  lane: Lane;
  /** Tokens to take. `0` is granted immediately without queueing. */
  cost: number;
  /** Abort the wait. Rejects with `signal.reason` (or an `AbortError`). */
  signal?: AbortSignal | undefined;
  /** Overrides the policy's `maxWaitMs`. `null` waits without bound. */
  maxWaitMs?: number | null | undefined;
}

/** Payload of {@link BudgetManagerHooks.onBudgetWait}. */
export interface BudgetWaitInfo {
  budget: string;
  requester: string;
  /** How long the requester actually waited before being granted. Always `> 0`. */
  waitMs: number;
}

export interface BudgetManagerHooks {
  /** Called once per granted request that had to wait. Errors thrown here are swallowed. */
  onBudgetWait?(info: BudgetWaitInfo): void;
}

export interface BudgetManagerDeps {
  budgets: Record<string, BudgetConfig>;
  store: RateBudgetStore;
  clock: Clock;
  hooks?: BudgetManagerHooks | undefined;
}

const LANE_RANK: Record<Lane, number> = { live: 0, reconcile: 1, backfill: 2, replay: 3 };

interface Waiter {
  readonly seq: number;
  readonly requester: string;
  readonly weight: number;
  readonly lane: Lane;
  readonly cost: number;
  readonly enqueuedAt: number;
  /** Absolute deadline, or `null` for an unbounded wait. */
  readonly deadlineAt: number | null;
  deadlineArmed: boolean;
  timeoutHandle: unknown;
  settled: boolean;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface ServedStats {
  count: number;
  weight: number;
  /** Grant sequence of the last grant, `-1` when never served. */
  lastSeq: number;
}

interface Entry {
  readonly name: string;
  readonly policy: ResolvedBudgetPolicy;
  readonly queue: Waiter[];
  readonly served: Map<string, ServedStats>;
  grantSeq: number;
  pumping: boolean;
  repump: boolean;
  wakeToken: object | null;
  wakeHandle: unknown;
}

/**
 * Coordinates many pollers sharing named rate budgets (PLAN §5.7).
 *
 * `acquire` resolves once tokens were taken from the {@link RateBudgetStore}. When a budget is
 * exhausted, waiters queue per budget and are granted as tokens refill, ordered by lane priority
 * (live > reconcile > backfill > replay), then by fairness: `'round-robin'` serves the requester
 * that was served least recently, `'weighted'` the one with the lowest `served / weight` ratio.
 * The head of the queue is never skipped, so an expensive request cannot be starved by cheap ones.
 *
 * No busy loop: after a failed take, exactly one wake-up is scheduled through `clock.setTimeout`
 * for the store's `retryInMs`; every grant immediately tries the next waiter. All timing goes
 * through the injected {@link Clock}, so tests drive it with a fake clock.
 *
 * @example
 * const budgets = new BudgetManager({ budgets: { erp: { requests: 60, per: '1m' } }, store, clock });
 * await budgets.acquire('erp', { requester: 'orders/', weight: 1, lane: 'live', cost: 1 });
 * // ...perform the HTTP request
 */
export class BudgetManager {
  readonly #entries = new Map<string, Entry>();
  readonly #store: RateBudgetStore;
  readonly #clock: Clock;
  readonly #hooks: BudgetManagerHooks | undefined;
  #waiterSeq = 0;

  constructor(deps: BudgetManagerDeps) {
    if (!deps.store) throw new ConfigError('BudgetManager requires a store');
    if (!deps.clock) throw new ConfigError('BudgetManager requires a clock');
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#hooks = deps.hooks;
    for (const [name, config] of Object.entries(deps.budgets ?? {})) {
      this.#entries.set(name, {
        name,
        policy: resolveBudgetPolicy(name, config),
        queue: [],
        served: new Map(),
        grantSeq: 0,
        pumping: false,
        repump: false,
        wakeToken: null,
        wakeHandle: null,
      });
    }
  }

  /** `true` when a budget with this name was declared. */
  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** Resolved policy of a budget. @throws {ConfigError} for an unknown name. */
  policy(name: string): ResolvedBudgetPolicy {
    return this.#entry(name).policy;
  }

  /**
   * Take `cost` tokens from `name`, waiting for refill when necessary.
   *
   * Rejects with `BudgetTimeoutError` when the wait exceeds `maxWaitMs` (option, else policy;
   * `null` waits without bound), and with `signal.reason` (or an `AbortError`) when aborted.
   *
   * @throws {ConfigError} synchronously for an unknown budget, a negative or non-finite `cost`,
   * or a non-positive `weight`.
   */
  acquire(name: string, opts: AcquireOptions): Promise<void> {
    const entry = this.#entry(name);
    if (typeof opts.cost !== 'number' || !Number.isFinite(opts.cost) || opts.cost < 0) {
      throw new ConfigError(`budget '${name}': cost must be a finite number >= 0`);
    }
    if (!(opts.weight > 0)) {
      throw new ConfigError(`budget '${name}': weight must be > 0`);
    }
    if (opts.cost === 0) return Promise.resolve();
    if (opts.signal?.aborted) {
      return Promise.reject(abortReason(opts.signal));
    }

    const now = this.#clock.now();
    const maxWaitMs = opts.maxWaitMs === undefined ? entry.policy.maxWaitMs : opts.maxWaitMs;
    const deadlineAt = maxWaitMs === null ? null : now + Math.max(0, maxWaitMs);

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        seq: ++this.#waiterSeq,
        requester: opts.requester,
        weight: opts.weight,
        lane: opts.lane,
        cost: opts.cost,
        enqueuedAt: now,
        deadlineAt,
        deadlineArmed: false,
        timeoutHandle: null,
        settled: false,
        signal: opts.signal,
        onAbort: undefined,
        resolve,
        reject,
      };
      entry.queue.push(waiter);
      if (opts.signal !== undefined) {
        waiter.onAbort = () => this.#abort(entry, waiter);
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      void this.#pump(entry);
    });
  }

  /** Tokens currently available in `name`, for metrics. @throws {ConfigError} for an unknown name. */
  peek(name: string): Promise<number> {
    const entry = this.#entry(name);
    return this.#store.peek(name, entry.policy, this.#clock.now());
  }

  /** Requests currently waiting on `name` (`0` for an unknown budget). */
  waiting(name: string): number {
    return this.#entries.get(name)?.queue.length ?? 0;
  }

  #entry(name: string): Entry {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new ConfigError(
        `unknown budget '${name}': declare it in createWatukuy({ budgets: { '${name}': { requests, per } } })`,
      );
    }
    return entry;
  }

  /**
   * Grant loop for one budget. Re-entrant calls (from a wake-up, a new waiter, or a removal) set
   * `repump` and return; the running loop notices and re-evaluates the queue before exiting.
   */
  async #pump(entry: Entry): Promise<void> {
    if (entry.pumping) {
      entry.repump = true;
      return;
    }
    entry.pumping = true;
    try {
      do {
        entry.repump = false;
        this.#cancelWake(entry);
        for (;;) {
          const waiter = this.#pick(entry);
          if (waiter === undefined) break;
          const now = this.#clock.now();
          let result: Awaited<ReturnType<RateBudgetStore['take']>>;
          try {
            result = await this.#store.take(entry.name, waiter.cost, entry.policy, now);
          } catch (err) {
            if (!waiter.settled) {
              this.#settle(entry, waiter);
              waiter.reject(err);
            }
            continue;
          }
          if (waiter.settled) {
            // Aborted or timed out while the store was working; tokens (if taken) are forfeited.
            continue;
          }
          if (result.ok) {
            this.#grant(entry, waiter);
            continue;
          }
          const grantedAt = this.#clock.now();
          this.#armDeadlines(entry, grantedAt);
          if (entry.queue.length > 0) {
            const retryInMs = Number.isFinite(result.retryInMs) ? result.retryInMs : 1_000;
            this.#scheduleWake(entry, Math.max(1, Math.ceil(retryInMs)));
          }
          break;
        }
      } while (entry.repump);
    } finally {
      entry.pumping = false;
    }
  }

  #pick(entry: Entry): Waiter | undefined {
    let best: Waiter | undefined;
    for (const candidate of entry.queue) {
      if (candidate.settled) continue;
      if (best === undefined || this.#compare(entry, candidate, best) < 0) best = candidate;
    }
    return best;
  }

  #compare(entry: Entry, a: Waiter, b: Waiter): number {
    const laneDelta = (LANE_RANK[a.lane] ?? 4) - (LANE_RANK[b.lane] ?? 4);
    if (laneDelta !== 0) return laneDelta;
    const sa = this.#stats(entry, a.requester, a.weight);
    const sb = this.#stats(entry, b.requester, b.weight);
    if (entry.policy.fairness === 'weighted') {
      const ratioDelta = sa.count / a.weight - sb.count / b.weight;
      if (ratioDelta !== 0) return ratioDelta;
    }
    if (sa.lastSeq !== sb.lastSeq) return sa.lastSeq - sb.lastSeq;
    return a.seq - b.seq;
  }

  /**
   * Per-requester bookkeeping. A requester seen for the first time starts at the lowest current
   * `served / weight` ratio (scaled by its own weight) so it cannot monopolise the budget while
   * "catching up" on history it was never part of.
   */
  #stats(entry: Entry, requester: string, weight: number): ServedStats {
    let stats = entry.served.get(requester);
    if (stats === undefined) {
      let minRatio = Number.POSITIVE_INFINITY;
      for (const other of entry.served.values()) {
        minRatio = Math.min(minRatio, other.count / other.weight);
      }
      const count = Number.isFinite(minRatio) ? Math.floor(minRatio * weight) : 0;
      stats = { count, weight, lastSeq: -1 };
      entry.served.set(requester, stats);
    } else {
      stats.weight = weight;
    }
    return stats;
  }

  #grant(entry: Entry, waiter: Waiter): void {
    this.#settle(entry, waiter);
    const stats = this.#stats(entry, waiter.requester, waiter.weight);
    stats.count += 1;
    stats.lastSeq = ++entry.grantSeq;
    const waitMs = Math.max(0, this.#clock.now() - waiter.enqueuedAt);
    waiter.resolve();
    if (waitMs > 0 && this.#hooks?.onBudgetWait) {
      try {
        this.#hooks.onBudgetWait({ budget: entry.name, requester: waiter.requester, waitMs });
      } catch {
        // Hooks never affect the engine (PLAN §5.13).
      }
    }
  }

  /** Detach a waiter from the queue and release its listeners/timers. Does not settle the promise. */
  #settle(entry: Entry, waiter: Waiter): void {
    waiter.settled = true;
    const index = entry.queue.indexOf(waiter);
    if (index !== -1) entry.queue.splice(index, 1);
    if (waiter.timeoutHandle !== null) {
      this.#clock.clearTimeout(waiter.timeoutHandle);
      waiter.timeoutHandle = null;
    }
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = undefined;
    }
  }

  #abort(entry: Entry, waiter: Waiter): void {
    if (waiter.settled) return;
    const reason = waiter.signal !== undefined ? abortReason(waiter.signal) : abortError();
    this.#settle(entry, waiter);
    waiter.reject(reason);
    void this.#pump(entry);
  }

  #expire(entry: Entry, waiter: Waiter): void {
    if (waiter.settled) return;
    this.#settle(entry, waiter);
    waiter.reject(
      new BudgetTimeoutError(entry.name, Math.max(0, this.#clock.now() - waiter.enqueuedAt)),
    );
    void this.#pump(entry);
  }

  /**
   * Deadlines are armed lazily, the first time a waiter is known to be stuck behind an exhausted
   * budget. A request granted on its first pass never touches a timer, and a clock that fires
   * timers synchronously cannot expire a waiter before it had a chance to be served.
   */
  #armDeadlines(entry: Entry, now: number): void {
    for (const waiter of [...entry.queue]) {
      if (waiter.settled || waiter.deadlineArmed || waiter.deadlineAt === null) continue;
      waiter.deadlineArmed = true;
      const delay = waiter.deadlineAt - now;
      if (delay <= 0) {
        this.#expire(entry, waiter);
        continue;
      }
      waiter.timeoutHandle = this.#clock.setTimeout(() => this.#expire(entry, waiter), delay);
    }
  }

  /**
   * One pending wake-up per budget. The token guards against a clock that invokes the callback
   * synchronously from inside `setTimeout` and against stale callbacks after a cancel.
   */
  #scheduleWake(entry: Entry, ms: number): void {
    this.#cancelWake(entry);
    const token = {};
    entry.wakeToken = token;
    const handle = this.#clock.setTimeout(() => {
      if (entry.wakeToken !== token) return;
      entry.wakeToken = null;
      entry.wakeHandle = null;
      void this.#pump(entry);
    }, ms);
    if (entry.wakeToken === token) entry.wakeHandle = handle;
  }

  #cancelWake(entry: Entry): void {
    if (entry.wakeHandle !== null) this.#clock.clearTimeout(entry.wakeHandle);
    entry.wakeHandle = null;
    entry.wakeToken = null;
  }
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason === undefined ? abortError() : reason;
}

/** A `DOMException` named `AbortError` where available, else a plain `Error` with that name. */
function abortError(): Error {
  const ctor = (globalThis as { DOMException?: new (message?: string, name?: string) => Error })
    .DOMException;
  if (typeof ctor === 'function') return new ctor('budget acquire aborted', 'AbortError');
  const err = new Error('budget acquire aborted');
  err.name = 'AbortError';
  return err;
}
