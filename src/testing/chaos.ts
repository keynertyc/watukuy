/**
 * Seeded chaos harness (see docs/guarantees.md, guarantee G9): drives a real engine against a {@link FakeApi}
 * under a {@link VirtualClock}, mutates the API between ticks, crashes the process at the store
 * boundaries K1..K7 through a {@link FaultyStore}, restarts on a fresh instance, and finally checks
 * the guarantees G1..G5 plus liveness against everything the handler saw.
 *
 * Deterministic: the same {@link ChaosOptions} always produce the same {@link ChaosReport}, trace
 * included, so a failing seed is a reproducible regression test.
 *
 * @example
 * const report = await runChaos({ seed: 7, strategy: 'snapshotDiff', steps: 120 });
 * assertChaosReport(report); // throws with the violations and a replay hint
 * @module
 */

import type { CursorConfig } from '../core/cursor-types.ts';
import { definePoller } from '../core/define-poller.ts';
import { createWatukuy } from '../core/engine.ts';
import type { Engine, TickResult } from '../core/engine-types.ts';
import type { EventHandler, EventType } from '../core/event.ts';
import type { DeliveryConfig, PollerDefinition, ScheduleConfig } from '../core/poller-types.ts';
import type { Logger, Random } from '../core/ports.ts';
import type {
  CommitBatch,
  ItemRow,
  Lease,
  LoggedEvent,
  OutboxRow,
  ParkedRow,
  PKey,
  PollerState,
  StateStore,
  StoreCapabilities,
  Validator,
} from '../core/store-types.ts';
import { MemoryStore } from '../stores/memory/index.ts';
import { FakeApi } from './fake-api.ts';
import { SeededRandom } from './seeded-random.ts';
import { VirtualClock } from './virtual-clock.ts';

// ------------------------------------------------------------------------------------ public types

/**
 * Where the simulated process dies (see docs/how-it-works.md kill points K1..K7, plus a handler failure).
 *
 * - `before-acquire`: `acquireLease` throws before touching the store (K1).
 * - `after-fetch`: `commitPoll` throws before delegating: the page was fetched, nothing persisted (K2).
 * - `after-commit`: `commitPoll` succeeded, then the process dies before dispatch (K3).
 * - `mid-dispatch`: the first `ackEvents` of the cycle succeeds, then the process dies (K4).
 * - `before-ack`: the handler ran, `ackEvents` throws before delegating; the event is redelivered.
 * - `after-ack-before-schedule`: `saveState` throws, the schedule is never persisted (K5/K6).
 * - `during-release`: `releaseLease` throws, the lease lingers until its TTL expires (K7).
 * - `handler`: the consumer throws once (first attempt of one event); not a process crash.
 */
export type KillPoint =
  | 'before-acquire'
  | 'after-fetch'
  | 'after-commit'
  | 'mid-dispatch'
  | 'before-ack'
  | 'after-ack-before-schedule'
  | 'during-release'
  | 'handler';

/** Every {@link KillPoint}, in K1..K7 order, then `handler`. */
export const KILL_POINTS: readonly KillPoint[] = [
  'before-acquire',
  'after-fetch',
  'after-commit',
  'mid-dispatch',
  'before-ack',
  'after-ack-before-schedule',
  'during-release',
  'handler',
];

/** Cursor strategies the harness knows how to drive against the {@link FakeApi}. */
export type ChaosStrategy = 'timestamp' | 'snapshotDiff' | 'token' | 'page';

/** Options for `runChaos()` (see docs/guarantees.md). */
export interface ChaosOptions {
  seed: number;
  /**
   * Simulation steps. Each step: mutate the FakeApi 0..N times, advance the clock by a seeded
   * amount in `[0, 2 * schedule.min]`, run one `engine.tick()`.
   * @default 150
   */
  steps?: number | undefined;
  /** @default 'timestamp' */
  strategy?: ChaosStrategy | undefined;
  /** Kill points that may be armed. `[]` disables crashes. @default 'all' */
  killPoints?: 'all' | KillPoint[] | undefined;
  /** Probability per step that a kill point is armed. @default 0.3 */
  killProbability?: number | undefined;
  /** Max FakeApi mutations per step. @default 3 */
  maxMutationsPerStep?: number | undefined;
  /** Items seeded before the run. @default 20 */
  initialItems?: number | undefined;
  /** Ordering-key concurrency for delivery. @default 3 */
  concurrency?: number | undefined;
  /** Use `retain: 'payload'` to also verify `previous` and `deleted.data`. @default false */
  retainPayload?: boolean | undefined;
  /**
   * Supply a different store (must behave like `MemoryStore`). One instance is shared across
   * simulated restarts. `migrate()` is called once; the store is never closed.
   */
  store?: StateStore | undefined;
  /** Print the trace to the console as it is produced. */
  trace?: boolean | undefined;
}

/** {@link ChaosOptions} with every default applied (minus `store` and `trace`). */
export interface ChaosResolvedOptions {
  seed: number;
  steps: number;
  strategy: ChaosStrategy;
  killPoints: KillPoint[];
  killProbability: number;
  maxMutationsPerStep: number;
  initialItems: number;
  concurrency: number;
  retainPayload: boolean;
}

/** Result of `runChaos()`; empty `violations` means every guarantee held. */
export interface ChaosReport {
  seed: number;
  steps: number;
  strategy: string;
  /** The options the run used, for exact replays. */
  options: ChaosResolvedOptions;
  /** How many times each kill point fired. */
  kills: Record<KillPoint, number>;
  /** Simulated process restarts (one per store-level kill). */
  restarts: number;
  mutations: { added: number; updated: number; removed: number };
  /** Handler invocations that completed. */
  delivered: number;
  /** Distinct event ids delivered. */
  uniqueEvents: number;
  /** `delivered - uniqueEvents`: redeliveries, all sharing an id with an earlier delivery (G2). */
  duplicates: number;
  /** Parked rows after quiescence; anything above `0` is a violation. */
  parked: number;
  /** Ticks needed to reach quiescence after the last mutation. */
  quiescenceTicks: number;
  /** Empty means every invariant held. */
  violations: string[];
  /** Human-readable timeline (last ~200 lines kept). */
  trace: string[];
}

