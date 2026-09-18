import { describe, expect, it } from 'vitest';
import type { RateLimitInfo, SerializedError } from '../core/errors.ts';
import type { PollSummary } from '../core/poller-types.ts';
import type { Random } from '../core/ports.ts';
import type { ScheduleState } from '../core/store-types.ts';
import {
  afterFailure,
  afterSuccess,
  applyPacing,
  backoffDelay,
  beginProbe,
  initialScheduleState,
  isDue,
  jittered,
  makeDue,
  type SchedulerConfig,
  timeUntilDue,
} from './scheduler.ts';

/** mulberry32: tiny seeded PRNG in [0, 1). */
function seeded(seed: number): Random {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** A Random that always returns `v`. `0.5` makes symmetric jitter a no-op. */
const fixed = (v: number): Random => ({ next: () => v });

const NOW = 1_700_000_000_000;

const cfg: SchedulerConfig = {
  schedule: {
    minMs: 1_000,
    maxMs: 60_000,
    adaptive: true,
    jitter: 0.1,
    backoff: { baseMs: 1_000, factor: 2, maxMs: 600_000 },
  },
  circuit: { failures: 3, probeEveryMs: 30_000 },
};

const noJitter: SchedulerConfig = {
  ...cfg,
  schedule: { ...cfg.schedule, jitter: 0 },
};

const deps = (now = NOW, random: Random = fixed(0.5)) => ({ now, random });

const error: SerializedError = { name: 'HttpError', message: 'GET /x responded 500', status: 500 };

const summary: PollSummary = {
  lane: 'live',
  startedAt: NOW - 50,
  durationMs: 50,
  pages: 1,
  items: 3,
  events: { created: 3, updated: 0, deleted: 0 },
  notModified: false,
  truncated: false,
};

const ok = (over: Partial<Parameters<typeof afterSuccess>[3]> = {}) => ({
  hadEvents: false,
  notModified: false,
  truncated: false,
  rateLimit: null,
  ...over,
});

function withInterval(intervalMs: number, over: Partial<ScheduleState> = {}): ScheduleState {
  return { ...initialScheduleState(NOW, cfg), intervalMs, ...over };
}

describe('initialScheduleState', () => {
  it('is due immediately at min interval with a closed circuit', () => {
    const s = initialScheduleState(NOW, cfg);
    expect(s).toEqual({
      nextDueAt: NOW,
      intervalMs: 1_000,
      consecutiveFailures: 0,
      circuit: 'closed',
      circuitOpenedAt: null,
      throttledUntil: null,
      rateLimit: null,
      lastPollAt: null,
      lastPoll: null,
      lastError: null,
    });
    expect(isDue(s, NOW)).toBe(true);
  });
});

describe('AIMD', () => {
  it('halves the interval after a cycle with events and floors at min', () => {
    const r1 = afterSuccess(withInterval(8_000), noJitter, deps(), ok({ hadEvents: true }));
    expect(r1.state.intervalMs).toBe(4_000);
    expect(r1.state.nextDueAt).toBe(NOW + 4_000);
    expect(r1.reason).toBe('events:speed-up');

    const r2 = afterSuccess(withInterval(1_500), noJitter, deps(), ok({ hadEvents: true }));
    expect(r2.state.intervalMs).toBe(1_000);
  });

  it('grows the interval by 1.5x when idle and caps at max', () => {
    const r1 = afterSuccess(withInterval(4_000), noJitter, deps(), ok());
    expect(r1.state.intervalMs).toBe(6_000);
    expect(r1.state.nextDueAt).toBe(NOW + 6_000);
    expect(r1.reason).toBe('idle:back-off');

    const r2 = afterSuccess(withInterval(50_000), noJitter, deps(), ok());
    expect(r2.state.intervalMs).toBe(60_000);
  });

  it('treats 304 Not Modified as idle', () => {
    const r = afterSuccess(withInterval(2_000), noJitter, deps(), ok({ notModified: true }));
    expect(r.state.intervalMs).toBe(3_000);
    expect(r.reason).toBe('not-modified');
  });

  it('keeps the interval at min when adaptive is false', () => {
    const fixedCfg: SchedulerConfig = {
      ...noJitter,
      schedule: { ...noJitter.schedule, adaptive: false },
    };
    const idle = afterSuccess(withInterval(1_000), fixedCfg, deps(), ok());
    expect(idle.state.intervalMs).toBe(1_000);
    expect(idle.reason).toBe('fixed');
    const busy = afterSuccess(idle.state, fixedCfg, deps(), ok({ hadEvents: true }));
    expect(busy.state.intervalMs).toBe(1_000);
    expect(busy.state.nextDueAt).toBe(NOW + 1_000);
  });

  it('falls back to min when the stored interval is null and clamps out-of-range values', () => {
    const r = afterSuccess(withInterval(1_000, { intervalMs: null }), noJitter, deps(), ok());
    expect(r.state.intervalMs).toBe(1_500);
    const huge = afterSuccess(withInterval(500_000), noJitter, deps(), ok({ hadEvents: true }));
    expect(huge.state.intervalMs).toBe(30_000);
  });
});

describe('jitter', () => {
  it('stays within +/- jitter over 1000 seeded samples and actually varies', () => {
    const random = seeded(42);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 1_000; i++) {
      const v = jittered(10_000, 0.1, random);
      expect(v).toBeGreaterThanOrEqual(9_000);
      expect(v).toBeLessThanOrEqual(11_000);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeLessThan(9_500);
    expect(hi).toBeGreaterThan(10_500);
  });

  it('is exact with jitter 0 and applies to nextDueAt in afterSuccess', () => {
    expect(jittered(10_000, 0, seeded(1))).toBe(10_000);
    const random = seeded(7);
    for (let i = 0; i < 200; i++) {
      const r = afterSuccess(withInterval(4_000), cfg, deps(NOW, random), ok());
      const wait = (r.state.nextDueAt as number) - NOW;
      expect(wait).toBeGreaterThanOrEqual(5_400);
      expect(wait).toBeLessThanOrEqual(6_600);
      expect(r.state.intervalMs).toBe(6_000);
    }
  });
});

describe('catch-up', () => {
  it('is due now when truncated, without changing the AIMD interval', () => {
    const r = afterSuccess(
      withInterval(8_000),
      cfg,
      deps(NOW, seeded(3)),
      ok({ hadEvents: true, truncated: true }),
    );
    expect(r.state.nextDueAt).toBe(NOW);
    expect(r.state.intervalMs).toBe(8_000);
    expect(r.reason).toBe('catch-up');
    expect(isDue(r.state, NOW)).toBe(true);
  });

  it('still honours rate-limit pacing while catching up', () => {
    const rateLimit: RateLimitInfo = { remaining: 0, resetAt: NOW + 5_000, source: 'ietf' };
    const r = afterSuccess(withInterval(8_000), cfg, deps(), ok({ truncated: true, rateLimit }));
    expect(r.state.nextDueAt).toBe(NOW + 5_000);
    expect(r.reason).toBe('paced');
  });
});

describe('applyPacing', () => {
  const rl = (remaining: number, resetIn: number): RateLimitInfo => ({
    remaining,
    resetAt: NOW + resetIn,
    source: 'ietf',
  });

  it('stretches the interval so remaining requests last until reset', () => {
    expect(applyPacing(1_000, rl(10, 60_000), NOW)).toBe(6_000);
    expect(applyPacing(1_000, rl(7, 60_000), NOW)).toBe(Math.ceil(60_000 / 7));
  });

  it('waits until reset when remaining is 0', () => {
    expect(applyPacing(1_000, rl(0, 60_000), NOW)).toBe(60_000);
    expect(applyPacing(1_000, rl(-3, 60_000), NOW)).toBe(60_000);
  });

  it('never shortens the interval', () => {
    expect(applyPacing(10_000, rl(100, 60_000), NOW)).toBe(10_000);
  });

  it('ignores missing fields, past resets and null', () => {
    expect(applyPacing(1_000, null, NOW)).toBe(1_000);
    expect(applyPacing(1_000, { source: 'ietf' }, NOW)).toBe(1_000);
    expect(applyPacing(1_000, { remaining: 5, source: 'ietf' }, NOW)).toBe(1_000);
    expect(applyPacing(1_000, rl(0, -1), NOW)).toBe(1_000);
    expect(applyPacing(-5, null, NOW)).toBe(0);
  });

  it('is applied by afterSuccess and reported as paced', () => {
    const r = afterSuccess(
      withInterval(1_000),
      noJitter,
      deps(),
      ok({ rateLimit: rl(10, 60_000) }),
    );
    expect(r.state.nextDueAt).toBe(NOW + 6_000);
    expect(r.state.intervalMs).toBe(1_500);
    expect(r.state.rateLimit).toEqual(rl(10, 60_000));
    expect(r.reason).toBe('paced');
  });
});

describe('afterSuccess bookkeeping', () => {
  it('resets failures, closes the circuit, clears throttle and error, records the poll', () => {
    const before = withInterval(2_000, {
      consecutiveFailures: 2,
      circuit: 'half-open',
      circuitOpenedAt: NOW - 90_000,
      throttledUntil: NOW + 1,
      lastError: error,
    });
    const r = afterSuccess(before, noJitter, deps(), ok({ hadEvents: true, summary }));
    expect(r.circuitClosed).toBe(true);
    expect(r.state.consecutiveFailures).toBe(0);
    expect(r.state.circuit).toBe('closed');
    expect(r.state.circuitOpenedAt).toBeNull();
    expect(r.state.throttledUntil).toBeNull();
    expect(r.state.lastError).toBeNull();
    expect(r.state.lastPollAt).toBe(NOW);
    expect(r.state.lastPoll).toBe(summary);
  });

  it('reports circuitClosed false when it was already closed and keeps lastPoll when no summary', () => {
    const before = withInterval(2_000, { lastPoll: summary });
    const r = afterSuccess(before, noJitter, deps(), ok());
    expect(r.circuitClosed).toBe(false);
    expect(r.state.lastPoll).toBe(summary);
    const r2 = afterSuccess(before, noJitter, deps(), ok({ summary: null }));
    expect(r2.state.lastPoll).toBe(summary);
  });
});

describe('throttle', () => {
  it('sleeps exactly Retry-After, records throttledUntil and does not count a failure', () => {
    const before = withInterval(2_000, { consecutiveFailures: 1 });
    const r = afterFailure(before, cfg, deps(), { error, isThrottle: true, retryAfterMs: 7_000 });
    expect(r.state.nextDueAt).toBe(NOW + 7_000);
    expect(r.state.throttledUntil).toBe(NOW + 7_000);
    expect(r.state.consecutiveFailures).toBe(1);
    expect(r.state.circuit).toBe('closed');
    expect(r.state.lastError).toBe(error);
    expect(r.circuitOpened).toBe(false);
    expect(r.reason).toBe('throttled');
    expect(isDue(r.state, NOW + 6_999)).toBe(false);
    expect(isDue(r.state, NOW + 7_000)).toBe(true);
  });

  it('falls back to one interval when Retry-After is missing and keeps the circuit as is', () => {
    const before = withInterval(2_000, { circuit: 'half-open', consecutiveFailures: 3 });
    const r = afterFailure(before, cfg, deps(), { error, isThrottle: true });
    expect(r.state.nextDueAt).toBe(NOW + 2_000);
    expect(r.state.circuit).toBe('half-open');
    expect(r.state.consecutiveFailures).toBe(3);
  });

  it('records rate-limit headers from the error response when provided', () => {
    const rateLimit: RateLimitInfo = { remaining: 0, resetAt: NOW + 9_000, source: 'legacy' };
    const r = afterFailure(withInterval(2_000), cfg, deps(), {
      error,
      isThrottle: true,
      retryAfterMs: 9_000,
      rateLimit,
    });
    expect(r.state.rateLimit).toBe(rateLimit);
    const kept = afterFailure(r.state, cfg, deps(), { error, isThrottle: false });
    expect(kept.state.rateLimit).toBe(rateLimit);
  });
});

describe('backoffDelay', () => {
  const backoff = { baseMs: 1_000, factor: 2, maxMs: 10_000 };

  it('grows exponentially and caps at max without jitter', () => {
    expect(backoffDelay(1, backoff, seeded(1), 'none')).toBe(1_000);
    expect(backoffDelay(2, backoff, seeded(1), 'none')).toBe(2_000);
    expect(backoffDelay(3, backoff, seeded(1), 'none')).toBe(4_000);
    expect(backoffDelay(4, backoff, seeded(1), 'none')).toBe(8_000);
    expect(backoffDelay(5, backoff, seeded(1), 'none')).toBe(10_000);
    expect(backoffDelay(60, backoff, seeded(1), 'none')).toBe(10_000);
    expect(backoffDelay(0, backoff, seeded(1), 'none')).toBe(1_000);
  });

  it('full jitter stays within [0, delay] over 1000 samples and spreads', () => {
    const random = seeded(99);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 1_000; i++) {
      const v = backoffDelay(3, backoff, random);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(4_000);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeLessThan(500);
    expect(hi).toBeGreaterThan(3_500);
  });
});

describe('failures and circuit', () => {
  it('increments failures and schedules a jittered backoff', () => {
    const r1 = afterFailure(withInterval(2_000), cfg, deps(NOW, fixed(0.999)), {
      error,
      isThrottle: false,
    });
    expect(r1.state.consecutiveFailures).toBe(1);
    expect(r1.state.lastError).toBe(error);
    expect(r1.reason).toBe('backoff');
    expect(r1.circuitOpened).toBe(false);
    expect(r1.state.circuit).toBe('closed');
    expect((r1.state.nextDueAt as number) - NOW).toBeGreaterThanOrEqual(0);
    expect((r1.state.nextDueAt as number) - NOW).toBeLessThanOrEqual(1_000);

    const r2 = afterFailure(r1.state, cfg, deps(NOW, fixed(0.999)), { error, isThrottle: false });
    expect(r2.state.consecutiveFailures).toBe(2);
    expect((r2.state.nextDueAt as number) - NOW).toBeLessThanOrEqual(2_000);
    expect((r2.state.nextDueAt as number) - NOW).toBeGreaterThan(1_000);
  });

  it('opens the circuit at N failures and schedules the probe at probeEveryMs', () => {
    let s = withInterval(2_000);
    for (let i = 0; i < cfg.circuit.failures - 1; i++) {
      const r = afterFailure(s, cfg, deps(), { error, isThrottle: false });
      expect(r.circuitOpened).toBe(false);
      expect(r.state.circuit).toBe('closed');
      s = r.state;
    }
    const r = afterFailure(s, cfg, deps(), { error, isThrottle: false });
    expect(r.circuitOpened).toBe(true);
    expect(r.reason).toBe('circuit-open');
    expect(r.state.circuit).toBe('open');
    expect(r.state.circuitOpenedAt).toBe(NOW);
    expect(r.state.consecutiveFailures).toBe(cfg.circuit.failures);
    expect(r.state.nextDueAt).toBe(NOW + cfg.circuit.probeEveryMs);
    expect(isDue(r.state, NOW + cfg.circuit.probeEveryMs - 1)).toBe(false);
    expect(isDue(r.state, NOW + cfg.circuit.probeEveryMs)).toBe(true);
  });

  it('beginProbe moves open to half-open and leaves other states alone', () => {
    const open = withInterval(2_000, { circuit: 'open' });
    expect(beginProbe(open).circuit).toBe('half-open');
    expect(beginProbe(withInterval(2_000)).circuit).toBe('closed');
    expect(beginProbe(withInterval(2_000, { circuit: 'half-open' })).circuit).toBe('half-open');
  });

  it('a failed probe keeps the circuit open and schedules the next probe', () => {
    const probing = beginProbe(
      withInterval(2_000, {
        circuit: 'open',
        circuitOpenedAt: NOW - 30_000,
        consecutiveFailures: 3,
      }),
    );
    const later = NOW + 30_000;
    const r = afterFailure(probing, cfg, deps(later), { error, isThrottle: false });
    expect(r.circuitOpened).toBe(false);
    expect(r.reason).toBe('probe-failed');
    expect(r.state.circuit).toBe('open');
    expect(r.state.circuitOpenedAt).toBe(NOW - 30_000);
    expect(r.state.consecutiveFailures).toBe(4);
    expect(r.state.nextDueAt).toBe(later + cfg.circuit.probeEveryMs);
  });

  it('a successful probe closes the circuit and resets failures', () => {
    const probing = beginProbe(
      withInterval(2_000, {
        circuit: 'open',
        circuitOpenedAt: NOW - 30_000,
        consecutiveFailures: 5,
      }),
    );
    const r = afterSuccess(probing, noJitter, deps(), ok());
    expect(r.circuitClosed).toBe(true);
    expect(r.state.circuit).toBe('closed');
    expect(r.state.circuitOpenedAt).toBeNull();
    expect(r.state.consecutiveFailures).toBe(0);
  });

  it('clears a stale throttledUntil on a plain failure but keeps a future one', () => {
    const stale = withInterval(2_000, { throttledUntil: NOW - 1 });
    expect(
      afterFailure(stale, cfg, deps(), { error, isThrottle: false }).state.throttledUntil,
    ).toBe(null);
    const future = withInterval(2_000, { throttledUntil: NOW + 60_000 });
    expect(
      afterFailure(future, cfg, deps(), { error, isThrottle: false }).state.throttledUntil,
    ).toBe(NOW + 60_000);
  });
});

describe('isDue / timeUntilDue / makeDue', () => {
  it('isDue follows nextDueAt and throttledUntil', () => {
    expect(isDue(withInterval(1_000, { nextDueAt: null }), NOW)).toBe(false);
    expect(isDue(withInterval(1_000, { nextDueAt: NOW + 1 }), NOW)).toBe(false);
    expect(isDue(withInterval(1_000, { nextDueAt: NOW }), NOW)).toBe(true);
    expect(isDue(withInterval(1_000, { nextDueAt: NOW - 5 }), NOW)).toBe(true);
    expect(isDue(withInterval(1_000, { nextDueAt: NOW, throttledUntil: NOW + 1 }), NOW)).toBe(
      false,
    );
    expect(isDue(withInterval(1_000, { nextDueAt: NOW, throttledUntil: NOW }), NOW)).toBe(true);
  });

  it('timeUntilDue is 0 when due, Infinity when unscheduled, else the remaining wait', () => {
    expect(timeUntilDue(withInterval(1_000, { nextDueAt: NOW - 10 }), NOW)).toBe(0);
    expect(timeUntilDue(withInterval(1_000, { nextDueAt: null }), NOW)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(timeUntilDue(withInterval(1_000, { nextDueAt: NOW + 2_500 }), NOW)).toBe(2_500);
    expect(
      timeUntilDue(withInterval(1_000, { nextDueAt: NOW + 100, throttledUntil: NOW + 900 }), NOW),
    ).toBe(900);
  });

  it('makeDue forces nextDueAt to now and clears the throttle', () => {
    const s = withInterval(1_000, { nextDueAt: NOW + 50_000, throttledUntil: NOW + 50_000 });
    const d = makeDue(s, NOW);
    expect(d.nextDueAt).toBe(NOW);
    expect(d.throttledUntil).toBeNull();
    expect(isDue(d, NOW)).toBe(true);
    expect(timeUntilDue(d, NOW)).toBe(0);
  });
});

describe('immutability', () => {
  it('never mutates the input state and always returns a new object', () => {
    const input = Object.freeze(
      withInterval(4_000, {
        nextDueAt: NOW + 1_000,
        throttledUntil: NOW + 500,
        circuit: 'open',
        consecutiveFailures: 2,
      }),
    );
    const snapshot = structuredClone(input);
    const outputs: ScheduleState[] = [
      afterSuccess(input, cfg, deps(NOW, seeded(1)), ok({ hadEvents: true, summary })).state,
      afterSuccess(input, cfg, deps(), ok({ truncated: true })).state,
      afterFailure(input, cfg, deps(NOW, seeded(1)), { error, isThrottle: false }).state,
      afterFailure(input, cfg, deps(), { error, isThrottle: true, retryAfterMs: 10 }).state,
      beginProbe(input),
      makeDue(input, NOW),
    ];
    isDue(input, NOW);
    timeUntilDue(input, NOW);
    for (const out of outputs) expect(out).not.toBe(input);
    expect(input).toEqual(snapshot);
  });
});
