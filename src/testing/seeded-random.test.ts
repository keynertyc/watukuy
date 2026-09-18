import { describe, expect, it } from 'vitest';
import { SeededRandom } from './seeded-random.ts';

const take = (rng: SeededRandom, n: number): number[] =>
  Array.from({ length: n }, () => rng.next());

describe('SeededRandom', () => {
  describe('reproducibility', () => {
    it('produces the same sequence for the same seed', () => {
      const a = new SeededRandom(42);
      const b = new SeededRandom(42);
      expect(take(a, 50)).toEqual(take(b, 50));
    });

    it('produces different sequences for different seeds', () => {
      expect(take(new SeededRandom(1), 10)).not.toEqual(take(new SeededRandom(2), 10));
    });

    it('is stable across runs (golden values for mulberry32)', () => {
      const rng = new SeededRandom(123);
      const values = take(rng, 3);
      // Pinned so a change of algorithm is caught; a broken seed would break chaos regressions.
      expect(values).toEqual([0.7872516233474016, 0.1785435655619949, 0.49531551403924823]);
    });

    it('exposes the seed it was created with', () => {
      expect(new SeededRandom(7).seed).toBe(7);
      expect(new SeededRandom(-3).seed).toBe(-3);
    });

    it('normalizes seeds to 32-bit: seed and seed + 2^32 agree', () => {
      expect(take(new SeededRandom(5), 5)).toEqual(take(new SeededRandom(5 + 2 ** 32), 5));
    });

    it('rejects non-finite seeds', () => {
      expect(() => new SeededRandom(Number.NaN)).toThrow(RangeError);
      expect(() => new SeededRandom(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('seed 0 works and is distinct from seed 1', () => {
      const zero = take(new SeededRandom(0), 5);
      expect(zero.every((v) => v >= 0 && v < 1)).toBe(true);
      expect(zero).not.toEqual(take(new SeededRandom(1), 5));
    });
  });

  describe('next()', () => {
    it('stays within [0, 1) over many draws', () => {
      const rng = new SeededRandom(99);
      for (let i = 0; i < 10_000; i++) {
        const v = rng.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });

    it('is roughly uniform', () => {
      const rng = new SeededRandom(2024);
      const buckets = new Array<number>(10).fill(0);
      const n = 20_000;
      for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]! += 1;
      for (const count of buckets) {
        expect(count).toBeGreaterThan(n / 10 - 400);
        expect(count).toBeLessThan(n / 10 + 400);
      }
    });
  });

  describe('int()', () => {
    it('is inclusive on both ends and never leaves the range', () => {
      const rng = new SeededRandom(11);
      const seen = new Set<number>();
      for (let i = 0; i < 2_000; i++) {
        const v = rng.int(3, 7);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(3);
        expect(v).toBeLessThanOrEqual(7);
        seen.add(v);
      }
      expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
    });

    it('handles min === max and negative ranges', () => {
      const rng = new SeededRandom(1);
      expect(rng.int(4, 4)).toBe(4);
      for (let i = 0; i < 100; i++) {
        const v = rng.int(-5, -1);
        expect(v).toBeGreaterThanOrEqual(-5);
        expect(v).toBeLessThanOrEqual(-1);
      }
    });

    it('rejects non-integer bounds and min > max', () => {
      const rng = new SeededRandom(1);
      expect(() => rng.int(0.5, 2)).toThrow(RangeError);
      expect(() => rng.int(0, 2.5)).toThrow(RangeError);
      expect(() => rng.int(5, 1)).toThrow(RangeError);
    });
  });

  describe('pick()', () => {
    it('returns an element of the array and eventually every element', () => {
      const rng = new SeededRandom(3);
      const arr = ['a', 'b', 'c', 'd'] as const;
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const v = rng.pick(arr);
        expect(arr).toContain(v);
        seen.add(v);
      }
      expect(seen.size).toBe(4);
    });

    it('throws on an empty array', () => {
      expect(() => new SeededRandom(1).pick([])).toThrow(RangeError);
    });
  });

  describe('shuffle()', () => {
    it('returns a permutation and leaves the input untouched', () => {
      const rng = new SeededRandom(8);
      const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const snapshot = input.slice();
      const out = rng.shuffle(input);
      expect(input).toEqual(snapshot);
      expect(out).not.toBe(input);
      expect(out.slice().sort((a, b) => a - b)).toEqual(snapshot);
    });

    it('is deterministic per seed and actually shuffles', () => {
      const input = Array.from({ length: 20 }, (_, i) => i);
      const a = new SeededRandom(21).shuffle(input);
      const b = new SeededRandom(21).shuffle(input);
      expect(a).toEqual(b);
      expect(a).not.toEqual(input);
    });

    it('handles empty and single-element arrays', () => {
      const rng = new SeededRandom(1);
      expect(rng.shuffle([])).toEqual([]);
      expect(rng.shuffle(['x'])).toEqual(['x']);
    });
  });

  describe('chance()', () => {
    it('is never true for p <= 0 and always true for p >= 1', () => {
      const rng = new SeededRandom(5);
      for (let i = 0; i < 200; i++) {
        expect(rng.chance(0)).toBe(false);
        expect(rng.chance(-1)).toBe(false);
        expect(rng.chance(1)).toBe(true);
        expect(rng.chance(2)).toBe(true);
      }
    });

    it('approximates the requested probability', () => {
      const rng = new SeededRandom(77);
      let hits = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) if (rng.chance(0.25)) hits++;
      expect(hits / n).toBeGreaterThan(0.23);
      expect(hits / n).toBeLessThan(0.27);
    });

    it('always consumes exactly one value so sequences stay aligned', () => {
      const a = new SeededRandom(9);
      const b = new SeededRandom(9);
      a.chance(0);
      b.next();
      expect(take(a, 5)).toEqual(take(b, 5));
    });
  });

  describe('fork()', () => {
    it('derives a reproducible child generator', () => {
      const childA = new SeededRandom(13).fork();
      const childB = new SeededRandom(13).fork();
      expect(childA.seed).toBe(childB.seed);
      expect(take(childA, 10)).toEqual(take(childB, 10));
    });

    it('advances the parent by exactly one step', () => {
      const forked = new SeededRandom(13);
      const plain = new SeededRandom(13);
      forked.fork();
      plain.next();
      expect(take(forked, 10)).toEqual(take(plain, 10));
    });

    it('child and parent produce independent sequences', () => {
      const parent = new SeededRandom(13);
      const child = parent.fork();
      expect(take(child, 10)).not.toEqual(take(parent, 10));
    });

    it('successive forks differ from each other', () => {
      const parent = new SeededRandom(13);
      const first = parent.fork();
      const second = parent.fork();
      expect(first.seed).not.toBe(second.seed);
    });
  });
});