/** The item shape served by the simulated API. */
export type ChaosItem = {
  id: string;
  updatedAt: string;
  value: number;
  [k: string]: unknown;
};

/** Thrown by {@link FaultyStore} (and the chaos handler) to simulate a process dying. */
export class SimulatedCrash extends Error {
  /** The kill point that fired, or `dead-instance` for calls made by an already-dead instance. */
  readonly killPoint: KillPoint | 'dead-instance';
  constructor(killPoint: KillPoint | 'dead-instance', detail?: string) {
    super(`simulated crash: ${killPoint}${detail ? ` (${detail})` : ''}`);
    this.name = 'SimulatedCrash';
    this.killPoint = killPoint;
  }
}

// ------------------------------------------------------------------------------------- constants

const POLLER_NAME = 'chaos';
const KEY: PKey = { poller: POLLER_NAME, partition: '' };
const SCHEDULE_MIN_MS = 5_000;
const LEASE_TTL_MS = 10_000;
const RESTART_ADVANCE_MS = LEASE_TTL_MS + 1_000;
const PAGE_SIZE = 25;
const DISPATCH_BATCH_SIZE = 20;
const TRACE_KEEP = 200;
const MIN_QUIESCENCE_TICKS = 10;
const ASSERT_TRACE_TAIL = 30;

const DEFAULTS = {
  steps: 150,
  strategy: 'timestamp' as ChaosStrategy,
  killProbability: 0.3,
  maxMutationsPerStep: 3,
  initialItems: 20,
  concurrency: 3,
  retainPayload: false,
};

// --------------------------------------------------------------------------------- faulty store

interface TrackedLease {
  owner: string;
  epoch: number;
  expiresAt: number;
  released: boolean;
}

function keyId(key: PKey): string {
  return `${key.poller}/${key.partition}`;
}

function zeroKills(): Record<KillPoint, number> {
  return {
    'before-acquire': 0,
    'after-fetch': 0,
    'after-commit': 0,
    'mid-dispatch': 0,
    'before-ack': 0,
    'after-ack-before-schedule': 0,
    'during-release': 0,
    handler: 0,
  };
}

/**
 * A {@link StateStore} wrapper that crashes the calling instance at an armed {@link KillPoint}.
 *
 * Process-death semantics: once a store-level kill fires for an instance, that instance is dead.
 * Every later call carrying its lease (or its owner id) throws {@link SimulatedCrash} without
 * reaching the store, exactly as if the process were gone: no schedule save, no lease release,
 * no acks. The lease it held lingers until its TTL expires, so the replacement instance must wait
 * it out. Each armed kill fires once, then disarms.
 *
 * Also audits guarantee G5: at most one unexpired lease per key at any time, monotonic epochs,
 * and fenced writes with a superseded or released epoch must be rejected by the inner store.
 * Findings land in {@link FaultyStore.violations}.
 */
export class FaultyStore implements StateStore {
  readonly capabilities: StoreCapabilities;
  /** Kill point that fires on the next matching store call, or `null`. */
  armed: KillPoint | null = null;
  /** Set when a store-level kill fired; the harness clears it after the simulated restart. */
  crashed = false;
  /** Times each kill point fired. */
  readonly kills: Record<KillPoint, number> = zeroKills();
  /** G5 findings, in the order they were detected. */
  readonly violations: string[] = [];
  readonly #inner: StateStore;
  readonly #log: (line: string) => void;
  readonly #dead = new Set<string>();
  readonly #leases = new Map<string, TrackedLease[]>();
  readonly #latestEpoch = new Map<string, number>();

  constructor(inner: StateStore, log: (line: string) => void = () => {}) {
    this.#inner = inner;
    this.#log = log;
    this.capabilities = inner.capabilities;
  }

  /** `true` once a store-level kill has fired for `owner`. */
  isDead(owner: string): boolean {
    return this.#dead.has(owner);
  }

