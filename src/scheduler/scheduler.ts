import type { RateLimitInfo, SerializedError } from '../core/errors.ts';
import type { PollSummary, ResolvedPoller } from '../core/poller-types.ts';
import type { Random } from '../core/ports.ts';
import type { ScheduleState } from '../core/store-types.ts';

/**
 * Adaptive scheduler (see docs/how-it-works.md). Every function here is pure: it reads a {@link ScheduleState},
 * never mutates it, and returns a fresh one. The engine persists the result per
 * `(poller, partition)` so daemon mode, `tick()` and multiple instances all agree on the plan.
 */

/** Multiplier applied to the interval after an idle cycle (no events, or HTTP 304). */
const GROWTH_FACTOR = 1.5;
/** Divisor applied to the interval after a cycle that produced events. */
const SPEED_UP_DIVISOR = 2;

/** The slice of a {@link ResolvedPoller} the scheduler needs. */
export interface SchedulerConfig {
  schedule: ResolvedPoller['schedule'];
  circuit: ResolvedPoller['circuit'];
}

/** Injected time and randomness so every decision is reproducible under test. */
export interface SchedulerDeps {
  /** Current epoch milliseconds. */
  now: number;
  random: Random;
}

/**
 * Short human-readable label explaining why the schedule changed. Fed to the
 * `onScheduleChange` hook.
 *
 * - `events:speed-up`: the cycle produced events, interval halved.
 * - `idle:back-off`: no events, interval grew by 1.5x.
 * - `not-modified`: HTTP 304, treated as idle.
 * - `fixed`: `schedule.adaptive` is `false`, interval pinned to `min`.
 * - `catch-up`: `maxPagesPerCycle` was hit with more data; due immediately.
 * - `paced`: `RateLimit` headers stretched the wait so remaining requests last until reset.
 * - `throttled`: 429 / 503 with `Retry-After`, sleeping exactly as instructed.
 * - `backoff`: a fetch error, exponential backoff with full jitter.
 * - `circuit-open`: consecutive failures reached `circuit.failures`, next run is a probe.
 * - `probe-failed`: a half-open probe failed, circuit stays open until the next probe.
 */
export type ScheduleReason =
  | 'events:speed-up'
  | 'idle:back-off'
  | 'not-modified'
  | 'fixed'
  | 'catch-up'
  | 'paced'
  | 'throttled'
  | 'backoff'
  | 'circuit-open'
  | 'probe-failed';

/** What a completed (non-throwing) poll cycle tells the scheduler. */
export interface SuccessOutcome {
  /** At least one event was emitted this cycle. */
  hadEvents: boolean;
  /** The API answered 304 Not Modified. Counts as idle. */
  notModified: boolean;
  /** `maxPagesPerCycle` stopped the cycle with more data available. */
  truncated: boolean;
  /** Latest parsed `RateLimit` headers, or `null` when the API advertises none. */
  rateLimit: RateLimitInfo | null;
  /** Summary to persist as `lastPoll`. When omitted the previous summary is kept. */
  summary?: PollSummary | null | undefined;
}

export interface SuccessResult {
  state: ScheduleState;
  /** `true` when the circuit transitioned from `open`/`half-open` to `closed`. Emit `onCircuitClose`. */
  circuitClosed: boolean;
  reason: ScheduleReason;
}

/** What a failed poll cycle tells the scheduler. */
export interface FailureOutcome {
  error: SerializedError;
  /** Parsed `Retry-After` in milliseconds, when the API sent one. */
  retryAfterMs?: number | undefined;
  /** `true` for 429, or 503 with `Retry-After` (see `HttpError.isThrottle`). Not counted as a failure. */
  isThrottle: boolean;
  /** Rate-limit headers on the error response, if any. `undefined` keeps the stored value. */
  rateLimit?: RateLimitInfo | null | undefined;
}

