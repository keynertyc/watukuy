/**
 * Seeded chaos suite (PLAN §9.4, M5). One seed per PR by default; `WATUKUY_CHAOS_SEEDS=50` nightly.
 *
 * Seeds listed in `KNOWN_FAILING_SEEDS` hit an engine bug that is pinned, with a minimal
 * reproduction, in `./regressions.test.ts`; they are skipped here so this file stays a clean
 * signal for new regressions. Remove a seed from the set once the regression tests pass.
 */
import { describe, expect, it } from 'vitest';
import type { CommitBatch, Lease, PKey, StateStore } from '../../src/index.ts';
import { MemoryStore } from '../../src/index.ts';
import {
  assertChaosReport,
  type ChaosStrategy,
  describeChaos,
  KILL_POINTS,
  runChaos,
} from '../../src/testing/index.ts';

const SEEDS = Math.max(1, Number.parseInt(process.env.WATUKUY_CHAOS_SEEDS ?? '3', 10) || 3);
const STEPS = 120;
const STRATEGIES: readonly ChaosStrategy[] = ['timestamp', 'snapshotDiff', 'token', 'page'];

/**
 * Seeds whose very first tick arms a kill between the first `commitPoll` and the first
 * `saveState` (after-commit, mid-dispatch, before-ack, after-ack-before-schedule). The restarted
 * engine then never polls again: see `regressions.test.ts` ("first-cycle crash stalls the key").
 * Observed within seeds 1..50 (same seeds for every strategy and retain mode): 2, 14, 26, 36, 42.
 */
const KNOWN_FAILING_SEEDS: ReadonlySet<number> = new Set([]);

/** `StateStore` proxy that lets a test tamper with one method and delegates everything else. */
function tamper(inner: StateStore, method: keyof StateStore, impl: (...args: never[]) => unknown) {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === method) return impl;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StateStore;
}

describe(`chaos: seeded deterministic simulation (${SEEDS} seed(s) per strategy)`, () => {
  for (const strategy of STRATEGIES) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const title = `${strategy} seed ${seed}: every guarantee holds across ${STEPS} steps with kills at K1..K7`;
      if (KNOWN_FAILING_SEEDS.has(seed)) {
        it.skip(`${title} (known engine bug, pinned in regressions.test.ts)`, () => {});
        continue;
      }
      it(title, async () => {
        const report = await runChaos({ seed, strategy, steps: STEPS });
        assertChaosReport(report);
        expect(report.violations).toEqual([]);
        expect(report.delivered).toBeGreaterThan(0);
        expect(report.parked).toBe(0);
        // With p = 0.3 over 120 steps most kill points fire; each one is exercised
        // deterministically in the per-kill-point suite below.
        const fired = Object.entries(report.kills).filter(([, n]) => n > 0).length;
        expect(fired).toBeGreaterThanOrEqual(KILL_POINTS.length - 2);
        expect(report.restarts).toBeGreaterThan(0);
        // Redeliveries exist (crashes between deliver and ack) and all share ids (G2).
        expect(report.duplicates).toBe(report.delivered - report.uniqueEvents);
      });
    }
  }

  for (const kp of KILL_POINTS) {
    it(`kill point '${kp}' alone: fires repeatedly and every guarantee holds`, async () => {
      const report = await runChaos({
        seed: 7,
        strategy: kp === 'handler' ? 'snapshotDiff' : 'timestamp',
        steps: 60,
        killPoints: [kp],
        killProbability: 0.5,
      });
      assertChaosReport(report);
      expect(report.kills[kp]).toBeGreaterThan(0);
      expect(report.parked).toBe(0);
    });
  }

  it("timestamp with retain: 'payload' also verifies previous and deleted.data", async () => {
    const report = await runChaos({
      seed: 11,
      strategy: 'timestamp',
      steps: STEPS,
      retainPayload: true,
    });
    assertChaosReport(report);
    expect(report.delivered).toBeGreaterThan(0);
  });

  it("snapshotDiff with retain: 'payload' also verifies previous and deleted.data", async () => {
    const report = await runChaos({
      seed: 12,
      strategy: 'snapshotDiff',
      steps: STEPS,
      retainPayload: true,
    });
    assertChaosReport(report);
    expect(report.mutations.removed).toBeGreaterThan(0);
    expect(report.kills['after-commit'] + report.kills['before-ack']).toBeGreaterThan(0);
  });

  it('is deterministic: the same options produce a deep-equal report, trace included', async () => {
    const options = { seed: 5, strategy: 'snapshotDiff' as const, steps: 60 };
    const a = await runChaos(options);
    const b = await runChaos(options);
    expect(b).toEqual(a);
    expect(a.trace.length).toBeGreaterThan(50);
    expect(describeChaos(a)).toBe(describeChaos(b));
  });

  it('different seeds take different paths', async () => {
    const a = await runChaos({ seed: 1, strategy: 'token', steps: 40 });
    const b = await runChaos({ seed: 3, strategy: 'token', steps: 40 });
    expect(a.trace).not.toEqual(b.trace);
  });

  it('detects a lossy store: events silently dropped from commitPoll violate G1', async () => {
    // Drop every outbox row for the first identity the store ever sees. `page` never removes or
    // updates items, so that identity stays in the API with zero delivered events.
    let victim: string | null = null;
    const inner = new MemoryStore();
    const lossy = tamper(inner, 'commitPoll', ((key: PKey, lease: Lease, batch: CommitBatch) => {
      if (victim === null && batch.events.length > 0) {
        victim = batch.events[0]?.event.subject ?? null;
      }
      const events = batch.events.filter((row) => row.event.subject !== victim);
      return inner.commitPoll(key, lease, { ...batch, events });
    }) as never);
    const report = await runChaos({
      seed: 3,
      strategy: 'page',
      steps: 30,
      killPoints: [],
      store: lossy,
    });
    expect(victim).not.toBeNull();
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations.some((v) => v.startsWith('G1:') && v.includes(victim as string))).toBe(
      true,
    );
    expect(() => assertChaosReport(report)).toThrow(/G1:.*Replay: runChaos\(\{ seed: 3/s);
  });

  it('detects corrupted payloads: a store that alters event data on the way out violates G1', async () => {
    const inner = new MemoryStore();
    const corrupting = tamper(inner, 'loadPending', (async (key: PKey, limit: number) => {
      const rows = await inner.loadPending(key, limit);
      for (const row of rows) {
        const data = row.event.data as { value?: number } | undefined;
        if (data && typeof data.value === 'number') data.value += 1_000_000;
      }
      return rows;
    }) as never);
    const report = await runChaos({
      seed: 3,
      strategy: 'timestamp',
      steps: 30,
      killPoints: [],
      store: corrupting,
    });
    expect(report.violations.some((v) => v.startsWith('G1:') && v.includes('never served'))).toBe(
      true,
    );
  });

  it('rejects invalid options eagerly', async () => {
    await expect(runChaos({ seed: Number.NaN })).rejects.toThrow(RangeError);
    await expect(runChaos({ seed: 1, steps: 0 })).rejects.toThrow(RangeError);
    await expect(runChaos({ seed: 1, killProbability: 2 })).rejects.toThrow(RangeError);
    await expect(runChaos({ seed: 1, killPoints: ['nope' as never] })).rejects.toThrow(RangeError);
  });
});