  /**
   * Record that `point` fired, disarm, and (for store-level kills) mark `owner` dead. Returns the
   * error to throw so call sites read `throw store.fire(...)`.
   */
  fire(point: KillPoint, owner: string | null, detail?: string): SimulatedCrash {
    this.armed = null;
    this.kills[point] += 1;
    if (owner !== null) {
      this.#dead.add(owner);
      this.crashed = true;
    }
    this.#log(
      `kill ${point}${owner !== null ? `: ${owner} is dead` : ''}${detail ? ` (${detail})` : ''}`,
    );
    return new SimulatedCrash(point, owner !== null ? owner : undefined);
  }

  #alive(owner: string): void {
    if (this.#dead.has(owner)) {
      throw new SimulatedCrash('dead-instance', `${owner} already crashed`);
    }
  }

  /** Run a fenced write: dead-instance check first, then audit that a stale epoch was rejected. */
  async #fenced<T>(key: PKey, lease: Lease, op: () => Promise<T>): Promise<T> {
    this.#alive(lease.owner);
    const id = keyId(key);
    const latest = this.#latestEpoch.get(id);
    const tracked = this.#leases.get(id)?.find((l) => l.epoch === lease.epoch);
    const result = await op(); // a LeaseLostError here is the store doing its job
    if (tracked?.released === true) {
      this.violations.push(
        `G5: fenced write by ${lease.owner} with released epoch ${lease.epoch} was accepted`,
      );
    } else if (latest !== undefined && lease.epoch !== latest) {
      this.violations.push(
        `G5: fenced write by ${lease.owner} with stale epoch ${lease.epoch} was accepted (current epoch ${latest})`,
      );
    }
    return result;
  }

  async migrate(): Promise<void> {
    return this.#inner.migrate();
  }

  async close(): Promise<void> {
    return this.#inner.close();
  }

  async acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null> {
    this.#alive(owner);
    if (this.armed === 'before-acquire') throw this.fire('before-acquire', owner);
    const lease = await this.#inner.acquireLease(key, owner, ttlMs, now);
    if (!lease) return null;
    const id = keyId(key);
    const live = (this.#leases.get(id) ?? []).filter((l) => !l.released && l.expiresAt > now);
    for (const other of live) {
      if (other.owner !== lease.owner) {
        this.violations.push(
          `G5: ${lease.owner} acquired epoch ${lease.epoch} at ${iso(now)} while ${other.owner} (epoch ${other.epoch}) holds an unexpired lease until ${iso(other.expiresAt)}`,
        );
      }
    }
    const latest = this.#latestEpoch.get(id);
    if (latest !== undefined && lease.epoch <= latest) {
      this.violations.push(
        `G5: epoch ${lease.epoch} handed to ${lease.owner} is not above the previous epoch ${latest}`,
      );
    }
    this.#latestEpoch.set(id, lease.epoch);
    this.#leases.set(id, [
      ...live.filter((l) => l.owner !== lease.owner),
      { owner: lease.owner, epoch: lease.epoch, expiresAt: lease.expiresAt, released: false },
    ]);
    return lease;
  }

  async renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean> {
    this.#alive(lease.owner);
    const ok = await this.#inner.renewLease(key, lease, ttlMs, now);
    if (ok) {
      const tracked = this.#leases.get(keyId(key))?.find((l) => l.epoch === lease.epoch);
      if (tracked) tracked.expiresAt = now + ttlMs;
    }
    return ok;
  }

  async releaseLease(key: PKey, lease: Lease): Promise<void> {
    this.#alive(lease.owner);
    if (this.armed === 'during-release') {
      throw this.fire('during-release', lease.owner, `epoch ${lease.epoch}`);
    }
    await this.#inner.releaseLease(key, lease);
    const tracked = this.#leases.get(keyId(key))?.find((l) => l.epoch === lease.epoch);
    if (tracked) tracked.released = true;
  }

  getLease(key: PKey): Promise<Lease | null> {
    return this.#inner.getLease(key);
  }

  loadState(key: PKey): Promise<PollerState | null> {
    return this.#inner.loadState(key);
  }

  saveState(
    key: PKey,
    lease: Lease,
    patch: Partial<Omit<PollerState, 'createdAt'>>,
  ): Promise<void> {
    return this.#fenced(key, lease, async () => {
      if (this.armed === 'after-ack-before-schedule') {
        throw this.fire('after-ack-before-schedule', lease.owner, `epoch ${lease.epoch}`);
      }
      await this.#inner.saveState(key, lease, patch);
    });
  }

  saveStateUnfenced(key: PKey, patch: Partial<Omit<PollerState, 'createdAt'>>): Promise<void> {
    return this.#inner.saveStateUnfenced(key, patch);
  }

  listKeys(poller?: string): Promise<PKey[]> {
    return this.#inner.listKeys(poller);
  }

  deleteKey(key: PKey): Promise<void> {
    return this.#inner.deleteKey(key);
  }

  clearItems(key: PKey): Promise<void> {
    return this.#inner.clearItems(key);
  }

  loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>> {
    return this.#inner.loadVersions(key, identities);
  }

  streamIdentities(key: PKey, batchSize?: number): AsyncIterable<string[]> {
    return this.#inner.streamIdentities(key, batchSize);
  }

  countItems(key: PKey): Promise<number> {
    return this.#inner.countItems(key);
  }

  commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void> {
    return this.#fenced(key, lease, async () => {
      if (this.armed === 'after-fetch') {
        throw this.fire(
          'after-fetch',
          lease.owner,
          `${batch.events.length} event(s) fetched but not committed`,
        );
      }
      await this.#inner.commitPoll(key, lease, batch);
      if (this.armed === 'after-commit') {
        throw this.fire(
          'after-commit',
          lease.owner,
          `${batch.events.length} event(s) committed, none dispatched`,
        );
      }
    });
  }

  loadPending(key: PKey, limit: number): Promise<OutboxRow[]> {
    return this.#inner.loadPending(key, limit);
  }

  countPending(key: PKey): Promise<number> {
    return this.#inner.countPending(key);
  }

  ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void> {
    return this.#fenced(key, lease, async () => {
      if (this.armed === 'before-ack') {
        throw this.fire('before-ack', lease.owner, `${eventIds.length} delivered, none acked`);
      }
      await this.#inner.ackEvents(key, lease, eventIds);
      if (this.armed === 'mid-dispatch') {
        throw this.fire('mid-dispatch', lease.owner, `${eventIds.length} acked`);
      }
    });
  }

  recordAttempt(
    key: PKey,
    lease: Lease,
    eventId: string,
    error: OutboxRow['lastError'],
    nextAttemptAt: number | null,
  ): Promise<void> {
    return this.#fenced(key, lease, () =>
      this.#inner.recordAttempt(
        key,
        lease,
        eventId,
        error as NonNullable<typeof error>,
        nextAttemptAt,
      ),
    );
  }

  parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void> {
    return this.#fenced(key, lease, () => this.#inner.parkEvent(key, lease, row));
  }

  listParked(
    key: PKey,
    opts?: { kind?: 'poison' | 'invalid'; limit?: number },
  ): Promise<ParkedRow[]> {
    return this.#inner.listParked(key, opts);
  }

  countParked(key: PKey): Promise<number> {
    return this.#inner.countParked(key);
  }

  retryParked(key: PKey, ids: string[]): Promise<number> {
    return this.#inner.retryParked(key, ids);
  }

  discardParked(key: PKey, ids: string[]): Promise<number> {
    return this.#inner.discardParked(key, ids);
  }

  heldKeys(key: PKey): Promise<Set<string>> {
    return this.#inner.heldKeys(key);
  }

  getValidator(key: PKey, urlHash: string): Promise<Validator | null> {
    return this.#inner.getValidator(key, urlHash);
  }

  setValidator(key: PKey, lease: Lease, urlHash: string, validator: Validator): Promise<void> {
    return this.#fenced(key, lease, () => this.#inner.setValidator(key, lease, urlHash, validator));
  }

  readLog(
    key: PKey,
    range: { afterSequence?: number; fromTime?: number; toTime?: number },
    limit: number,
  ): Promise<LoggedEvent[]> {
    return this.#inner.readLog(key, range, limit);
  }

  pruneLog(key: PKey, olderThan: number): Promise<number> {
    return this.#inner.pruneLog(key, olderThan);
  }
}