export interface FailureResult {
  state: ScheduleState;
  /** `true` when the circuit just opened. Emit `onCircuitOpen` with `probeAt = state.nextDueAt`. */
  circuitOpened: boolean;
  reason: ScheduleReason;
}

/**
 * Fresh state for a `(poller, partition)` seen for the first time: due immediately, interval at
 * `schedule.min`, circuit closed, no history.
 *
 * @example
 * const state = initialScheduleState(clock.now(), { schedule: poller.schedule, circuit: poller.circuit });
 * isDue(state, clock.now()); // true
 */
export function initialScheduleState(now: number, cfg: SchedulerConfig): ScheduleState {
  return {
    nextDueAt: now,
    intervalMs: cfg.schedule.minMs,
    consecutiveFailures: 0,
    circuit: 'closed',
    circuitOpenedAt: null,
    throttledUntil: null,
    rateLimit: null,
    lastPollAt: null,
    lastPoll: null,
    lastError: null,
  };
}

/**
 * Apply symmetric jitter: `interval * (1 + u * jitter)` with `u` uniform in `[-1, 1)`.
 * Result is rounded to whole milliseconds and never negative.
 *
 * @example
 * jittered(10_000, 0.1, random); // somewhere in [9_000, 11_000]
 * jittered(10_000, 0, random);   // 10_000
 */
export function jittered(intervalMs: number, jitter: number, random: Random): number {
  if (!(jitter > 0)) return Math.max(0, Math.round(intervalMs));
  const u = random.next() * 2 - 1;
  return Math.max(0, Math.round(intervalMs * (1 + u * jitter)));
}

/**
 * Exponential backoff delay for the given 1-based attempt:
 * `min(maxMs, baseMs * factor^(attempt - 1))`, then full jitter (uniform in `[0, delay]`) unless
 * `mode` is `'none'`.
 *
 * @example
 * backoffDelay(1, { baseMs: 1000, factor: 2, maxMs: 600_000 }, random, 'none'); // 1000
 * backoffDelay(3, { baseMs: 1000, factor: 2, maxMs: 600_000 }, random, 'none'); // 4000
 * backoffDelay(3, { baseMs: 1000, factor: 2, maxMs: 600_000 }, random);         // [0, 4000]
 */
export function backoffDelay(
  attempt: number,
  backoff: { baseMs: number; factor: number; maxMs: number },
  random: Random,
  mode: 'full' | 'none' = 'full',
): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = backoff.baseMs * backoff.factor ** (n - 1);
  const capped = Math.max(0, Math.min(backoff.maxMs, raw));
  if (mode === 'none') return Math.round(capped);
  return Math.round(random.next() * capped);
}

/**
 * Proactive rate-limit pacing (see docs/how-it-works.md). When the API advertises `remaining` and `resetAt`,
 * space requests so the remaining ones last until the window resets:
 * `spacing = (resetAt - now) / max(remaining, 1)`; with `remaining === 0` wait for the reset.
 * Returns `max(intervalMs, spacing)`, never negative. Ignored when `resetAt` is in the past or
 * either field is missing.
 *
 * @example
 * applyPacing(1_000, { remaining: 10, resetAt: now + 60_000, source: 'ietf' }, now); // 6_000
 * applyPacing(1_000, { remaining: 0, resetAt: now + 60_000, source: 'ietf' }, now);  // 60_000
 * applyPacing(1_000, null, now);                                                      // 1_000
 */
export function applyPacing(
  intervalMs: number,
  rateLimit: RateLimitInfo | null,
  now: number,
): number {
  const base = Math.max(0, intervalMs);
  if (rateLimit === null) return base;
  const { remaining, resetAt } = rateLimit;
  if (typeof remaining !== 'number' || typeof resetAt !== 'number') return base;
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return base;
  const window = resetAt - now;
  if (window <= 0) return base;
  const spacing = remaining <= 0 ? window : window / Math.max(remaining, 1);
  return Math.max(base, Math.ceil(spacing));
}

