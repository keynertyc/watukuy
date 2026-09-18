import type { Random } from '../core/ports.ts';

const TWO_POW_32 = 4_294_967_296;

/**
 * Deterministic {@link Random} source (mulberry32). The same seed always yields the same
 * sequence, which makes jitter, shuffles and chaos schedules reproducible from a single number.
 *
 * @example
 * const a = new SeededRandom(42);
 * const b = new SeededRandom(42);
 * a.next() === b.next();            // true, always
 * a.int(1, 6);                      // a die roll in 1..6
 * a.pick(['x', 'y', 'z']);
 * a.shuffle([1, 2, 3, 4]);          // new array, input untouched
 * a.chance(0.25);                   // true about a quarter of the time
 * const child = a.fork();           // independent generator derived from `a`
 */
export class SeededRandom implements Random {
  /** The seed this generator was created with. */
  readonly seed: number;
  #state: number;

  /**
   * @param seed Any finite number; it is reduced to a 32-bit integer internally.
   * @throws {RangeError} when `seed` is not a finite number.
   */
  constructor(seed: number) {
    if (typeof seed !== 'number' || !Number.isFinite(seed)) {
      throw new RangeError(`SeededRandom seed must be a finite number, got ${String(seed)}`);
    }
    this.seed = seed;
    this.#state = seed >>> 0;
  }

  /** Next value in `[0, 1)`, uniformly distributed with 32 bits of entropy. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  }

  /**
   * Integer in `[min, max]`, both ends inclusive.
   *
   * @throws {RangeError} when either bound is not an integer or `min > max`.
   * @example
   * rng.int(0, 9); // one of 0,1,...,9
   */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(`int() bounds must be integers, got ${min} and ${max}`);
    }
    if (min > max) throw new RangeError(`int() requires min <= max, got ${min} > ${max}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * One element of `arr`, chosen uniformly.
   *
   * @throws {RangeError} when `arr` is empty.
   * @example
   * rng.pick(['created', 'updated', 'deleted']);
   */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new RangeError('pick() requires a non-empty array');
    return arr[this.int(0, arr.length - 1)] as T;
  }

  /**
   * A new array with the elements of `arr` in Fisher-Yates shuffled order. `arr` is not mutated.
   *
   * @example
   * const order = rng.shuffle(['k1', 'k2', 'k3']); // deterministic for a given seed
   */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  /**
   * `true` with probability `p`. Always consumes exactly one value, so the sequence stays aligned
   * regardless of `p`. `p <= 0` is never `true`; `p >= 1` is always `true`.
   *
   * @example
   * if (rng.chance(0.1)) api.failNext({ kind: 'http', status: 503 });
   */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Derive an independent generator seeded from this one's next value. Forking advances this
   * generator by one step, so `fork()` is itself reproducible.
   *
   * @example
   * const forApi = rng.fork();
   * const forScheduler = rng.fork(); // different sequence from `forApi`
   */
  fork(): SeededRandom {
    return new SeededRandom(Math.floor(this.next() * TWO_POW_32));
  }
}