// ------------------------------------------------------------------------------------ simulation

interface Delivery {
  id: string;
  type: EventType;
  subject: string;
  sequence: number;
  data: unknown;
  previous: unknown;
  attempt: number;
  deliveredAt: number;
  instance: string;
}

interface VersionRecord {
  /** The `updatedAt` the API stamped. */
  version: string;
  /** Exactly what the API served for that version. */
  snapshot: ChaosItem;
  at: number;
}

type ChaosPoller = PollerDefinition<typeof POLLER_NAME, ChaosItem, CursorConfig, undefined>;
type ChaosEngine = Engine<{ [POLLER_NAME]: ChaosPoller }>;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function short(id: string): string {
  return id.slice(0, 10);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : json(err);
}

/** Structural equality for JSON-like values; key order is irrelevant. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  return keys.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
}

function resolveOptions(options: ChaosOptions): ChaosResolvedOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('runChaos(options) requires an object');
  }
  if (typeof options.seed !== 'number' || !Number.isFinite(options.seed)) {
    throw new RangeError(`runChaos: seed must be a finite number, got ${String(options.seed)}`);
  }
  const steps = options.steps ?? DEFAULTS.steps;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new RangeError(`runChaos: steps must be a positive integer, got ${steps}`);
  }
  const strategy = options.strategy ?? DEFAULTS.strategy;
  if (!['timestamp', 'snapshotDiff', 'token', 'page'].includes(strategy)) {
    throw new RangeError(`runChaos: unknown strategy ${json(strategy)}`);
  }
  const killPoints =
    options.killPoints === undefined || options.killPoints === 'all'
      ? [...KILL_POINTS]
      : options.killPoints.slice();
  for (const kp of killPoints) {
    if (!KILL_POINTS.includes(kp)) throw new RangeError(`runChaos: unknown kill point ${json(kp)}`);
  }
  const killProbability = options.killProbability ?? DEFAULTS.killProbability;
  if (!(killProbability >= 0 && killProbability <= 1)) {
    throw new RangeError(`runChaos: killProbability must be in [0, 1], got ${killProbability}`);
  }
  const maxMutationsPerStep = options.maxMutationsPerStep ?? DEFAULTS.maxMutationsPerStep;
  if (!Number.isInteger(maxMutationsPerStep) || maxMutationsPerStep < 0) {
    throw new RangeError(
      `runChaos: maxMutationsPerStep must be a non-negative integer, got ${maxMutationsPerStep}`,
    );
  }
  const initialItems = options.initialItems ?? DEFAULTS.initialItems;
  if (!Number.isInteger(initialItems) || initialItems < 0) {
    throw new RangeError(
      `runChaos: initialItems must be a non-negative integer, got ${initialItems}`,
    );
  }
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`runChaos: concurrency must be a positive integer, got ${concurrency}`);
  }
  return {
    seed: options.seed,
    steps,
    strategy,
    killPoints,
    killProbability,
    maxMutationsPerStep,
    initialItems,
    concurrency,
    retainPayload: options.retainPayload ?? DEFAULTS.retainPayload,
  };
}

/**
 * Build the poller under test.
 *
 * - `timestamp` declares `version: updatedAt` and `lag: '1s'`. The lag matters: the FakeApi stamps
 *   `updatedAt` with the virtual clock, and a mutation can land at the very same millisecond as a
 *   poll but after it, which is the "late row at the watermark" race `lag` exists for.
 * - `snapshotDiff`, `token` and `page` re-list everything each cycle and rely on the fingerprint
 *   hash instead of `version`: the virtual clock may stand still across steps, so two updates can
 *   share one `updatedAt`, and an `updatedAt` version would (correctly, per its contract) hide the
 *   second one. Hashing exercises the other half of see docs/cursors.md.
 */
