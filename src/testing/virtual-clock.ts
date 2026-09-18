import type { Clock } from '../core/ports.ts';

interface VirtualTimer {
  /** Handle returned by `setTimeout`; also the insertion sequence, so equal due times fire FIFO. */
  readonly id: number;
  readonly dueAt: number;
  readonly fn: () => void;
}

/** Default start: a fixed instant so tests never depend on the wall clock. */
const DEFAULT_START = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/** Microtask rounds a `flush()` performs when no explicit count is given. */
const DEFAULT_FLUSH_ROUNDS = 20;

/** Guard for `runAll()`: more fired timers than this means something reschedules itself forever. */
const DEFAULT_MAX_TIMERS = 10_000;

function toMs(value: number | string | Date, label: string): number {
  const ms =
    typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`${label} must be a finite timestamp, got ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * A deterministic {@link Clock} for tests: time only moves when you tell it to, and timers fire
 * in due-time order (FIFO for equal due times) as you `advance()`.
 *
 * After every fired timer the clock flushes microtasks, so promise chains started by a timer
 * callback settle (and any timers they schedule are queued) before the next timer fires.
 * Timers scheduled during an advance that fall inside the window fire in that same advance.
 *
 * @example
 * const clock = new VirtualClock('2026-01-01T00:00:00Z');
 * const fired: string[] = [];
 * clock.setTimeout(() => fired.push('b'), 200);
 * clock.setTimeout(() => fired.push('a'), 100);
 * await clock.advance(150);   // fired = ['a'], now = start + 150ms
 * await clock.advance(50);    // fired = ['a', 'b'], now = start + 200ms
 * clock.iso();                // '2026-01-01T00:00:00.200Z'
 */
export class VirtualClock implements Clock {
  #now: number;
  #seq = 0;
  /** Sorted by `(dueAt, id)` ascending; the head is always the next timer to fire. */
  #timers: VirtualTimer[] = [];

  /**
   * @param start Initial time as epoch milliseconds, ISO string, or `Date`.
   * @default '2026-01-01T00:00:00Z'
   */
  constructor(start: number | string | Date = DEFAULT_START) {
    this.#now = toMs(start, 'start');
  }

  /** Current virtual time in epoch milliseconds. */
  now(): number {
    return this.#now;
  }

  /** ISO 8601 string of {@link now}. Handy for `updatedAt`-style fixtures. */
  iso(): string {
    return new Date(this.#now).toISOString();
  }

  /**
   * Schedule `fn` to run once virtual time reaches `now() + ms`. Negative or non-finite delays
   * are treated as `0`. Returns an opaque handle for {@link clearTimeout}.
   *
   * @example
   * const handle = clock.setTimeout(() => console.log('tick'), 1_000);
   * clock.clearTimeout(handle); // never fires
   */
  setTimeout(fn: () => void, ms: number): unknown {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const timer: VirtualTimer = { id: ++this.#seq, dueAt: this.#now + delay, fn };
    this.#insert(timer);
    return timer.id;
  }

  /** Cancel a timer created by {@link setTimeout}. Unknown or already-fired handles are ignored. */
  clearTimeout(handle: unknown): void {
    if (typeof handle !== 'number') return;
    const index = this.#timers.findIndex((t) => t.id === handle);
    if (index !== -1) this.#timers.splice(index, 1);
  }

  /**
   * Advance virtual time by `ms`, firing every timer due within the window in due-time order.
   * Microtasks are flushed after each fired timer so promise chains settle before the next one.
   * Timers scheduled during the advance that fall inside the window fire too. Ends with
   * `now() === start + ms` even when no timer fired.
   *
   * @throws {RangeError} when `ms` is negative or not finite.
   * @example
   * clock.setTimeout(async () => {
   *   await save();                             // promise chain settles...
   *   clock.setTimeout(() => done = true, 10);  // ...and this nested timer still fires below
   * }, 50);
   * await clock.advance(100); // done === true
   */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance() requires a non-negative finite number of ms, got ${ms}`);
    }
    await this.#runUntil(this.#now + ms);
  }

  /**
   * Advance virtual time to an absolute instant (epoch ms, ISO string, or `Date`), firing due
   * timers along the way. Time never moves backwards.
   *
   * @throws {RangeError} when the target is before {@link now} or not a valid timestamp.
   * @example
   * await clock.advanceTo('2026-01-01T06:00:00Z');
   */
  async advanceTo(timestamp: number | string | Date): Promise<void> {
    const target = toMs(timestamp, 'advanceTo() target');
    if (target < this.#now) {
      throw new RangeError(
        `advanceTo() cannot move backwards: now is ${this.iso()}, target is ${new Date(target).toISOString()}`,
      );
    }
    await this.#runUntil(target);
  }

  /**
   * Fire the next due timer regardless of how far away it is, moving `now()` to its due time,
   * then flush microtasks. Returns `false` (and leaves time untouched) when nothing is pending.
   *
   * @example
   * let steps = 0;
   * while (await clock.runNext()) steps++; // step through every scheduled timer
   */
  async runNext(): Promise<boolean> {
    const timer = this.#timers.shift();
    if (!timer) return false;
    await this.#fire(timer);
    return true;
  }

  /**
   * Fire timers until none remain. Guards against self-rescheduling loops: throws once more than
   * `maxTimers` timers have fired.
   *
   * @param maxTimers Upper bound on fired timers. @default 10_000
   * @throws {Error} when the bound is exceeded.
   * @example
   * await clock.runAll(); // drains every pending timer, including ones scheduled meanwhile
   */
  async runAll(maxTimers: number = DEFAULT_MAX_TIMERS): Promise<void> {
    let fired = 0;
    while (this.#timers.length > 0) {
      if (fired >= maxTimers) {
        throw new Error(
          `VirtualClock.runAll() fired ${maxTimers} timers and ${this.#timers.length} are still pending; a timer keeps rescheduling itself`,
        );
      }
      await this.runNext();
      fired++;
    }
  }

  /**
   * Let pending microtasks (settled promises, `queueMicrotask` callbacks) run without moving time.
   * Each round drains one generation of the microtask queue, so a chain of `n` sequential awaits
   * needs about `n` rounds.
   *
   * @param rounds Microtask generations to drain. @default 20
   * @example
   * void engine.tick();      // kicks off async work
   * await clock.flush();     // let it settle without advancing time
   */
  async flush(rounds: number = DEFAULT_FLUSH_ROUNDS): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  /** Number of timers waiting to fire. */
  pendingTimers(): number {
    return this.#timers.length;
  }

  /** Due time (epoch ms) of the next timer, or `null` when none is pending. */
  nextDueAt(): number | null {
    return this.#timers[0]?.dueAt ?? null;
  }

  async #runUntil(target: number): Promise<void> {
    for (;;) {
      const head = this.#timers[0];
      if (!head || head.dueAt > target) break;
      this.#timers.shift();
      await this.#fire(head);
    }
    this.#now = target;
    await this.flush();
  }

  async #fire(timer: VirtualTimer): Promise<void> {
    if (timer.dueAt > this.#now) this.#now = timer.dueAt;
    timer.fn();
    await this.flush();
  }

  /** Binary-search insert keeping `(dueAt, id)` order; new timers go after existing equals. */
  #insert(timer: VirtualTimer): void {
    let lo = 0;
    let hi = this.#timers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = this.#timers[mid] as VirtualTimer;
      if (other.dueAt <= timer.dueAt) lo = mid + 1;
      else hi = mid;
    }
    this.#timers.splice(lo, 0, timer);
  }
}
