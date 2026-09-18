import { describe, expect, it } from 'vitest';
import { VirtualClock } from './virtual-clock.ts';

const START = Date.UTC(2026, 0, 1);

describe('VirtualClock', () => {
  describe('construction and now()', () => {
    it('defaults to 2026-01-01T00:00:00Z', () => {
      const clock = new VirtualClock();
      expect(clock.now()).toBe(START);
      expect(clock.iso()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('accepts epoch ms, ISO strings and Date instances', () => {
      expect(new VirtualClock(1_000).now()).toBe(1_000);
      expect(new VirtualClock('2030-06-15T12:30:00Z').now()).toBe(Date.UTC(2030, 5, 15, 12, 30));
      expect(new VirtualClock(new Date(5_000)).now()).toBe(5_000);
    });

    it('rejects invalid start values', () => {
      expect(() => new VirtualClock('not a date')).toThrow(RangeError);
      expect(() => new VirtualClock(Number.NaN)).toThrow(RangeError);
    });

    it('does not move on its own', async () => {
      const clock = new VirtualClock();
      await new Promise((r) => setTimeout(r, 5));
      expect(clock.now()).toBe(START);
    });
  });

  describe('setTimeout / advance ordering', () => {
    it('fires timers in due-time order regardless of scheduling order', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => fired.push('c'), 300);
      clock.setTimeout(() => fired.push('a'), 100);
      clock.setTimeout(() => fired.push('b'), 200);
      await clock.advance(300);
      expect(fired).toEqual(['a', 'b', 'c']);
    });

    it('keeps FIFO order for timers with equal due times', async () => {
      const clock = new VirtualClock();
      const fired: number[] = [];
      for (let i = 0; i < 5; i++) clock.setTimeout(() => fired.push(i), 100);
      await clock.advance(100);
      expect(fired).toEqual([0, 1, 2, 3, 4]);
    });

    it('places a later-scheduled timer after existing timers with the same due time', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => fired.push('first@100'), 100);
      clock.setTimeout(() => fired.push('at@50'), 50);
      clock.setTimeout(() => fired.push('second@100'), 100);
      await clock.advance(100);
      expect(fired).toEqual(['at@50', 'first@100', 'second@100']);
    });

    it('treats negative and non-finite delays as zero', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => fired.push('neg'), -50);
      clock.setTimeout(() => fired.push('nan'), Number.NaN);
      expect(clock.nextDueAt()).toBe(START);
      await clock.advance(0);
      expect(fired).toEqual(['neg', 'nan']);
    });

    it('only fires timers inside the window and lands exactly on the target', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => fired.push('in'), 100);
      clock.setTimeout(() => fired.push('edge'), 150);
      clock.setTimeout(() => fired.push('out'), 151);
      await clock.advance(150);
      expect(fired).toEqual(['in', 'edge']);
      expect(clock.now()).toBe(START + 150);
      expect(clock.pendingTimers()).toBe(1);
      await clock.advance(1);
      expect(fired).toEqual(['in', 'edge', 'out']);
    });

    it('sets now() to each timer due time while it runs', async () => {
      const clock = new VirtualClock();
      const seen: number[] = [];
      clock.setTimeout(() => seen.push(clock.now()), 30);
      clock.setTimeout(() => seen.push(clock.now()), 70);
      await clock.advance(100);
      expect(seen).toEqual([START + 30, START + 70]);
      expect(clock.now()).toBe(START + 100);
    });

    it('advance(0) fires timers that are already due', async () => {
      const clock = new VirtualClock();
      let fired = false;
      clock.setTimeout(() => {
        fired = true;
      }, 0);
      await clock.advance(0);
      expect(fired).toBe(true);
    });

    it('rejects negative or non-finite advances', async () => {
      const clock = new VirtualClock();
      await expect(clock.advance(-1)).rejects.toThrow(RangeError);
      await expect(clock.advance(Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
    });
  });

  describe('nested timers', () => {
    it('fires timers scheduled during an advance when they fall inside the window', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => {
        fired.push('outer');
        clock.setTimeout(() => fired.push('inner'), 20);
      }, 50);
      await clock.advance(100);
      expect(fired).toEqual(['outer', 'inner']);
    });

    it('does not fire nested timers that fall outside the window', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => {
        fired.push('outer');
        clock.setTimeout(() => fired.push('inner'), 60);
      }, 50);
      await clock.advance(100);
      expect(fired).toEqual(['outer']);
      expect(clock.pendingTimers()).toBe(1);
      expect(clock.nextDueAt()).toBe(START + 110);
    });

    it('interleaves nested timers with pre-existing ones by due time', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => fired.push('existing@70'), 70);
      clock.setTimeout(() => {
        fired.push('outer@50');
        clock.setTimeout(() => fired.push('nested@60'), 10);
        clock.setTimeout(() => fired.push('nested@80'), 30);
      }, 50);
      await clock.advance(100);
      expect(fired).toEqual(['outer@50', 'nested@60', 'existing@70', 'nested@80']);
    });

    it('handles a self-rescheduling interval within a single advance', async () => {
      const clock = new VirtualClock();
      const ticks: number[] = [];
      const tick = (): void => {
        ticks.push(clock.now() - START);
        clock.setTimeout(tick, 25);
      };
      clock.setTimeout(tick, 25);
      await clock.advance(100);
      expect(ticks).toEqual([25, 50, 75, 100]);
      expect(clock.pendingTimers()).toBe(1);
    });
  });

  describe('promise chains between timers', () => {
    it('lets a timer callback await before scheduling, and still fires the follow-up', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => {
        void (async () => {
          await Promise.resolve();
          await new Promise<void>((r) => queueMicrotask(r));
          fired.push('a-after-await');
          clock.setTimeout(() => fired.push('b'), 10);
        })();
      }, 10);
      await clock.advance(50);
      expect(fired).toEqual(['a-after-await', 'b']);
    });

    it('settles deep sequential await chains before the next timer fires', async () => {
      const clock = new VirtualClock();
      const order: string[] = [];
      const step = async (): Promise<void> => {
        await Promise.resolve();
      };
      clock.setTimeout(() => {
        void (async () => {
          for (let i = 0; i < 12; i++) await step();
          order.push('chain-done');
        })();
      }, 10);
      clock.setTimeout(() => order.push('next-timer'), 20);
      await clock.advance(20);
      expect(order).toEqual(['chain-done', 'next-timer']);
    });

    it('flush() drains microtasks without moving time', async () => {
      const clock = new VirtualClock();
      let settled = false;
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          settled = true;
        });
      await clock.flush();
      expect(settled).toBe(true);
      expect(clock.now()).toBe(START);
    });

    it('async callback chains that schedule timers work across multiple hops', async () => {
      const clock = new VirtualClock();
      const hops: number[] = [];
      const hop = (n: number): void => {
        void (async () => {
          await Promise.resolve();
          hops.push(n);
          if (n < 3) clock.setTimeout(() => hop(n + 1), 10);
        })();
      };
      clock.setTimeout(() => hop(1), 10);
      await clock.advance(30);
      expect(hops).toEqual([1, 2, 3]);
    });
  });

  describe('clearTimeout', () => {
    it('prevents a cleared timer from firing', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      const handle = clock.setTimeout(() => fired.push('cleared'), 10);
      clock.setTimeout(() => fired.push('kept'), 10);
      clock.clearTimeout(handle);
      expect(clock.pendingTimers()).toBe(1);
      await clock.advance(10);
      expect(fired).toEqual(['kept']);
    });

    it('ignores unknown, already-fired and non-numeric handles', async () => {
      const clock = new VirtualClock();
      const handle = clock.setTimeout(() => undefined, 10);
      await clock.advance(10);
      expect(() => clock.clearTimeout(handle)).not.toThrow();
      expect(() => clock.clearTimeout(undefined)).not.toThrow();
      expect(() => clock.clearTimeout({})).not.toThrow();
      expect(() => clock.clearTimeout(99_999)).not.toThrow();
    });

    it('can clear a timer from inside another timer callback', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      const later = clock.setTimeout(() => fired.push('later'), 20);
      clock.setTimeout(() => {
        fired.push('first');
        clock.clearTimeout(later);
      }, 10);
      await clock.advance(50);
      expect(fired).toEqual(['first']);
    });
  });

  describe('runNext / runAll', () => {
    it('runNext fires the earliest timer and moves time to it', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => fired.push('b'), 5_000);
      clock.setTimeout(() => fired.push('a'), 1_000);
      expect(await clock.runNext()).toBe(true);
      expect(fired).toEqual(['a']);
      expect(clock.now()).toBe(START + 1_000);
      expect(await clock.runNext()).toBe(true);
      expect(clock.now()).toBe(START + 5_000);
      expect(await clock.runNext()).toBe(false);
      expect(clock.now()).toBe(START + 5_000);
    });

    it('runAll drains every timer including ones scheduled meanwhile', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => {
        fired.push('a');
        clock.setTimeout(() => fired.push('c'), 1_000);
      }, 100);
      clock.setTimeout(() => fired.push('b'), 200);
      await clock.runAll();
      expect(fired).toEqual(['a', 'b', 'c']);
      expect(clock.pendingTimers()).toBe(0);
      expect(clock.now()).toBe(START + 1_100);
    });

    it('runAll throws when a timer keeps rescheduling itself past the guard', async () => {
      const clock = new VirtualClock();
      const loop = (): void => {
        clock.setTimeout(loop, 1);
      };
      clock.setTimeout(loop, 1);
      await expect(clock.runAll(50)).rejects.toThrow(/fired 50 timers/);
    });

    it('runAll on an empty clock resolves immediately', async () => {
      const clock = new VirtualClock();
      await expect(clock.runAll()).resolves.toBeUndefined();
    });
  });

  describe('advanceTo', () => {
    it('moves to an absolute instant firing timers on the way', async () => {
      const clock = new VirtualClock();
      const fired: number[] = [];
      clock.setTimeout(() => fired.push(clock.now()), 60_000);
      await clock.advanceTo('2026-01-01T00:02:00Z');
      expect(fired).toEqual([START + 60_000]);
      expect(clock.iso()).toBe('2026-01-01T00:02:00.000Z');
      await clock.advanceTo(new Date(START + 180_000));
      expect(clock.now()).toBe(START + 180_000);
    });

    it('refuses to move backwards or to an invalid instant', async () => {
      const clock = new VirtualClock();
      await expect(clock.advanceTo(START - 1)).rejects.toThrow(/cannot move backwards/);
      await expect(clock.advanceTo('garbage')).rejects.toThrow(RangeError);
    });

    it('is a no-op when the target equals now', async () => {
      const clock = new VirtualClock();
      await clock.advanceTo(START);
      expect(clock.now()).toBe(START);
    });
  });

  describe('introspection and error propagation', () => {
    it('reports pending timers and next due time', () => {
      const clock = new VirtualClock();
      expect(clock.pendingTimers()).toBe(0);
      expect(clock.nextDueAt()).toBeNull();
      clock.setTimeout(() => undefined, 500);
      clock.setTimeout(() => undefined, 100);
      expect(clock.pendingTimers()).toBe(2);
      expect(clock.nextDueAt()).toBe(START + 100);
    });

    it('propagates a throwing callback from advance and drops that timer', async () => {
      const clock = new VirtualClock();
      const fired: string[] = [];
      clock.setTimeout(() => {
        throw new Error('boom');
      }, 10);
      clock.setTimeout(() => fired.push('after'), 20);
      await expect(clock.advance(20)).rejects.toThrow('boom');
      expect(clock.pendingTimers()).toBe(1);
      await clock.advance(20);
      expect(fired).toEqual(['after']);
    });

    it('implements the Clock port shape', () => {
      const clock = new VirtualClock();
      expect(typeof clock.now).toBe('function');
      expect(typeof clock.setTimeout).toBe('function');
      expect(typeof clock.clearTimeout).toBe('function');
    });
  });
});