function buildPoller(
  strategy: ChaosStrategy,
  api: FakeApi<ChaosItem>,
  opts: ChaosResolvedOptions,
): ChaosPoller {
  const identity = (o: ChaosItem): string => o.id;
  const schedule: ScheduleConfig = { min: '5s', max: '30s', jitter: 0 };
  const delivery: DeliveryConfig<ChaosItem> = {
    concurrency: opts.concurrency,
    retry: { attempts: 3, backoff: { base: '1s', factor: 2, max: '4s' } },
  };
  const retain: 'hash' | 'payload' = opts.retainPayload ? 'payload' : 'hash';

  switch (strategy) {
    case 'timestamp':
      return definePoller({
        name: POLLER_NAME,
        identity,
        version: (o: ChaosItem) => o.updatedAt,
        cursor: {
          strategy: 'timestamp',
          field: 'updatedAt',
          tieBreak: 'id',
          initial: null,
          lag: '1s',
        },
        fetch: async ({ cursor }) => {
          const res = api.listSince({
            since: cursor.value,
            afterId: cursor.tieBreak,
            limit: PAGE_SIZE,
          });
          return { items: res.items, hasMore: res.hasMore };
        },
        schedule,
        delivery,
        retain,
      });
    case 'snapshotDiff':
      return definePoller({
        name: POLLER_NAME,
        identity,
        cursor: { strategy: 'snapshotDiff' },
        fetch: async ({ page }) => {
          const res = api.listPage({ page, limit: PAGE_SIZE });
          return { items: res.items, hasMore: res.hasMore };
        },
        schedule,
        delivery,
        retain,
      });
    case 'token':
      return definePoller({
        name: POLLER_NAME,
        identity,
        cursor: { strategy: 'token', initial: null },
        fetch: async ({ cursor }) => {
          const res = api.listToken({ token: cursor.value, limit: PAGE_SIZE });
          return { items: res.items, cursor: res.next, hasMore: res.next !== null };
        },
        schedule,
        delivery,
        retain,
      });
    case 'page':
      return definePoller({
        name: POLLER_NAME,
        identity,
        cursor: { strategy: 'page', initial: 1 },
        fetch: async ({ cursor }) => {
          const res = api.listPage({ page: cursor.page, limit: PAGE_SIZE });
          return { items: res.items, hasMore: res.hasMore };
        },
        schedule,
        delivery,
        retain,
      });
  }
}

class ChaosRun {
  readonly opts: ChaosResolvedOptions;
  readonly clock = new VirtualClock();
  readonly startedAt: number;
  readonly killRng: SeededRandom;
  readonly mutationRng: SeededRandom;
  readonly clockRng: SeededRandom;
  readonly engineRandom: Random;
  readonly api: FakeApi<ChaosItem>;
  readonly inner: StateStore;
  readonly faulty: FaultyStore;
  readonly poller: ChaosPoller;
  readonly logger: Logger;
  readonly history = new Map<string, VersionRecord[]>();
  readonly removedAt = new Map<string, number>();
  readonly deliveries: Delivery[] = [];
  readonly violations: string[] = [];
  readonly lines: string[] = [];
  readonly mutations = { added: 0, updated: 0, removed: 0 };
  readonly echo: boolean;
  engine: ChaosEngine | null = null;
  instances = 0;
  restarts = 0;
  nextItem = 0;

  constructor(options: ChaosOptions) {
    this.opts = resolveOptions(options);
    this.echo = options.trace === true;
    this.startedAt = this.clock.now();
    const root = new SeededRandom(this.opts.seed);
    this.killRng = root.fork();
    this.mutationRng = root.fork();
    this.clockRng = root.fork();
    this.engineRandom = root.fork();
    this.api = new FakeApi<ChaosItem>({
      clock: this.clock,
      identity: (o) => o.id,
      timestampField: 'updatedAt',
      pageSize: PAGE_SIZE,
    });
    this.inner = options.store ?? new MemoryStore();
    this.faulty = new FaultyStore(this.inner, (line) => this.log(line));
    this.poller = buildPoller(this.opts.strategy, this.api, this.opts);
    this.logger = {
      debug: () => {},
      info: () => {},
      warn: (message, meta) => this.log(`warn: ${message}${meta ? ` ${json(meta)}` : ''}`),
      error: (message, meta) => this.log(`error: ${message}${meta ? ` ${json(meta)}` : ''}`),
    };
  }

  log(line: string): void {
    const elapsed = ((this.clock.now() - this.startedAt) / 1000).toFixed(1).padStart(7);
    const entry = `+${elapsed}s ${line}`;
    this.lines.push(entry);
    if (this.echo) console.log(entry);
  }

  // ---- the API under observation -------------------------------------------------------------

  record(stored: ChaosItem): void {
    const list = this.history.get(stored.id) ?? [];
    list.push({ version: stored.updatedAt, snapshot: stored, at: this.clock.now() });
    this.history.set(stored.id, list);
  }

  addItem(): ChaosItem {
    this.nextItem += 1;
    const id = `item-${String(this.nextItem).padStart(5, '0')}`;
    const stored = this.api.add({ id, updatedAt: '', value: this.mutationRng.int(0, 999) });
    this.record(stored);
    return stored;
  }

  /**
   * Seeded mutations for one step. `page` is append-only: page-number pagination over a mutable,
   * identity-sorted collection is unstable (an insert or removal before the current page shifts
   * items across page boundaries while a listing is in progress, and a listing interrupted by a
   * crash resumes at the persisted page number), so the strategy is only incremental, and only
   * documented, for append-only APIs. Deletes never produce events outside `snapshotDiff`; the
   * other strategies still remove items, and the checks simply do not expect `deleted` there.
   */
  mutate(): number {
    const count = this.mutationRng.int(0, this.opts.maxMutationsPerStep);
    const done: string[] = [];
    for (let i = 0; i < count; i++) {
      const roll = this.mutationRng.next();
      const existing = this.opts.strategy === 'page' ? [] : this.api.all();
      if (existing.length === 0 || roll < 0.4) {
        const item = this.addItem();
        this.mutations.added += 1;
        done.push(`+${item.id}`);
      } else if (roll < 0.8) {
        const target = this.mutationRng.pick(existing);
        const stored = this.api.update(target.id, { value: target.value + 1 });
        this.record(stored);
        this.mutations.updated += 1;
        done.push(`~${target.id}=${stored.value}`);
      } else {
        const target = this.mutationRng.pick(existing);
        this.api.remove(target.id);
        this.removedAt.set(target.id, this.clock.now());
        this.mutations.removed += 1;
        done.push(`-${target.id}`);
      }
    }
    if (done.length > 0) this.log(`mutate ${done.join(' ')} (api size ${this.api.size})`);
    return count;
  }

  // ---- the engine under test -----------------------------------------------------------------

