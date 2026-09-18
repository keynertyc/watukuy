/**
 * Failing chaos seeds and their minimal reproductions (see docs/guarantees.md: "failing seeds are recorded as
 * regression tests"). Every test in this file is EXPECTED TO FAIL until the engine bug it pins is
 * fixed; once they pass, remove the seed from `KNOWN_FAILING_SEEDS` in `chaos.test.ts`.
 *
 * Bug: first-cycle crash stalls the key forever (G9 / liveness).
 *
 * When a key runs its very first cycle, `runKey` builds its in-memory state with
 * `initialScheduleState(now)` (`nextDueAt: now`) because `loadState` returned `null`. The first
 * `commitPoll` then creates the persisted row from `statePatch`, which carries `lanes`, `sequence`,
 * `schemaVersion` and `updatedAt` but NOT `schedule` (`src/core/runner.ts`, the `batch` built
 * before `store.commitPoll`). `MemoryStore.applyPatch` fills the missing fields from
 * `emptyPollerState()`, whose `schedule.nextDueAt` is `null`. The schedule is only persisted by
 * the `saveState` at the end of the cycle.
 *
 * If the process dies between that first commit and that first `saveState` (kill points K3
 * after-commit, K4 mid-dispatch, before-ack, K5 saveState), the row stays at
 * `schedule.nextDueAt === null`. After the restart `runKey` re-reads it verbatim and
 * `isDue(state, now)` (`src/scheduler/scheduler.ts`) returns `false` for a `null` `nextDueAt`, so:
 *
 * - tick mode: the outbox left behind is drained once (G1 holds for it), then every tick reports
 *   `skippedNotDue` forever; new API changes are never observed.
 * - daemon mode: `WatukuyEngine.nextDueFromState` reads `nextDueAt ?? now`, treats `null` as
 *   "due now", and `runKey` immediately answers `not-due`, so `loop → runOne → requestWake → loop`
 *   spins in the microtask queue with zero elapsed time, hammering `loadState`/`countPending`.
 *
 * Note the inconsistency: the scheduler treats `nextDueAt: null` as "never", the engine as "now".
 * The first `commitPoll` of a key committing without a schedule is the root cause; either that
 * commit should carry `schedule`, or a `null` `nextDueAt` should be treated as due.
 */
import { describe, expect, it } from 'vitest';
import { assertChaosReport, FaultyStore, runChaos } from '../../src/testing/index.ts';
import { collector, engineFor, timestampPoller, world } from '../integration/helpers.ts';

const KEY = { poller: 'orders', partition: '' };

describe('regression: first-cycle crash stalls the key (K3/K4/K5 before the first saveState)', () => {
  it('tick mode: after a crash right after the first commit, the restarted engine never polls again', async () => {
    const w = world({ items: 3 });
    const faulty = new FaultyStore(w.store);
    faulty.armed = 'after-commit'; // K3: commit succeeded, process dies before dispatch
    const e1 = engineFor(w, { orders: timestampPoller(w) }, {}, faulty);
    e1.on('orders', async () => {});
    const t1 = await e1.tick();
    expect(t1.polled[0]?.error?.name).toBe('SimulatedCrash');

    // The row now exists with a schedule that was never planned.
    const persisted = await w.store.loadState(KEY);
    expect(persisted?.sequence).toBe(3);
    // Documented expectation: a first commit must not leave the key unscheduled.
    expect(persisted?.schedule.nextDueAt).not.toBeNull(); // FAILS today: null

    // Restart on the same store after the lease TTL.
    const e2 = engineFor(w, { orders: timestampPoller(w) }, { instanceId: 'test-2' });
    const c = collector<{ id: string; status: string }>();
    e2.on('orders', c.handler);
    await w.clock.advance(31_000);
    await e2.tick();
    expect(c.events).toHaveLength(3); // outbox drained: G1 holds for what was committed

    // A new change, well past schedule.min, is never observed.
    w.api.update('o0000', { status: 'paid' });
    await w.clock.advance(60_000);
    const t3 = await e2.tick();
    expect(t3.polled).toHaveLength(1); // FAILS today: [] with skippedNotDue === 1
    expect(c.events.at(-1)).toMatchObject({ type: 'updated', subject: 'o0000' });
  });

  it('daemon mode: the restarted engine busy-loops on the stalled key without advancing time', async () => {
    const w = world({ items: 3 });
    const faulty = new FaultyStore(w.store);
    faulty.armed = 'after-commit';
    const e1 = engineFor(w, { orders: timestampPoller(w) }, {}, faulty);
    e1.on('orders', async () => {});
    await e1.tick();
    await w.clock.advance(31_000);

    let loadStateCalls = 0;
    const counting = new Proxy(w.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'loadState') {
          return (...args: Parameters<typeof target.loadState>) => {
            loadStateCalls++;
            return target.loadState(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const e2 = engineFor(w, { orders: timestampPoller(w) }, { instanceId: 'test-2' }, counting);
    e2.on('orders', async () => {});
    await e2.start();
    await w.clock.flush(200); // microtasks only: no virtual time passes
    await e2.stop({ drain: false });
    // start() reads the state once and the first loop iteration once more; anything beyond a
    // handful with zero elapsed time is the loop → runOne → requestWake → loop spin.
    expect(loadStateCalls).toBeLessThanOrEqual(4); // FAILS today: ~37 in 200 microtask rounds
  });

  it('chaos seed 2 (timestamp, 40 steps): first tick arms mid-dispatch and the run never converges', async () => {
    const report = await runChaos({ seed: 2, strategy: 'timestamp', steps: 40 });
    expect(report.kills['mid-dispatch']).toBeGreaterThanOrEqual(1);
    expect(report.restarts).toBeGreaterThanOrEqual(1);
    assertChaosReport(report);
  });
});
