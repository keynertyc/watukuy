import type { BudgetManager } from '../budget/index.ts';
import { type CursorStrategy, getStrategy } from '../cursor/index.ts';
import { detectDeletes, diffCandidates, eventId, prepareCandidates } from '../diff/index.ts';
import { createHttpClient } from '../http/index.ts';
import {
  afterFailure,
  afterSuccess,
  beginProbe,
  initialScheduleState,
  isDue,
} from '../scheduler/index.ts';
import { validateItems } from '../validate/index.ts';
import type { Consumer } from './consumers.ts';
import type { CursorConfig, PageCursorConfig } from './cursor-types.ts';
import { type DrainResult, drainOutbox } from './dispatcher.ts';
import type { TickPollResult } from './engine-types.ts';
import { HttpError, LeaseLostError, serializeError, ValidationError } from './errors.ts';
import type { EventType, WatukuyEvent } from './event.ts';
import { sha256Hex } from './hash.ts';
import { LeaseKeeper } from './lease-keeper.ts';
import { childLogger } from './logger.ts';
import type {
  FetchContext,
  FetchFn,
  Lane,
  Page,
  Partition,
  PollSummary,
  ResolvedPoller,
} from './poller-types.ts';
import type { Clock, Hooks, Logger, Random } from './ports.ts';
import type {
  CommitBatch,
  ItemRow,
  LaneCursor,
  Lease,
  OutboxRow,
  ParkedRow,
  PKey,
  PollerState,
  StateStore,
} from './store-types.ts';

export interface RunnerDeps {
  store: StateStore;
  clock: Clock;
  random: Random;
  logger: Logger;
  hooks: Required<Hooks>;
  instanceId: string;
  poller: ResolvedPoller;
  key: PKey;
  partition: Partition<unknown>;
  budget: BudgetManager | null;
  fetchImpl: typeof globalThis.fetch;
  consumer: Consumer<unknown> | null;
  dispatchBatchSize: number;
  leaseTtlMs: number;
  leaseRenewMs: number;
}

export interface RunKeyOptions {
  signal: AbortSignal;
  /** Absolute epoch ms after which no new page is fetched (tick maxDuration). */
  deadline?: number | null | undefined;
  /** Ignore the schedule and run the live lane now (trigger()). */
  force?: boolean | undefined;
}

export interface RunKeyResult {
  ran: boolean;
  reason?: 'not-due' | 'paused' | 'leased' | 'aborted';
  results: TickPollResult[];
  state: PollerState | null;
  /** Earliest pending delivery retry, if any. */
  nextRetryAt: number | null;
  leaseLost: boolean;
  /** Events delivered by the outbox drain that runs before any lane (leftovers from a crash). */
  drainedBefore: number;
}

/** Hard bound for full-scan lanes (snapshotDiff, reconcile) against APIs whose `hasMore` never turns false. */
const FULL_SCAN_PAGE_CAP = 10_000;

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.startsWith('watukuy: lease lost'))
  );
}