  handlerFor(instanceId: string): EventHandler<ChaosItem> {
    return (event) => {
      if (this.faulty.isDead(instanceId)) {
        throw new SimulatedCrash('dead-instance', `${instanceId} cannot run handlers`);
      }
      if (this.faulty.armed === 'handler' && event.attempt === 1) {
        throw this.faulty.fire(
          'handler',
          null,
          `${event.type} ${event.subject} seq ${event.sequence}`,
        );
      }
      this.deliveries.push({
        id: event.id,
        type: event.type,
        subject: event.subject,
        sequence: event.sequence,
        data: event.data,
        previous: event.previous,
        attempt: event.attempt,
        deliveredAt: this.clock.now(),
        instance: instanceId,
      });
    };
  }

  spawn(): ChaosEngine {
    this.instances += 1;
    const instanceId = `inst-${this.instances}`;
    const engine = createWatukuy({
      store: this.faulty,
      pollers: { [POLLER_NAME]: this.poller },
      clock: this.clock,
      random: this.engineRandom,
      logger: this.logger,
      instanceId,
      lease: { ttl: `${LEASE_TTL_MS}ms` },
      dispatchBatchSize: DISPATCH_BATCH_SIZE,
      hooks: {
        onLeaseLost: (ctx) => this.log(`hook onLeaseLost ${ctx.instanceId} epoch ${ctx.epoch}`),
        onCircuitOpen: (ctx) =>
          this.log(`hook onCircuitOpen failures=${ctx.failures} probeAt=${iso(ctx.probeAt)}`),
        onCircuitClose: (ctx) => this.log(`hook onCircuitClose ${ctx.instanceId}`),
        onParked: (ctx) =>
          this.log(
            `hook onParked ${ctx.row.kind} ${short(ctx.row.id)} ${ctx.row.event?.subject ?? ''}: ${ctx.row.error.message}`,
          ),
      },
    });
    engine.on(POLLER_NAME, this.handlerFor(instanceId));
    this.engine = engine;
    this.log(`spawn ${instanceId}`);
    return engine;
  }

  async restart(reason: string): Promise<void> {
    this.engine = null;
    await this.clock.advance(RESTART_ADVANCE_MS);
    this.restarts += 1;
    this.faulty.crashed = false;
    this.log(`restart #${this.restarts} (${reason}); lease TTL elapsed`);
    this.spawn();
  }

  async tick(label: string): Promise<{ delivered: number; cycles: number }> {
    const engine = this.engine ?? this.spawn();
    const instanceId = engine.instanceId;
    const before = this.deliveries.length;
    let result: TickResult | null = null;
    let thrown: unknown = null;
    try {
      result = await engine.tick();
    } catch (err) {
      thrown = err;
      if (!(err instanceof SimulatedCrash)) {
        this.violations.push(`engine.tick() threw unexpectedly: ${describeError(err)}`);
        this.faulty.crashed = true;
      }
    }
    await this.clock.flush();
    const delivered = this.deliveries.length - before;
    const pending = await this.inner.countPending(KEY);
    const parts: string[] = [];
    if (result) {
      for (const p of result.polled) {
        const err = p.error;
        parts.push(
          `${p.lane}[items=${p.items} events=${p.events}${err ? ` error=${err.name}` : ''}]`,
        );
        if (err && err.name !== 'SimulatedCrash') {
          this.violations.push(
            `unexpected ${p.lane} cycle error on ${instanceId}: ${err.name}: ${err.message}`,
          );
        }
      }
      if (result.skippedNotDue > 0) parts.push('not-due');
      if (result.skippedLeased > 0) parts.push('leased');
    } else {
      parts.push(`threw ${describeError(thrown)}`);
    }
    this.log(
      `tick ${label} ${instanceId}: ${parts.join(' ')} delivered=${delivered} pending=${pending}`,
    );
    return { delivered, cycles: result?.polled.length ?? 0 };
  }

  async step(index: number): Promise<void> {
    if (this.faulty.crashed) await this.restart(`crash in step ${index - 1}`);
    const arm = this.killRng.chance(this.opts.killProbability);
    if (arm && this.opts.killPoints.length > 0) {
      this.faulty.armed = this.killRng.pick(this.opts.killPoints);
      this.log(`arm ${this.faulty.armed}`);
    }
    this.mutate();
    await this.clock.advance(this.clockRng.int(0, 2 * SCHEDULE_MIN_MS));
    await this.tick(`#${index}`);
  }

  /**
   * Disarm, stop mutating, and keep ticking (with clock advances) until the system is quiet: at
   * least {@link MIN_QUIESCENCE_TICKS} ticks, at least two completed poll cycles, two consecutive
   * ticks without a delivery, and an empty outbox. Bounded by `steps` ticks.
   */
  async quiesce(): Promise<number> {
    this.faulty.armed = null;
    this.log('quiescence: kills disarmed, mutations stopped');
    const max = Math.max(this.opts.steps, MIN_QUIESCENCE_TICKS);
    let quiet = 0;
    let cycles = 0;
    let n = 0;
    while (n < max) {
      n += 1;
      if (this.faulty.crashed) await this.restart('crash carried into quiescence');
      await this.clock.advance(this.clockRng.int(0, 2 * SCHEDULE_MIN_MS));
      const r = await this.tick(`q${n}`);
      cycles += r.cycles;
      quiet = r.delivered === 0 ? quiet + 1 : 0;
      const pending = await this.inner.countPending(KEY);
      if (n >= MIN_QUIESCENCE_TICKS && cycles >= 2 && quiet >= 2 && pending === 0) break;
    }
    return n;
  }

  // ---- invariants ----------------------------------------------------------------------------