/**
 * Plan the next run after a successful cycle.
 *
 * AIMD: events halve the interval (floored at `min`); idle cycles, including 304s, grow it by
 * 1.5x (capped at `max`). With `schedule.adaptive: false` the interval stays at `min`. Jitter is
 * applied to the wait, then rate-limit pacing may stretch it further. A truncated cycle
 * (`maxPagesPerCycle` hit) is due again immediately, leaving the AIMD interval untouched, but still
 * honours pacing so catch-up never races into a 429.
 *
 * Also: resets `consecutiveFailures`, closes the circuit (reporting `circuitClosed` when it was
 * open or half-open), clears `throttledUntil` and `lastError`, records `lastPollAt` and
 * `rateLimit`. `lastPollAt`/`lastPoll` describe the last *completed* poll; failures leave them as is.
 *
 * @example
 * const { state: next, reason } = afterSuccess(state, cfg, { now, random }, {
 *   hadEvents: true, notModified: false, truncated: false, rateLimit: null, summary,
 * });
 * // reason === 'events:speed-up', next.intervalMs === max(min, state.intervalMs / 2)
 */
export function afterSuccess(
  state: ScheduleState,
  cfg: SchedulerConfig,
  deps: SchedulerDeps,
  outcome: SuccessOutcome,
): SuccessResult {
  const { schedule } = cfg;
  const { now, random } = deps;
  const previous = clamp(state.intervalMs ?? schedule.minMs, schedule.minMs, schedule.maxMs);
  const idle = outcome.notModified || !outcome.hadEvents;

  let intervalMs: number;
  let reason: ScheduleReason;
  if (outcome.truncated) {
    intervalMs = previous;
    reason = 'catch-up';
  } else if (!schedule.adaptive) {
    intervalMs = schedule.minMs;
    reason = 'fixed';
  } else if (idle) {
    intervalMs = Math.min(schedule.maxMs, Math.round(previous * GROWTH_FACTOR));
    reason = outcome.notModified ? 'not-modified' : 'idle:back-off';
  } else {
    intervalMs = Math.max(schedule.minMs, Math.round(previous / SPEED_UP_DIVISOR));
    reason = 'events:speed-up';
  }

  const baseWait = outcome.truncated ? 0 : jittered(intervalMs, schedule.jitter, random);
  const wait = applyPacing(baseWait, outcome.rateLimit, now);
  if (wait > baseWait) reason = 'paced';

  const circuitClosed = state.circuit !== 'closed';
  return {
    state: {
      ...state,
      nextDueAt: now + wait,
      intervalMs,
      consecutiveFailures: 0,
      circuit: 'closed',
      circuitOpenedAt: null,
      throttledUntil: null,
      rateLimit: outcome.rateLimit,
      lastPollAt: now,
      lastPoll: outcome.summary ?? state.lastPoll,
      lastError: null,
    },
    circuitClosed,
    reason,
  };
}

/**
 * Plan the next run after a failed cycle.
 *
 * - Throttle (429 / 503 with `Retry-After`): sleep exactly `retryAfterMs` (or one interval when
 *   the header is missing), record `throttledUntil`, do **not** count a failure, leave the circuit
 *   untouched.
 * - Other errors: `consecutiveFailures + 1`, exponential backoff with full jitter. When the count
 *   reaches `circuit.failures` and the circuit is closed, it opens and the next run
 *   (`now + probeEveryMs`) is a half-open probe; `circuitOpened` is `true` exactly once. A failed
 *   probe keeps the circuit open and schedules the next probe.
 *
 * `lastError` is always recorded.
 *
 * @example
 * const { state: next, circuitOpened } = afterFailure(state, cfg, { now, random }, {
 *   error: serializeError(err), isThrottle: false,
 * });
 * if (circuitOpened) hooks.onCircuitOpen?.({ ...ctx, failures: next.consecutiveFailures, probeAt: next.nextDueAt! });
 */
