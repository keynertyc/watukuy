import { describe, expect, it } from 'vitest';
import type { Clock } from '../core/ports.ts';
import { composeAbortSignal, createTimeoutError } from './signal.ts';

function createFakeClock(start = 1_700_000_000_000): Clock & {
  advance(ms: number): void;
  pending(): number;
} {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

describe('createTimeoutError', () => {
  it('is named TimeoutError with the duration in the message', () => {
    const err = createTimeoutError(1500);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toBe('watukuy: request timed out after 1500ms');
  });
});

describe('composeAbortSignal', () => {
  it('returns undefined when there is nothing to compose', () => {
    const clock = createFakeClock();
    expect(composeAbortSignal({ clock })).toBeUndefined();
    expect(composeAbortSignal({ clock, signals: [undefined, undefined] })).toBeUndefined();
  });

  it('returns a single parent as-is when there is no timeout', () => {
    const clock = createFakeClock();
    const parent = new AbortController();
    const composed = composeAbortSignal({ clock, signals: [undefined, parent.signal] });
    expect(composed?.signal).toBe(parent.signal);
    expect(() => composed?.dispose()).not.toThrow();
  });

  it('aborts with a TimeoutError when the clock reaches the timeout', () => {
    const clock = createFakeClock();
    const composed = composeAbortSignal({ clock, timeoutMs: 5000 })!;
    expect(composed.signal.aborted).toBe(false);
    clock.advance(4999);
    expect(composed.signal.aborted).toBe(false);
    clock.advance(1);
    expect(composed.signal.aborted).toBe(true);
    const reason = composed.signal.reason as Error;
    expect(reason.name).toBe('TimeoutError');
    expect(reason.message).toContain('5000ms');
  });

  it('dispose clears the pending timer and is idempotent', () => {
    const clock = createFakeClock();
    const composed = composeAbortSignal({ clock, timeoutMs: 1000 });
    expect(clock.pending()).toBe(1);
    composed?.dispose();
    composed?.dispose();
    expect(clock.pending()).toBe(0);
    clock.advance(5000);
    expect(composed?.signal.aborted).toBe(false);
  });

  for (const useAny of [true, false]) {
    describe(`useAny=${useAny}`, () => {
      it('propagates a parent abort with its reason', () => {
        const clock = createFakeClock();
        const a = new AbortController();
        const b = new AbortController();
        const composed = composeAbortSignal({
          clock,
          signals: [a.signal, b.signal],
          timeoutMs: 10_000,
          useAny,
        });
        const reason = new Error('cycle aborted');
        b.abort(reason);
        expect(composed?.signal.aborted).toBe(true);
        expect(composed?.signal.reason).toBe(reason);
      });

      it('is aborted immediately when a parent is already aborted', () => {
        const clock = createFakeClock();
        const parent = new AbortController();
        parent.abort('early');
        const composed = composeAbortSignal({
          clock,
          signals: [parent.signal],
          timeoutMs: 10,
          useAny,
        });
        expect(composed?.signal.aborted).toBe(true);
        expect(composed?.signal.reason).toBe('early');
      });
    });
  }

  it('detaches parent listeners on dispose (manual path)', () => {
    const clock = createFakeClock();
    const parent = new AbortController();
    const composed = composeAbortSignal({
      clock,
      signals: [parent.signal],
      timeoutMs: 10,
      useAny: false,
    });
    composed?.dispose();
    parent.abort();
    expect(composed?.signal.aborted).toBe(false);
  });
});