  evaluate(pending: number, parked: number): { unique: number } {
    const v = this.violations;
    const firstById = new Map<string, Delivery>();
    const bySubject = new Map<string, Delivery[]>();

    // G2: redeliveries are exact copies of the first delivery.
    for (const d of this.deliveries) {
      const first = firstById.get(d.id);
      if (!first) {
        firstById.set(d.id, d);
      } else if (
        first.type !== d.type ||
        first.subject !== d.subject ||
        !deepEqual(first.data, d.data) ||
        !deepEqual(first.previous, d.previous)
      ) {
        v.push(
          `G2: event ${short(d.id)} redelivered with a different payload: first ${first.type} ${first.subject} seq ${first.sequence} ${json(first.data)}, then ${d.type} ${d.subject} seq ${d.sequence} ${json(d.data)}`,
        );
      } else if (first.sequence !== d.sequence) {
        v.push(
          `G2/G4: event ${short(d.id)} (${d.type} ${d.subject}) reached the outbox twice, as seq ${first.sequence} and seq ${d.sequence}`,
        );
      }
      const list = bySubject.get(d.subject);
      if (list) list.push(d);
      else bySubject.set(d.subject, [d]);
    }

    for (const [subject, list] of bySubject) {
      const versions = this.history.get(subject) ?? [];
      const seen = new Set<string>();
      let lastSeq = Number.NEGATIVE_INFINITY;
      let lastType: EventType | null = null;
      let prevData: unknown;
      for (const d of list) {
        if (seen.has(d.id)) {
          // G3: a redelivery may repeat the newest event, never resurrect an older one.
          if (d.sequence < lastSeq) {
            v.push(
              `G3: ${subject}: seq ${d.sequence} (${d.type}) redelivered after seq ${lastSeq} had already been delivered`,
            );
          }
          continue;
        }
        seen.add(d.id);
        // G3: distinct events per ordering key arrive in observation (sequence) order.
        if (!(d.sequence > lastSeq)) {
          v.push(`G3: ${subject}: seq ${d.sequence} (${d.type}) delivered after seq ${lastSeq}`);
        }
        // G1 lifecycle: created, then updated*, then at most one deleted.
        if (lastType === null && d.type !== 'created') {
          v.push(
            `G1: ${subject}: first delivered event is ${d.type} (seq ${d.sequence}); the created event was lost`,
          );
        } else if (lastType === 'deleted') {
          v.push(
            `G1: ${subject}: ${d.type} (seq ${d.sequence}) delivered after deleted (seq ${lastSeq})`,
          );
        } else if (lastType !== null && d.type === 'created') {
          v.push(
            `G1: ${subject}: created (seq ${d.sequence}) delivered again after ${lastType} (seq ${lastSeq}) without a deleted in between`,
          );
        }
        // G1 no phantom versions: created/updated data must be something the API actually served.
        if (d.type !== 'deleted' && !versions.some((ver) => deepEqual(ver.snapshot, d.data))) {
          v.push(
            `G1: ${d.type} ${subject} seq ${d.sequence} carries data the API never served: ${json(d.data)} (known versions: ${versions.map((x) => x.version).join(', ') || 'none'})`,
          );
        }
        // retain: 'payload' → previous / deleted.data equal the last delivered payload.
        if (this.opts.retainPayload) {
          if (d.type === 'updated' && !deepEqual(d.previous, prevData)) {
            v.push(
              `G1: updated ${subject} seq ${d.sequence} has previous=${json(d.previous)} but the last delivered payload was ${json(prevData)}`,
            );
          }
          if (d.type === 'deleted' && !deepEqual(d.data, prevData)) {
            v.push(
              `G1: deleted ${subject} seq ${d.sequence} has data=${json(d.data)} but the last delivered payload was ${json(prevData)}`,
            );
          }
        } else {
          if (d.previous !== undefined) {
            v.push(`retain 'hash': ${d.type} ${subject} seq ${d.sequence} carries previous`);
          }
          if (d.type === 'deleted' && d.data !== undefined) {
            v.push(`retain 'hash': deleted ${subject} seq ${d.sequence} carries data`);
          }
        }
        lastSeq = Math.max(lastSeq, d.sequence);
        lastType = d.type;
        if (d.type !== 'deleted') prevData = d.data;
      }
    }

    // G1 convergence: what the API has now is what the handler last heard, per identity.
    const newest = (list: Delivery[]): Delivery =>
      list.reduce((best, d) => (d.sequence > best.sequence ? d : best));
    for (const item of this.api.all()) {
      const list = bySubject.get(item.id);
      if (!list || list.length === 0) {
        v.push(
          `G1: item ${item.id} (updatedAt ${item.updatedAt}) exists in the API but no event was ever delivered for it`,
        );
        continue;
      }
      const last = newest(list);
      if (last.type === 'deleted') {
        v.push(
          `G1: item ${item.id} exists in the API but its newest delivered event is deleted (seq ${last.sequence})`,
        );
      } else if (!deepEqual(last.data, item)) {
        v.push(
          `G1: item ${item.id} did not converge: newest delivered ${last.type} seq ${last.sequence} has ${json(last.data)}, the API has ${json(item)}`,
        );
      }
    }
    if (this.opts.strategy === 'snapshotDiff') {
      for (const [id, at] of this.removedAt) {
        const list = bySubject.get(id);
        if (!list || list.length === 0) continue; // never observed: A→B→A compaction
        const last = newest(list);
        if (last.type !== 'deleted') {
          v.push(
            `G1: item ${id} was removed at ${iso(at)} but its newest delivered event is ${last.type} (seq ${last.sequence}), not deleted`,
          );
        }
      }
    }

    // G4 / G7: nothing left behind.
    if (pending !== 0) v.push(`G4: ${pending} outbox row(s) still pending after quiescence`);
    if (parked !== 0) {
      v.push(
        `G7: ${parked} parked row(s) after quiescence; a handler never fails twice on one event here, so nothing should reach 3 attempts`,
      );
    }

    // Liveness.
    const total = this.mutations.added + this.mutations.updated + this.mutations.removed;
    if (this.deliveries.length === 0 && (total > 0 || this.opts.initialItems > 0)) {
      v.push('liveness: no event was delivered at all');
    }

    // G5 from the store audit.
    v.push(...this.faulty.violations);

    return { unique: firstById.size };
  }