export function afterFailure(
  state: ScheduleState,
  cfg: SchedulerConfig,
  deps: SchedulerDeps,
  outcome: FailureOutcome,
): FailureResult {
  const { now, random } = deps;
  const rateLimit = outcome.rateLimit === undefined ? state.rateLimit : outcome.rateLimit;

  if (outcome.isThrottle) {
    const fallback = clamp(
      state.intervalMs ?? cfg.schedule.minMs,
      cfg.schedule.minMs,
      cfg.schedule.maxMs,
    );
    const wait = Math.max(0, outcome.retryAfterMs ?? fallback);
    const until = now + wait;
    return {
      state: {
        ...state,
        nextDueAt: until,
        throttledUntil: until,
        rateLimit,
        lastError: outcome.error,
      },
      circuitOpened: false,
      reason: 'throttled',
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const throttledUntil =
    state.throttledUntil !== null && state.throttledUntil > now ? state.throttledUntil : null;
  const common: ScheduleState = {
    ...state,
    consecutiveFailures,
    throttledUntil,
    rateLimit,
    lastError: outcome.error,
  };

  if (state.circuit !== 'closed') {
    return {
      state: { ...common, circuit: 'open', nextDueAt: now + cfg.circuit.probeEveryMs },
      circuitOpened: false,
      reason: 'probe-failed',
    };
  }

  if (consecutiveFailures >= cfg.circuit.failures) {
    return {
      state: {
        ...common,
        circuit: 'open',
        circuitOpenedAt: now,
        nextDueAt: now + cfg.circuit.probeEveryMs,
      },
      circuitOpened: true,
      reason: 'circuit-open',
    };
  }

  const delay = backoffDelay(consecutiveFailures, cfg.schedule.backoff, random, 'full');
  return {
    state: { ...common, nextDueAt: now + delay },
    circuitOpened: false,
    reason: 'backoff',
  };
}

/**
 * `true` when the key should run now: `nextDueAt` has passed and no `Retry-After` window is
 * active. An `open` circuit is due once its probe time (`nextDueAt`) passes; the caller should
 * then call {@link beginProbe} and treat the run as a half-open probe.
 *
 * @example
 * if (isDue(state, clock.now())) run();
 */
export function isDue(state: ScheduleState, now: number): boolean {
  // A `null` nextDueAt only exists on rows created by a commit that crashed before the first
  // schedule save (see docs/how-it-works.md kill points K3..K5); treat it as due so the key never stalls.
  if (state.nextDueAt !== null && state.nextDueAt > now) return false;
  if (state.throttledUntil !== null && state.throttledUntil > now) return false;
  return true;
}

/**
 * Mark that a probe is starting: `open` becomes `half-open`. Other states are returned unchanged
 * (as a copy).
 */
export function beginProbe(state: ScheduleState): ScheduleState {
  return state.circuit === 'open' ? { ...state, circuit: 'half-open' } : { ...state };
}

/**
 * Milliseconds until the key is due: `0` when due now, `Infinity` when `nextDueAt` is `null`.
 * Accounts for an active `throttledUntil`.
 *
 * @example
 * clock.setTimeout(wake, timeUntilDue(state, clock.now()));
 */
export function timeUntilDue(state: ScheduleState, now: number): number {
  if (state.nextDueAt === null) return 0; // unscheduled rows are due now (see isDue)
  const due = Math.max(state.nextDueAt, state.throttledUntil ?? Number.NEGATIVE_INFINITY);
  return Math.max(0, due - now);
}

/**
 * Force the key to be due now (`engine.trigger()`). Clears any `Retry-After` window; an open
 * circuit stays open, so the forced run is a probe.
 */
export function makeDue(state: ScheduleState, now: number): ScheduleState {
  return { ...state, nextDueAt: now, throttledUntil: null };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
