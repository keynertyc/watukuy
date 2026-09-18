/**
 * watukuy/testing — deterministic test utilities (PLAN §9).
 *
 * - {@link VirtualClock}: a `Clock` where time only moves when you say so.
 * - {@link SeededRandom}: a reproducible `Random`.
 * - {@link FakeApi}: a scriptable in-memory third-party API with faults, rate limits, ETags and
 *   latency, usable directly or through a `fetch`-compatible function.
 * - {@link createTestLogger}: a `Logger` that records instead of printing.
 *
 * @example
 * import { FakeApi, VirtualClock, SeededRandom, fakeItems, createTestLogger } from 'watukuy/testing';
 *
 * const clock = new VirtualClock();
 * const rng = new SeededRandom(7);
 * const logger = createTestLogger();
 * const api = new FakeApi({ clock, identity: (o) => o.id, timestampField: 'updatedAt', items: fakeItems(20) });
 * @packageDocumentation
 */

export * from './chaos.ts';
export {
  FakeApi,
  type FakeApiLogEntry,
  type FakeApiOptions,
  type FakeFault,
  type FakeItem,
  type FakePageResult,
  type FakeRateLimit,
  type FakeRateLimitStyle,
  type FakeSinceResult,
  type FakeTokenResult,
  fakeItems,
} from './fake-api.ts';
export { SeededRandom } from './seeded-random.ts';
export {
  createTestLogger,
  type TestLogEntry,
  type TestLogger,
  type TestLogLevel,
} from './test-logger.ts';
export { VirtualClock } from './virtual-clock.ts';