  async run(): Promise<ChaosReport> {
    await this.inner.migrate();
    this.log(
      `start seed=${this.opts.seed} strategy=${this.opts.strategy} steps=${this.opts.steps} killPoints=[${this.opts.killPoints.join(',')}] p=${this.opts.killProbability} retain=${this.opts.retainPayload ? 'payload' : 'hash'}`,
    );
    for (let i = 0; i < this.opts.initialItems; i++) this.addItem();
    if (this.opts.initialItems > 0) this.log(`seeded ${this.opts.initialItems} items`);

    for (let i = 1; i <= this.opts.steps; i++) await this.step(i);
    if (this.faulty.crashed) await this.restart(`crash in step ${this.opts.steps}`);
    const quiescenceTicks = await this.quiesce();

    const pending = await this.inner.countPending(KEY);
    const parked = await this.inner.countParked(KEY);
    const { unique } = this.evaluate(pending, parked);
    const kills = { ...this.faulty.kills };
    for (const violation of this.violations) this.log(`VIOLATION ${violation}`);
    this.log(
      `done: delivered=${this.deliveries.length} unique=${unique} restarts=${this.restarts} violations=${this.violations.length}`,
    );
    return {
      seed: this.opts.seed,
      steps: this.opts.steps,
      strategy: this.opts.strategy,
      options: { ...this.opts, killPoints: [...this.opts.killPoints] },
      kills,
      restarts: this.restarts,
      mutations: { ...this.mutations },
      delivered: this.deliveries.length,
      uniqueEvents: unique,
      duplicates: this.deliveries.length - unique,
      parked,
      quiescenceTicks,
      violations: [...this.violations],
      trace: this.lines.slice(-TRACE_KEEP),
    };
  }
}

// ---------------------------------------------------------------------------------------- api

/**
 * Run one seeded simulation. Deterministic: the same options always produce the same report,
 * trace included.
 *
 * Every step arms a random {@link KillPoint} with probability `killProbability` (an armed kill that
 * did not fire stays armed), applies 0..`maxMutationsPerStep` seeded add/update/remove mutations
 * to the FakeApi, advances the virtual clock by a seeded `[0, 2 * schedule.min]`, and runs one
 * `engine.tick()`. After a store-level kill the engine is dropped without `stop()`, the clock moves
 * past the lease TTL, and a fresh instance (`inst-N`) on the same store takes over. At the end the
 * harness disarms everything and ticks until quiescence, then evaluates G1 (convergence, no
 * phantom versions, lifecycle), G2 (duplicates share ids and payloads), G3 (per-key order), G4/G7
 * (empty outbox, nothing parked), G5 (lease exclusivity and fencing) and liveness.
 *
 * @example
 * const report = await runChaos({ seed: 1, strategy: 'timestamp', steps: 120 });
 * console.log(describeChaos(report));
 * assertChaosReport(report);
 */
export async function runChaos(options: ChaosOptions): Promise<ChaosReport> {
  return new ChaosRun(options).run();
}

/**
 * Throw an `Error` listing every violation in `report`, with the seed, an exact replay hint and
 * the tail of the trace. No-op when the report is clean.
 *
 * @example
 * assertChaosReport(await runChaos({ seed: 42 }));
 */
export function assertChaosReport(report: ChaosReport): void {
  if (report.violations.length === 0) return;
  const o = report.options;
  const replay: string[] = [`seed: ${o.seed}`, `strategy: '${o.strategy}'`, `steps: ${o.steps}`];
  if (o.killPoints.length !== KILL_POINTS.length) {
    replay.push(`killPoints: [${o.killPoints.map((k) => `'${k}'`).join(', ')}]`);
  }
  if (o.killProbability !== DEFAULTS.killProbability)
    replay.push(`killProbability: ${o.killProbability}`);
  if (o.maxMutationsPerStep !== DEFAULTS.maxMutationsPerStep) {
    replay.push(`maxMutationsPerStep: ${o.maxMutationsPerStep}`);
  }
  if (o.initialItems !== DEFAULTS.initialItems) replay.push(`initialItems: ${o.initialItems}`);
  if (o.concurrency !== DEFAULTS.concurrency) replay.push(`concurrency: ${o.concurrency}`);
  if (o.retainPayload) replay.push('retainPayload: true');
  const tail = report.trace.slice(-ASSERT_TRACE_TAIL);
  const lines = [
    `${report.violations.length} chaos invariant violation(s) for seed ${report.seed} (strategy '${report.strategy}', ${report.steps} steps):`,
    ...report.violations.map((x) => `  - ${x}`),
    `Replay: runChaos({ ${replay.join(', ')}, trace: true })`,
    `Trace tail (${tail.length} of ${report.trace.length} kept lines):`,
    ...tail.map((x) => `  ${x}`),
  ];
  throw new Error(lines.join('\n'));
}

/**
 * One-line summary of a report, for CI logs.
 *
 * @example
 * describeChaos(report);
 * // 'chaos seed=1 strategy=timestamp steps=120 kills=31 restarts=27 mutations=+70/~65/-40 delivered=212 unique=201 duplicates=11 parked=0 violations=0'
 */
export function describeChaos(report: ChaosReport): string {
  const kills = Object.values(report.kills).reduce((a, b) => a + b, 0);
  const m = report.mutations;
  return `chaos seed=${report.seed} strategy=${report.strategy} steps=${report.steps} kills=${kills} restarts=${report.restarts} mutations=+${m.added}/~${m.updated}/-${m.removed} delivered=${report.delivered} unique=${report.uniqueEvents} duplicates=${report.duplicates} parked=${report.parked} violations=${report.violations.length}`;
}