function emptyState(now: number, poller: ResolvedPoller): PollerState {
  return {
    lanes: {},
    schedule: initialScheduleState(now, { schedule: poller.schedule, circuit: poller.circuit }),
    paused: false,
    schemaVersion: null,
    sequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function reconcileDue(poller: ResolvedPoller, state: PollerState, now: number): boolean {
  if (!poller.reconcile) return false;
  const last = state.lanes.reconcile?.lastRunAt ?? null;
  return last === null || last + poller.reconcile.everyMs <= now;
}

function backfillActive(state: PollerState): boolean {
  const lane = state.lanes.backfill;
  return !!lane && lane.done !== true;
}

/**
 * Run everything due for one `(poller, partition)`: acquire the fenced lease, drain the outbox,
 * run the live cycle when due, then reconcile and backfill lanes, persist the schedule, release.
 * Never throws for poller errors (they land in `results[].error`); rethrows only on engine abort.
 */
export async function runKey(deps: RunnerDeps, opts: RunKeyOptions): Promise<RunKeyResult> {
  const { store, clock, key, poller } = deps;
  const logger = childLogger(
    deps.logger,
    `[${key.poller}${key.partition ? `/${key.partition}` : ''}]`,
    {},
  );
  const out: RunKeyResult = {
    ran: false,
    results: [],
    state: null,
    nextRetryAt: null,
    leaseLost: false,
    drainedBefore: 0,
  };
  const now0 = clock.now();

  const pre = (await store.loadState(key)) ?? emptyState(now0, poller);
  out.state = pre;
  if (pre.paused) {
    out.reason = 'paused';
    return out;
  }
  const hasPending = deps.consumer ? (await store.countPending(key)) > 0 : false;
  const liveDue = opts.force === true || isDue(pre.schedule, now0);
  if (!liveDue && !reconcileDue(poller, pre, now0) && !backfillActive(pre) && !hasPending) {
    out.reason = 'not-due';
    return out;
  }

  const lease = await store.acquireLease(key, deps.instanceId, deps.leaseTtlMs, clock.now());
  if (!lease) {
    out.reason = 'leased';
    return out;
  }
  const hookCtx = { ...key, lane: 'live' as Lane, instanceId: deps.instanceId };
  await deps.hooks.onLeaseAcquired({ ...hookCtx, lease });

  const abort = new AbortController();
  const onOuterAbort = (): void => abort.abort(opts.signal.reason);
  if (opts.signal.aborted) onOuterAbort();
  else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  const keeper = new LeaseKeeper({
    store,
    clock,
    logger,
    key,
    lease,
    ttlMs: deps.leaseTtlMs,
    renewEveryMs: deps.leaseRenewMs,
    abort,
  });
  keeper.start();

  try {
    // Authoritative re-read under the lease: another instance may have run this key meanwhile.
    let state = (await store.loadState(key)) ?? emptyState(clock.now(), poller);
    if (state.paused) {
      out.reason = 'paused';
      return out;
    }
    out.ran = true;
    const cycleDeps: CycleDeps = {
      ...deps,
      logger,
      lease,
      keeper,
      signal: abort.signal,
      deadline: opts.deadline ?? null,
    };

    // 1. Drain what a previous crash left behind (G1/G9).
    const drained = await drainOutbox(deps, lease, deps.consumer, abort.signal);
    noteRetry(out, drained);
    out.drainedBefore = drained.delivered;
    if (drained.halted) {
      state = await openCircuitForHalt(cycleDeps, state);
    }

    // 2. Live lane.
    const now = clock.now();
    if (!drained.halted && (opts.force === true || isDue(state.schedule, now))) {
      if (state.schedule.circuit === 'open')
        state = { ...state, schedule: beginProbe(state.schedule) };
      const r = await runCycle(cycleDeps, state, 'live');
      state = r.state;
      out.results.push(r.result);
      noteRetry(out, r.drain);
      if (r.aborted) {
        out.reason = 'aborted';
        return out;
      }
    }

    // 3. Reconcile lane.
    if (
      !drained.halted &&
      poller.reconcile &&
      reconcileDue(poller, state, clock.now()) &&
      !abort.signal.aborted
    ) {
      const r = await runCycle(cycleDeps, state, 'reconcile');
      state = r.state;
      out.results.push(r.result);
      noteRetry(out, r.drain);
      if (r.aborted) {
        out.reason = 'aborted';
        return out;
      }
    }

    // 4. Backfill lane.
    if (!drained.halted && backfillActive(state) && !abort.signal.aborted) {
      const r = await runCycle(cycleDeps, state, 'backfill');
      state = r.state;
      out.results.push(r.result);
      noteRetry(out, r.drain);
      if (r.aborted) {
        out.reason = 'aborted';
        return out;
      }
    }
    out.state = state;
    return out;
  } catch (err) {
    if (err instanceof LeaseLostError || keeper.lost) {
      out.leaseLost = true;
      await deps.hooks.onLeaseLost({ ...hookCtx, epoch: lease.epoch });
      logger.warn('lease lost during cycle; discarding in-memory work');
      return out;
    }
    throw err;
  } finally {
    keeper.stop();
    opts.signal.removeEventListener('abort', onOuterAbort);
    try {
      await store.releaseLease(key, lease);
    } catch (err) {
      logger.warn('lease release failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function noteRetry(out: RunKeyResult, drain: DrainResult | null): void {
  if (!drain || drain.nextRetryAt === null) return;
  out.nextRetryAt =
    out.nextRetryAt === null ? drain.nextRetryAt : Math.min(out.nextRetryAt, drain.nextRetryAt);
}

interface CycleDeps extends RunnerDeps {
  lease: Lease;
  keeper: LeaseKeeper;
  signal: AbortSignal;
  deadline: number | null;
}

interface CycleResult {
  state: PollerState;
  result: TickPollResult;
  drain: DrainResult | null;
  aborted: boolean;
}

async function openCircuitForHalt(deps: CycleDeps, state: PollerState): Promise<PollerState> {
  const now = deps.clock.now();
  const schedule = {
    ...state.schedule,
    circuit: 'open' as const,
    circuitOpenedAt: now,
    nextDueAt: now + deps.poller.circuit.probeEveryMs,
    consecutiveFailures: Math.max(state.schedule.consecutiveFailures, deps.poller.circuit.failures),
    lastError: { name: 'PoisonHalt', message: 'poison event with action "halt"; circuit opened' },
  };
  const next = { ...state, schedule, updatedAt: now };
  await deps.store.saveState(deps.key, deps.lease, { schedule, updatedAt: now });
  await deps.hooks.onCircuitOpen({
    ...deps.key,
    lane: 'live',
    instanceId: deps.instanceId,
    failures: schedule.consecutiveFailures,
    probeAt: schedule.nextDueAt,
  });
  return next;
}

async function* pagesOf(
  result: Promise<Page<unknown>> | AsyncIterable<Page<unknown>>,
): AsyncGenerator<Page<unknown>, void, undefined> {
  if (
    result &&
    typeof (result as AsyncIterable<Page<unknown>>)[Symbol.asyncIterator] === 'function'
  ) {
    yield* result as AsyncIterable<Page<unknown>>;
  } else {
    yield await (result as Promise<Page<unknown>>);
  }
}

async function runCycle(
  deps: CycleDeps,
  startState: PollerState,
  lane: Lane,
): Promise<CycleResult> {
  const { poller, store, clock, key, lease, signal } = deps;
  const startedAt = clock.now();
  const hookCtx = { ...key, lane, instanceId: deps.instanceId };
  await deps.hooks.onPollStart({ ...hookCtx, startedAt });

  const cfg: CursorConfig =
    lane === 'reconcile'
      ? ({ strategy: 'page', initial: 1 } satisfies PageCursorConfig)
      : poller.cursor;
  const strategy = getStrategy(cfg) as CursorStrategy<CursorConfig, unknown>;
  const fetchFn: FetchFn<unknown, unknown, unknown> =
    lane === 'reconcile' && poller.reconcile
      ? (poller.reconcile.fetch as FetchFn<unknown, unknown, unknown>)
      : poller.fetch;
  const isFullScan = lane === 'reconcile' || cfg.strategy === 'snapshotDiff';
  const laneState: LaneCursor = startState.lanes[lane] ?? { cursor: null };
  let cursor: unknown =
    laneState.cursor !== null ? strategy.deserialize(cfg, laneState.cursor) : strategy.initial(cfg);
  const target: unknown =
    lane === 'backfill' && laneState.target != null
      ? strategy.deserialize(cfg, laneState.target)
      : null;
  const force = lane === 'backfill' && laneState.force === true;

  let state = startState;
  let sequence = state.sequence;
  const summary: PollSummary = {
    lane,
    startedAt,
    durationMs: 0,
    pages: 0,
    items: 0,
    events: { created: 0, updated: 0, deleted: 0 },
    notModified: false,
    truncated: false,
  };
  const seen = new Set<string>();
  let lastRateLimit = state.schedule.rateLimit;
  let lastDrain: DrainResult | null = null;
  let sawNotModified = false;
  let halted = false;

  const fetchWithFlag: typeof globalThis.fetch = async (input, init) => {
    const res = await deps.fetchImpl(input, init);
    if (res.status === 304) sawNotModified = true;
    return res;
  };
  const http = createHttpClient({
    fetch: fetchWithFlag,
    clock,
    logger: deps.logger,
    validators: {
      get: (h) => store.getValidator(key, h),
      set: (h, v) => store.setValidator(key, lease, h, v),
    },
    charge:
      deps.budget && poller.budget
        ? (cost) =>
            (deps.budget as BudgetManager).acquire(poller.budget as string, {
              requester: `${key.poller}/${key.partition}`,
              weight: poller.budgetWeight,
              lane,
              cost,
              signal,
              maxWaitMs:
                (deps.budget as BudgetManager).policy(poller.budget as string).maxWaitMs ??
                poller.schedule.maxMs,
            })
        : undefined,
    defaultCost: poller.budgetCost,
    onRateLimit: (info) => {
      lastRateLimit = info;
    },
    signal,
  });

  const persistLane = (next: LaneCursor): Partial<Record<Lane, LaneCursor>> => ({
    ...state.lanes,
    [lane]: next,
  });

  try {
    let done = false;
    let attempt = 1;
    outer: while (!done) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      if (deps.deadline !== null && clock.now() >= deps.deadline) {
        summary.truncated = true;
        break;
      }
      // Full scans must see the whole listing to detect deletes, so only the hard safety cap
      // (not maxPagesPerCycle) bounds them; incremental lanes stop at maxPagesPerCycle and
      // continue immediately on the next cycle.
      if (summary.pages >= (isFullScan ? FULL_SCAN_PAGE_CAP : poller.maxPagesPerCycle)) {
        summary.truncated = true;
        break;
      }
      // `overlap` (and any other fetch-time adjustment) applies to the first request of a cycle
      // only; later pages continue from the exact keyset cursor, otherwise a busy API whose
      // overlap window spans more than one page would re-fetch the same page until the cap.
      const fetchCursor =
        summary.pages === 0 ? strategy.forFetch(cfg, cursor, clock.now()) : cursor;
      const ctx: FetchContext<unknown, unknown> = {
        cursor: fetchCursor,
        page: summary.pages + 1,
        partition: deps.partition,
        lane,
        http,
        signal,
        attempt,
        logger: deps.logger,
      };
      const fetchStarted = clock.now();
      const pages = pagesOf(fetchFn(ctx));
      let pagesInCall = 0;
      for await (const page of pages) {
        pagesInCall++;
        summary.pages++;
        attempt = 1;
        const items = Array.isArray(page?.items) ? page.items : [];
        await deps.hooks.onFetch({
          ...hookCtx,
          page: summary.pages,
          durationMs: clock.now() - fetchStarted,
          items: items.length,
          notModified: sawNotModified,
        });
        const adv = strategy.advance(cfg, cursor, {
          items,
          pageCursor: page.cursor,
          hasMore: page.hasMore,
          now: clock.now(),
        });
        const commit = await processPage(
          deps,
          state,
          lane,
          adv.items,
          sequence,
          isFullScan,
          force,
          seen,
          strategy.serialize(cfg, adv.cursor),
        );
        sequence = commit.sequence;
        summary.items += adv.items.length;
        summary.events.created += commit.counts.created;
        summary.events.updated += commit.counts.updated;
        cursor = adv.cursor;
        done = adv.done;
        if (lane === 'backfill' && target !== null && strategy.reached(cfg, cursor, target))
          done = true;

        const laneNext: LaneCursor = {
          ...laneState,
          cursor: strategy.serialize(cfg, cursor),
          ...(lane === 'backfill' ? { target: laneState.target ?? null, done: false, force } : {}),
          ...(lane === 'reconcile' ? { lastRunAt: laneState.lastRunAt ?? null, done: false } : {}),
        };
        const batch: CommitBatch = {
          // The schedule travels with every commit so a crash before the end-of-cycle save never
          // leaves a row without a due time (chaos regression: first-cycle crash stalled the key).
          statePatch: {
            lanes: persistLane(laneNext),
            schedule: state.schedule,
            sequence,
            schemaVersion: poller.schemaVersion,
            updatedAt: clock.now(),
          },
          upserts: commit.upserts,
          deletes: [],
          events: commit.events,
          log: poller.log !== undefined,
          parked: commit.parked,
        };
        const commitStarted = clock.now();
        await store.commitPoll(key, lease, batch);
        state = {
          ...state,
          lanes: batch.statePatch.lanes as PollerState['lanes'],
          sequence,
          schemaVersion: poller.schemaVersion,
          updatedAt: clock.now(),
        };
        await deps.hooks.onCommit({
          ...hookCtx,
          events: commit.events.length,
          upserts: commit.upserts.length,
          deletes: 0,
          durationMs: clock.now() - commitStarted,
        });
        for (const row of commit.events) await deps.hooks.onEvent({ ...hookCtx, event: row.event });
        for (const row of commit.parked) {
          await deps.hooks.onInvalid({
            ...hookCtx,
            item: row.item,
            issues: row.error.issues ?? [],
          });
        }
        if (commit.events.length > 0) {
          lastDrain = await drainOutbox(deps, lease, deps.consumer, signal);
          if (lastDrain.halted) {
            state = await openCircuitForHalt(deps, state);
            halted = true;
            done = true;
            break outer;
          }
        }
        if (!(await deps.keeper.renewNow()))
          throw new LeaseLostError(key.poller, key.partition, lease.epoch);
        if (done || signal.aborted) break;
        if (deps.deadline !== null && clock.now() >= deps.deadline) {
          summary.truncated = true;
          break outer;
        }
        if (summary.pages >= (isFullScan ? FULL_SCAN_PAGE_CAP : poller.maxPagesPerCycle) && !done) {
          summary.truncated = true;
          break outer;
        }
      }
      if (pagesInCall === 0) done = true; // empty async iterable
      // Async iterables end the cycle when exhausted; a single page loops via the strategy's `done`.
      if (!done && pagesInCall > 1) done = true;
    }

    // Full scans: everything not seen is deleted, once the whole listing completed.
    // A 304 Not Modified means "identical to last time": never treat it as an empty listing.
    if (done && isFullScan && !summary.truncated && !sawNotModified && !halted) {
      const missing: string[] = [];
      for await (const batchIds of store.streamIdentities(key)) {
        for (const id of detectDeletes(batchIds, seen)) missing.push(id);
      }
      if (missing.length > 0) {
        const rows = await store.loadVersions(key, missing);
        const events: OutboxRow[] = [];
        for (const id of missing) {
          const row = rows.get(id);
          if (!row) continue;
          sequence++;
          events.push(
            await buildEventRow(
              deps,
              lane,
              'deleted',
              id,
              row.version ?? row.hash,
              poller.retain === 'payload' ? row.payload : undefined,
              poller.retain === 'payload' ? row.payload : undefined,
              sequence,
              strategy.serialize(cfg, cursor),
            ),
          );
        }
        const batch: CommitBatch = {
          statePatch: { schedule: state.schedule, sequence, updatedAt: clock.now() },
          upserts: [],
          deletes: missing,
          events,
          log: poller.log !== undefined,
        };
        await store.commitPoll(key, lease, batch);
        state = { ...state, sequence, updatedAt: clock.now() };
        summary.events.deleted += events.length;
        await deps.hooks.onCommit({
          ...hookCtx,
          events: events.length,
          upserts: 0,
          deletes: missing.length,
          durationMs: 0,
        });
        for (const row of events) await deps.hooks.onEvent({ ...hookCtx, event: row.event });
        if (events.length > 0) lastDrain = await drainOutbox(deps, lease, deps.consumer, signal);
      }
    }

    // Cycle bookkeeping per lane.
    if (done) cursor = strategy.onCycleComplete(cfg, cursor);
    const laneFinal: LaneCursor =
      lane === 'reconcile'
        ? { cursor: null, lastRunAt: done ? clock.now() : (laneState.lastRunAt ?? null), done }
        : lane === 'backfill'
          ? {
              cursor: strategy.serialize(cfg, cursor),
              target: laneState.target ?? null,
              done,
              force,
            }
          : { cursor: strategy.serialize(cfg, cursor) };

    summary.durationMs = clock.now() - startedAt;
    summary.notModified = sawNotModified && summary.items === 0;
    const hadEvents = summary.events.created + summary.events.updated + summary.events.deleted > 0;

    let schedule = state.schedule;
    if (halted) {
      schedule = { ...state.schedule, lastPoll: summary, lastPollAt: clock.now() };
    } else if (lane === 'live') {
      const r = afterSuccess(
        state.schedule,
        { schedule: poller.schedule, circuit: poller.circuit },
        { now: clock.now(), random: deps.random },
        {
          hadEvents,
          notModified: summary.notModified,
          truncated: summary.truncated,
          rateLimit: lastRateLimit,
          summary,
        },
      );
      schedule = r.state;
      if (r.circuitClosed) await deps.hooks.onCircuitClose(hookCtx);
      await deps.hooks.onScheduleChange({
        ...hookCtx,
        intervalMs: schedule.intervalMs ?? poller.schedule.minMs,
        nextDueAt: schedule.nextDueAt ?? clock.now(),
        reason: r.reason,
      });
    } else {
      schedule = { ...state.schedule, lastPoll: summary };
    }
    const patch = { lanes: persistLane(laneFinal), schedule, sequence, updatedAt: clock.now() };
    await store.saveState(key, lease, patch);
    state = { ...state, ...patch };
    await deps.hooks.onPollEnd({ ...hookCtx, summary });

    return {
      state,
      result: {
        poller: key.poller,
        partition: key.partition,
        lane,
        items: summary.items,
        events: summary.events.created + summary.events.updated + summary.events.deleted,
        delivered: lastDrain?.delivered ?? 0,
        durationMs: summary.durationMs,
        error: null,
      },
      drain: lastDrain,
      aborted: false,
    };
  } catch (err) {
    if (err instanceof LeaseLostError) throw err;
    if (signal.aborted && (deps.keeper.lost || isAbortError(err))) {
      if (deps.keeper.lost) throw new LeaseLostError(key.poller, key.partition, lease.epoch);
      return {
        state,
        result: {
          poller: key.poller,
          partition: key.partition,
          lane,
          items: summary.items,
          events: 0,
          delivered: lastDrain?.delivered ?? 0,
          durationMs: clock.now() - startedAt,
          error: serializeError(err),
        },
        drain: lastDrain,
        aborted: true,
      };
    }
    const serialized = serializeError(err);
    const isThrottle = err instanceof HttpError && err.isThrottle;
    const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined;
    let schedule = state.schedule;
    if (lane === 'live') {
      const r = afterFailure(
        state.schedule,
        { schedule: poller.schedule, circuit: poller.circuit },
        { now: clock.now(), random: deps.random },
        {
          error: serialized,
          retryAfterMs,
          isThrottle,
          rateLimit: err instanceof HttpError ? err.rateLimit : undefined,
        },
      );
      schedule = r.state;
      if (r.circuitOpened) {
        await deps.hooks.onCircuitOpen({
          ...hookCtx,
          failures: schedule.consecutiveFailures,
          probeAt: schedule.nextDueAt ?? clock.now(),
        });
      }
      await deps.hooks.onScheduleChange({
        ...hookCtx,
        intervalMs: schedule.intervalMs ?? poller.schedule.minMs,
        nextDueAt: schedule.nextDueAt ?? clock.now(),
        reason: r.reason,
      });
    } else {
      schedule = { ...state.schedule, lastError: serialized };
    }
    await deps.hooks.onError({ ...hookCtx, error: serialized, phase: 'fetch' });
    if (isThrottle) {
      deps.logger.info(`${lane} cycle throttled by the API`, {
        status: serialized.status,
        retryAfterMs,
        nextDueAt: schedule.nextDueAt,
      });
    } else {
      deps.logger.warn(`${lane} cycle failed`, {
        error: serialized.message,
        code: serialized.code,
        status: serialized.status,
      });
    }
    try {
      await store.saveState(key, lease, { schedule, sequence, updatedAt: clock.now() });
    } catch (saveErr) {
      if (saveErr instanceof LeaseLostError) throw saveErr;
    }
    state = { ...state, schedule, sequence };
    summary.durationMs = clock.now() - startedAt;
    await deps.hooks.onPollEnd({ ...hookCtx, summary });
    return {
      state,
      result: {
        poller: key.poller,
        partition: key.partition,
        lane,
        items: summary.items,
        events: summary.events.created + summary.events.updated + summary.events.deleted,
        delivered: lastDrain?.delivered ?? 0,
        durationMs: summary.durationMs,
        error: serialized,
      },
      drain: lastDrain,
      aborted: false,
    };
  }
}

interface PageCommit {
  upserts: ItemRow[];
  events: OutboxRow[];
  parked: ParkedRow[];
  sequence: number;
  counts: { created: number; updated: number };
}

async function processPage(
  deps: CycleDeps,
  state: PollerState,
  lane: Lane,
  rawItems: unknown[],
  sequenceStart: number,
  isFullScan: boolean,
  force: boolean,
  seen: Set<string>,
  cursorAfterPage: string,
): Promise<PageCommit> {
  const { poller, store, key, clock } = deps;
  const now = clock.now();
  let sequence = sequenceStart;
  const out: PageCommit = {
    upserts: [],
    events: [],
    parked: [],
    sequence,
    counts: { created: 0, updated: 0 },
  };

  const { valid, invalid } = await validateItems(poller.schema, rawItems);
  if (invalid.length > 0) {
    if (poller.onInvalid === 'fail') {
      throw new ValidationError(invalid[0]?.issues ?? [{ message: 'invalid item' }]);
    }
    if (poller.onInvalid === 'quarantine') {
      for (const inv of invalid) {
        const id = `invalid:${(await sha256Hex(safeJson(inv.item))).slice(0, 32)}`;
        out.parked.push({
          id,
          kind: 'invalid',
          event: null,
          item: inv.item,
          error: {
            name: 'ValidationError',
            message: inv.issues.map((i) => i.message).join('; '),
            issues: inv.issues,
          },
          attempts: 0,
          parkedAt: now,
          holdKey: null,
        });
      }
    } else {
      deps.logger.warn('skipped invalid items', { count: invalid.length });
    }
  }

  const identities = valid.map((item) => poller.identity(item as never));
  const existing = await store.loadVersions(key, identities);
  const { candidates } = await prepareCandidates(poller, valid, existing);
  const diff = diffCandidates(poller, candidates, existing, { now, touchUnchanged: isFullScan });
  if (isFullScan) for (const id of identities) seen.add(id);

  out.upserts = diff.upserts;
  const cursorForEvents = cursorAfterPage;
  for (const change of diff.changes) {
    sequence++;
    out.events.push(
      await buildEventRow(
        deps,
        lane,
        change.type,
        change.identity,
        change.version ?? change.hash,
        change.item,
        change.previous,
        sequence,
        cursorForEvents,
      ),
    );
    out.counts[change.type]++;
  }
  if (force) {
    // Backfill with force: re-emit every known, unchanged item as `updated` so consumers can
    // rebuild state. Covers both hash-unchanged candidates and version fast-path skips.
    const changed = new Set(diff.changes.map((c) => c.identity));
    const byIdentity = new Map<string, unknown>();
    for (const item of valid) byIdentity.set(poller.identity(item as never), item);
    for (const identity of identities) {
      if (changed.has(identity)) continue;
      const item = byIdentity.get(identity);
      const row = existing.get(identity);
      if (item === undefined || !row) continue;
      sequence++;
      out.events.push(
        await buildEventRow(
          deps,
          lane,
          'updated',
          identity,
          row.version ?? row.hash,
          item,
          poller.retain === 'payload' ? row.payload : undefined,
          sequence,
          cursorForEvents,
        ),
      );
      out.counts.updated++;
    }
  }
  out.sequence = sequence;
  void state;
  return out;
}

async function buildEventRow(
  deps: CycleDeps,
  lane: Lane,
  type: EventType,
  identity: string,
  version: string,
  data: unknown,
  previous: unknown,
  sequence: number,
  cursor: unknown,
): Promise<OutboxRow> {
  const { poller, key, clock } = deps;
  const id = await eventId({
    source: poller.source,
    partition: key.partition,
    identity,
    version,
    schemaVersion: poller.schemaVersion,
    type,
  });
  const now = clock.now();
  const event: WatukuyEvent<unknown> = {
    id,
    type,
    source: poller.source,
    subject: identity,
    time: nowIso(now),
    poller: key.poller,
    partition: key.partition,
    lane,
    sequence,
    cursor: typeof cursor === 'string' ? safeParse(cursor) : cursor,
    data,
    attempt: 0,
  };
  if (previous !== undefined) event.previous = previous;
  return {
    eventId: id,
    sequence,
    event,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: now,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
