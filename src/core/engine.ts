import { BudgetManager, MemoryBudgetStore } from '../budget/index.ts';
import { getStrategy } from '../cursor/index.ts';
import { initialScheduleState, makeDue } from '../scheduler/index.ts';
import { MemoryStore } from '../stores/memory/index.ts';
import { type Consumer, handlerConsumer, SubscribeConsumer } from './consumers.ts';
import { isPollerDefinition } from './define-poller.ts';
import { parseDuration } from './duration.ts';
import type {
  BackfillOptions,
  Engine,
  EngineOptions,
  EngineStatus,
  InspectReport,
  PollerInspect,
  PollerMap,
  ReplayOptions,
  ReplayResult,
  ResetCursorOptions,
  StopOptions,
  SubscribeOptions,
  TickOptions,
  TickResult,
} from './engine-types.ts';
import { ConfigError, ReplayUnavailableError, WatukuyError } from './errors.ts';
import type { EventHandler, WatukuyEvent } from './event.ts';
import { composeHooks } from './hooks.ts';
import { defaultLogger } from './logger.ts';
import type { ItemOf, Partition, ResolvedPoller } from './poller-types.ts';
import type { Clock, Hooks, Random } from './ports.ts';
import { runKey } from './runner.ts';
import type { OutboxRow, PKey, PollerState, StateStore } from './store-types.ts';

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const systemRandom: Random = { next: () => Math.random() };

/** How long the daemon sleeps at most before re-reading the store for external changes. */
const MAX_SLEEP_MS = 30_000;
const TICK_CONCURRENCY = 4;

interface PollerRuntime {
  def: ResolvedPoller;
  partitions: Partition<unknown>[];
  partitionsLoadedAt: number | null;
  consumer: Consumer<unknown> | null;
  warnedNoConsumer: boolean;
}

function keyId(key: PKey): string {
  return JSON.stringify([key.poller, key.partition]);
}

function randomId(random: Random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(random.next() * alphabet.length)];
  return s;
}

/**
 * Create the engine (PLAN §4). Register handlers with `on()` or consume with `subscribe()`, then
 * `start()` for daemon mode or call `tick()` from any scheduler for serverless mode.
 *
 * @example
 * const engine = createWatukuy({ store: new SqliteStore({ path: './watukuy.db' }), pollers: { orders } });
 * engine.on('orders', async (event) => { ... });
 * await engine.start();
 */
export function createWatukuy<const P extends PollerMap>(options: EngineOptions<P>): Engine<P> {
  return new WatukuyEngine(options);
}

class WatukuyEngine<P extends PollerMap> implements Engine<P> {
  readonly instanceId: string;
  private _status: EngineStatus = 'idle';
  private readonly store: StateStore;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly logger;
  private readonly hooks: Required<Hooks>;
  private readonly budget: BudgetManager | null;
  private readonly pollers = new Map<string, PollerRuntime>();
  private readonly leaseTtlMs: number;
  private readonly leaseRenewMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly dispatchBatchSize: number;
  private readonly nextDue = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private timer: unknown = null;
  private abort = new AbortController();
  private wakeRequested = false;

  constructor(options: EngineOptions<P>) {
    if (!options || typeof options !== 'object')
      throw new ConfigError('createWatukuy(options) requires an object');
    if (!options.store)
      throw new ConfigError(
        'createWatukuy: store is required (MemoryStore, SqliteStore, PostgresStore, RedisStore)',
      );
    if (!options.pollers || typeof options.pollers !== 'object')
      throw new ConfigError('createWatukuy: pollers must be an object of definePoller() results');
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
    this.logger = options.logger ?? defaultLogger();
    this.instanceId = options.instanceId ?? `watukuy-${randomId(this.random)}`;
    const hookSets =
      options.hooks === undefined
        ? []
        : Array.isArray(options.hooks)
          ? options.hooks
          : [options.hooks];
    this.hooks = composeHooks(hookSets, this.logger);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.dispatchBatchSize = options.dispatchBatchSize ?? 100;
    this.leaseTtlMs = parseDuration(options.lease?.ttl ?? '30s', 'lease.ttl');
    this.leaseRenewMs = parseDuration(
      options.lease?.renewEvery ?? Math.floor(this.leaseTtlMs / 3),
      'lease.renewEvery',
    );
    if (this.leaseRenewMs >= this.leaseTtlMs)
      throw new ConfigError('lease.renewEvery must be shorter than lease.ttl');

    const names = new Set<string>();
    for (const [key, def] of Object.entries(options.pollers)) {
      if (!isPollerDefinition(def))
        throw new ConfigError(`pollers.${key} is not a definePoller() result`);
      if (def.name !== key) {
        throw new ConfigError(
          `pollers.${key} has name '${def.name}'; the object key must equal the poller name`,
        );
      }
      if (names.has(def.name)) throw new ConfigError(`duplicate poller name '${def.name}'`);
      names.add(def.name);
      const resolved = def.resolved;
      if (resolved.source === `urn:watukuy:${resolved.name}` && options.sourcePrefix) {
        resolved.source = `${options.sourcePrefix}${resolved.name}`;
      }
      this.pollers.set(def.name, {
        def: resolved,
        partitions: resolved.partitions ? [] : [{ key: '', data: undefined }],
        partitionsLoadedAt: resolved.partitions ? null : 0,
        consumer: null,
        warnedNoConsumer: false,
      });
    }
    const budgets = options.budgets ?? {};
    for (const rt of this.pollers.values()) {
      if (rt.def.budget !== undefined && !(rt.def.budget in budgets)) {
        throw new ConfigError(
          `poller '${rt.def.name}' references unknown budget '${rt.def.budget}'`,
        );
      }
    }
    this.budget =
      Object.keys(budgets).length > 0
        ? new BudgetManager({
            budgets,
            store: options.budgetStore ?? new MemoryBudgetStore(),
            clock: this.clock,
            hooks: {
              onBudgetWait: (info) =>
                void this.hooks.onBudgetWait({
                  poller: info.requester.split('/')[0] ?? '',
                  partition: info.requester.split('/').slice(1).join('/'),
                  lane: 'live',
                  instanceId: this.instanceId,
                  budget: info.budget,
                  waitMs: info.waitMs,
                }),
            },
          })
        : null;
  }

  get status(): EngineStatus {
    return this._status;
  }

  private rt(name: string): PollerRuntime {
    const rt = this.pollers.get(name);
    if (!rt) throw new WatukuyError('UNKNOWN_POLLER', `unknown poller '${name}'`);
    return rt;
  }

  // ---- consumers -------------------------------------------------------------------------

  on<K extends keyof P & string>(name: K, handler: EventHandler<ItemOf<P[K]>>): () => void {
    const rt = this.rt(name);
    if (rt.consumer) {
      throw new ConfigError(
        `poller '${name}' already has a ${rt.consumer.kind === 'iterator' ? 'subscribe() iterator' : 'handler'}; one consumer per poller`,
      );
    }
    if (typeof handler !== 'function')
      throw new ConfigError(`engine.on('${name}', handler): handler must be a function`);
    const consumer = handlerConsumer(handler as EventHandler<unknown>, rt.def.delivery.ackMode);
    rt.consumer = consumer;
    this.requestWake();
    return () => {
      if (rt.consumer === consumer) rt.consumer = null;
    };
  }

  subscribe<K extends keyof P & string>(
    name: K,
    options: SubscribeOptions = {},
  ): AsyncIterable<WatukuyEvent<ItemOf<P[K]>>> {
    const rt = this.rt(name);
    if (rt.consumer)
      throw new ConfigError(`poller '${name}' already has a consumer; one consumer per poller`);
    const consumer = new SubscribeConsumer<ItemOf<P[K]>>(options.signal);
    rt.consumer = consumer as unknown as Consumer<unknown>;
    const detach = (): void => {
      if (rt.consumer === (consumer as unknown as Consumer<unknown>)) rt.consumer = null;
    };
    options.signal?.addEventListener('abort', detach, { once: true });
    this.requestWake();
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        const it = consumer[Symbol.asyncIterator]();
        return {
          next: () => it.next(),
          return: async () => {
            const r = await it.return?.();
            detach();
            return r ?? { value: undefined, done: true };
          },
          throw: async (e?: unknown) => {
            const r = await it.throw?.(e);
            detach();
            self.logger.debug('subscriber threw', {});
            return r ?? { value: undefined, done: true };
          },
        };
      },
    };
  }

  // ---- partitions ------------------------------------------------------------------------

  private async refreshPartitions(rt: PollerRuntime, force = false): Promise<Partition<unknown>[]> {
    if (!rt.def.partitions) return rt.partitions;
    const now = this.clock.now();
    if (
      !force &&
      rt.partitionsLoadedAt !== null &&
      now - rt.partitionsLoadedAt < rt.def.partitionsRefreshMs
    ) {
      return rt.partitions;
    }
    let list: Partition<unknown>[];
    try {
      list = await rt.def.partitions();
    } catch (err) {
      this.logger.error(`partitions() failed for poller '${rt.def.name}'`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return rt.partitions;
    }
    if (!Array.isArray(list))
      throw new ConfigError(`poller '${rt.def.name}': partitions() must return an array`);
    const seen = new Set<string>();
    for (const p of list) {
      if (!p || typeof p.key !== 'string' || p.key.length === 0) {
        throw new ConfigError(
          `poller '${rt.def.name}': every partition needs a non-empty string key`,
        );
      }
      if (seen.has(p.key))
        throw new ConfigError(`poller '${rt.def.name}': duplicate partition key '${p.key}'`);
      seen.add(p.key);
    }
    // Pause partitions that disappeared (PLAN §5.8: paused, not deleted).
    for (const old of rt.partitions) {
      if (!seen.has(old.key)) {
        const key = { poller: rt.def.name, partition: old.key };
        await this.store.saveStateUnfenced(key, { paused: true, updatedAt: now });
        this.nextDue.delete(keyId(key));
      }
    }
    for (const p of list) {
      const key = { poller: rt.def.name, partition: p.key };
      if (!this.nextDue.has(keyId(key))) this.nextDue.set(keyId(key), now);
    }
    rt.partitions = list;
    rt.partitionsLoadedAt = now;
    return list;
  }

  private async allKeys(): Promise<Array<{ rt: PollerRuntime; partition: Partition<unknown> }>> {
    const out: Array<{ rt: PollerRuntime; partition: Partition<unknown> }> = [];
    for (const rt of this.pollers.values()) {
      const parts = await this.refreshPartitions(rt);
      for (const partition of parts) out.push({ rt, partition });
    }
    return out;
  }

  private resolvePartition(rt: PollerRuntime, partition: string | undefined): Partition<unknown> {
    if (!rt.def.partitions) return { key: '', data: undefined };
    if (partition === undefined)
      throw new ConfigError(`poller '${rt.def.name}' is partitioned; pass { partition }`);
    return rt.partitions.find((p) => p.key === partition) ?? { key: partition, data: undefined };
  }

  // ---- running one key ---------------------------------------------------------------------

  private async runOne(
    rt: PollerRuntime,
    partition: Partition<unknown>,
    opts: { signal: AbortSignal; deadline?: number | null; force?: boolean },
  ): Promise<{ result: Awaited<ReturnType<typeof runKey>>; next: number }> {
    const key = { poller: rt.def.name, partition: partition.key };
    if (!rt.consumer && !rt.warnedNoConsumer) {
      rt.warnedNoConsumer = true;
      this.logger.warn(
        `poller '${rt.def.name}' has no handler; events will accumulate in the outbox until one is attached`,
      );
    }
    const result = await runKey(
      {
        store: this.store,
        clock: this.clock,
        random: this.random,
        logger: this.logger,
        hooks: this.hooks,
        instanceId: this.instanceId,
        poller: rt.def,
        key,
        partition,
        budget: this.budget,
        fetchImpl: this.fetchImpl,
        consumer: rt.consumer,
        dispatchBatchSize: this.dispatchBatchSize,
        leaseTtlMs: this.leaseTtlMs,
        leaseRenewMs: this.leaseRenewMs,
      },
      { signal: opts.signal, deadline: opts.deadline ?? null, force: opts.force ?? false },
    );
    const now = this.clock.now();
    let next: number;
    if (result.reason === 'leased') next = now + Math.max(1_000, Math.floor(this.leaseTtlMs / 2));
    else if (result.reason === 'paused') next = now + MAX_SLEEP_MS;
    else next = this.nextDueFromState(rt.def, result.state, now);
    if (result.nextRetryAt !== null) next = Math.min(next, result.nextRetryAt);
    return { result, next };
  }

  private nextDueFromState(def: ResolvedPoller, state: PollerState | null, now: number): number {
    if (!state) return now;
    let next = state.schedule.nextDueAt ?? now;
    if (state.schedule.throttledUntil !== null)
      next = Math.max(next, state.schedule.throttledUntil);
    if (def.reconcile) {
      const last = state.lanes.reconcile?.lastRunAt ?? null;
      next = Math.min(next, last === null ? now : last + def.reconcile.everyMs);
    }
    if (state.lanes.backfill && state.lanes.backfill.done !== true) next = Math.min(next, now);
    return Math.max(next, now);
  }

  // ---- daemon mode -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._status === 'running') return;
    if (this._status === 'stopping') throw new WatukuyError('NOT_RUNNING', 'engine is stopping');
    this.abort = new AbortController();
    this._status = 'running';
    const now = this.clock.now();
    for (const { rt, partition } of await this.allKeys()) {
      const key = { poller: rt.def.name, partition: partition.key };
      const state = await this.store.loadState(key);
      this.nextDue.set(keyId(key), state ? this.nextDueFromState(rt.def, state, now) : now);
    }
    this.requestWake();
  }

  private requestWake(): void {
    if (this._status !== 'running' || this.wakeRequested) return;
    this.wakeRequested = true;
    queueMicrotask(() => {
      this.wakeRequested = false;
      void this.loop();
    });
  }

  private async loop(): Promise<void> {
    if (this._status !== 'running') return;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.clock.now();
    let soonest = now + MAX_SLEEP_MS;
    for (const { rt, partition } of await this.allKeys()) {
      const key = { poller: rt.def.name, partition: partition.key };
      const id = keyId(key);
      if (this.inflight.has(id)) continue;
      const due = this.nextDue.get(id) ?? now;
      if (due <= now) {
        const p = this.runOne(rt, partition, { signal: this.abort.signal })
          .then(({ next }) => {
            this.nextDue.set(id, next);
          })
          .catch((err: unknown) => {
            this.logger.error('unexpected runner failure', {
              error: err instanceof Error ? err.message : String(err),
            });
            this.nextDue.set(id, this.clock.now() + rt.def.schedule.minMs);
          })
          .finally(() => {
            this.inflight.delete(id);
            this.requestWake();
          });
        this.inflight.set(id, p);
      } else {
        soonest = Math.min(soonest, due);
      }
    }
    if (this._status !== 'running') return;
    const delay = Math.max(0, Math.min(soonest, now + MAX_SLEEP_MS) - now);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, delay);
  }

  async stop(options: StopOptions = {}): Promise<void> {
    if (this._status === 'idle' || this._status === 'stopped') {
      this._status = 'stopped';
      return;
    }
    this._status = 'stopping';
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const drain = options.drain ?? true;
    const timeoutMs = parseDuration(options.timeout ?? '30s', 'stop.timeout');
    if (!drain) this.abort.abort(new Error('watukuy: engine stopped'));
    const pending = Array.from(this.inflight.values());
    if (pending.length > 0) {
      let handle: unknown = null;
      const timeout = new Promise<'timeout'>((resolve) => {
        handle = this.clock.setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([
        Promise.allSettled(pending).then(() => 'done' as const),
        timeout,
      ]);
      if (handle !== null) this.clock.clearTimeout(handle);
      if (outcome === 'timeout') {
        this.logger.warn('stop timeout reached; aborting in-flight cycles');
        this.abort.abort(new Error('watukuy: stop timeout'));
        await Promise.allSettled(pending);
      }
    }
    for (const rt of this.pollers.values())
      rt.consumer?.close(new Error('watukuy: engine stopped'));
    this._status = 'stopped';
  }

  // ---- serverless mode ----------------------------------------------------------------------

  async tick(options: TickOptions = {}): Promise<TickResult> {
    const startedAt = this.clock.now();
    const deadline =
      options.maxDuration !== undefined
        ? startedAt + parseDuration(options.maxDuration, 'tick.maxDuration')
        : null;
    const result: TickResult = {
      polled: [],
      delivered: 0,
      skippedLeased: 0,
      skippedNotDue: 0,
      durationMs: 0,
      timedOut: false,
    };
    const controller = new AbortController();
    const keys = (await this.allKeys()).filter(
      ({ rt }) => !options.only || options.only.includes(rt.def.name),
    );
    const queue = keys.slice();
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        if (deadline !== null && this.clock.now() >= deadline) {
          result.timedOut = true;
          return;
        }
        const { result: r } = await this.runOne(item.rt, item.partition, {
          signal: controller.signal,
          deadline,
        });
        if (r.reason === 'leased') result.skippedLeased++;
        else if (r.reason === 'not-due' || r.reason === 'paused') result.skippedNotDue++;
        result.polled.push(...r.results);
        result.delivered += r.drainedBefore + r.results.reduce((n, p) => n + p.delivered, 0);
        if (r.reason === 'aborted') result.timedOut = true;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TICK_CONCURRENCY, keys.length) }, () => worker()),
    );
    result.durationMs = this.clock.now() - startedAt;
    return result;
  }

  // ---- operations -----------------------------------------------------------------------------

  async trigger(
    name: keyof P & string,
    options: { partition?: string | undefined } = {},
  ): Promise<void> {
    const rt = this.rt(name);
    await this.refreshPartitions(rt);
    const partition = this.resolvePartition(rt, options.partition);
    const key = { poller: name, partition: partition.key };
    const now = this.clock.now();
    const state = await this.store.loadState(key);
    const schedule = makeDue(
      state?.schedule ??
        initialScheduleState(now, { schedule: rt.def.schedule, circuit: rt.def.circuit }),
      now,
    );
    await this.store.saveStateUnfenced(key, { schedule, updatedAt: now });
    this.nextDue.set(keyId(key), now);
    this.requestWake();
  }

  async pause(
    name: keyof P & string,
    options: { partition?: string | undefined } = {},
  ): Promise<void> {
    const rt = this.rt(name);
    await this.refreshPartitions(rt);
    const partition = this.resolvePartition(rt, options.partition);
    const key = { poller: name, partition: partition.key };
    await this.store.saveStateUnfenced(key, { paused: true, updatedAt: this.clock.now() });
  }

  async resume(
    name: keyof P & string,
    options: { partition?: string | undefined } = {},
  ): Promise<void> {
    const rt = this.rt(name);
    await this.refreshPartitions(rt);
    const partition = this.resolvePartition(rt, options.partition);
    const key = { poller: name, partition: partition.key };
    const now = this.clock.now();
    await this.store.saveStateUnfenced(key, { paused: false, updatedAt: now });
    this.nextDue.set(keyId(key), now);
    this.requestWake();
  }

  async backfill(name: keyof P & string, options: BackfillOptions): Promise<void> {
    const rt = this.rt(name);
    if (rt.def.cursor.strategy === 'snapshotDiff') {
      throw new ConfigError(
        `poller '${name}' uses snapshotDiff; backfill is meaningless (every cycle is a full scan)`,
      );
    }
    await this.refreshPartitions(rt);
    const partition = this.resolvePartition(rt, options.partition);
    const key = { poller: name, partition: partition.key };
    const strategy = getStrategy(rt.def.cursor);
    const state = await this.store.loadState(key);
    const from = strategy.serialize(rt.def.cursor, strategy.fromRaw(rt.def.cursor, options.from));
    const target =
      options.to !== undefined
        ? options.to === null
          ? null
          : strategy.serialize(rt.def.cursor, strategy.fromRaw(rt.def.cursor, options.to))
        : (state?.lanes.live?.cursor ?? null);
    const now = this.clock.now();
    await this.store.saveStateUnfenced(key, {
      lanes: {
        ...(state?.lanes ?? {}),
        backfill: { cursor: from, target, done: false, force: options.force === true },
      },
      updatedAt: now,
    });
    this.nextDue.set(keyId(key), now);
    this.requestWake();
  }

  async replay(name: keyof P & string, options: ReplayOptions): Promise<ReplayResult> {
    const rt = this.rt(name);
    if (!rt.def.log) throw new ReplayUnavailableError(name);
    await this.refreshPartitions(rt);
    const partition = this.resolvePartition(rt, options.partition);
    const key = { poller: name, partition: partition.key };
    const toMs = (v: string | number | Date): number =>
      v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    const fromTime = toMs(options.from);
    const toTime = options.to !== undefined ? toMs(options.to) : undefined;
    if (Number.isNaN(fromTime) || (toTime !== undefined && Number.isNaN(toTime))) {
      throw new ConfigError('replay: from/to must be ISO strings, epoch ms, or Dates');
    }
    const lease = await this.acquireWithRetry(key);
    try {
      const state = (await this.store.loadState(key)) ?? null;
      let sequence = state?.sequence ?? 0;
      let replayed = 0;
      let after: number | undefined;
      for (;;) {
        const logged = await this.store.readLog(
          key,
          {
            fromTime,
            ...(toTime !== undefined ? { toTime } : {}),
            ...(after !== undefined ? { afterSequence: after } : {}),
          },
          500,
        );
        if (logged.length === 0) break;
        const now = this.clock.now();
        const rows: OutboxRow[] = logged.map((l) => {
          sequence++;
          return {
            eventId: l.event.id,
            sequence,
            event: { ...l.event, lane: 'replay', sequence, attempt: 0 },
            status: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            createdAt: now,
          };
        });
        await this.store.commitPoll(key, lease, {
          statePatch: { sequence, updatedAt: now },
          upserts: [],
          deletes: [],
          events: rows,
          log: false,
        });
        replayed += rows.length;
        after = logged[logged.length - 1]?.sequence;
        if (logged.length < 500) break;
      }
      this.nextDue.set(keyId(key), this.clock.now());
      this.requestWake();
      return { replayed };
    } finally {
      await this.store.releaseLease(key, lease);
    }
  }

  private async acquireWithRetry(
    key: PKey,
  ): Promise<NonNullable<Awaited<ReturnType<StateStore['acquireLease']>>>> {
    for (let i = 0; i < 20; i++) {
      const lease = await this.store.acquireLease(
        key,
        this.instanceId,
        this.leaseTtlMs,
        this.clock.now(),
      );
      if (lease) return lease;
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 250));
    }
    throw new WatukuyError(
      'STORE',
      `could not acquire lease for ${key.poller}/${key.partition}: another instance is polling it`,
    );
  }

  async resetCursor(name: keyof P & string, options: ResetCursorOptions): Promise<void> {
    const rt = this.rt(name);
    await this.refreshPartitions(rt);
    const partition = this.resolvePartition(rt, options.partition);
    const key = { poller: name, partition: partition.key };
    const strategy = getStrategy(rt.def.cursor);
    const state = await this.store.loadState(key);
    const cursor =
      options.to === null
        ? null
        : strategy.serialize(rt.def.cursor, strategy.fromRaw(rt.def.cursor, options.to));
    const now = this.clock.now();
    const schedule = makeDue(
      state?.schedule ??
        initialScheduleState(now, { schedule: rt.def.schedule, circuit: rt.def.circuit }),
      now,
    );
    await this.store.saveStateUnfenced(key, {
      lanes: { ...(state?.lanes ?? {}), live: { cursor } },
      schedule,
      updatedAt: now,
    });
    if (options.clearSnapshot) await this.store.clearItems(key);
    this.nextDue.set(keyId(key), now);
    this.requestWake();
  }

  readonly parked = {
    list: async (
      name: keyof P & string,
      options: {
        partition?: string | undefined;
        kind?: 'poison' | 'invalid' | undefined;
        limit?: number | undefined;
      } = {},
    ) => {
      const rt = this.rt(name);
      await this.refreshPartitions(rt);
      const partition = this.resolvePartition(rt, options.partition);
      const opts: { kind?: 'poison' | 'invalid'; limit?: number } = {};
      if (options.kind !== undefined) opts.kind = options.kind;
      if (options.limit !== undefined) opts.limit = options.limit;
      return this.store.listParked({ poller: name, partition: partition.key }, opts);
    },
    retry: async (
      name: keyof P & string,
      ids: string[],
      options: { partition?: string | undefined } = {},
    ) => {
      const rt = this.rt(name);
      await this.refreshPartitions(rt);
      const partition = this.resolvePartition(rt, options.partition);
      const key = { poller: name, partition: partition.key };
      const n = await this.store.retryParked(key, ids);
      this.nextDue.set(keyId(key), this.clock.now());
      this.requestWake();
      return n;
    },
    discard: async (
      name: keyof P & string,
      ids: string[],
      options: { partition?: string | undefined } = {},
    ) => {
      const rt = this.rt(name);
      await this.refreshPartitions(rt);
      const partition = this.resolvePartition(rt, options.partition);
      return this.store.discardParked({ poller: name, partition: partition.key }, ids);
    },
  };

  readonly partitions = {
    list: async (name: keyof P & string) => {
      const rt = this.rt(name);
      return this.refreshPartitions(rt, true);
    },
    remove: async (name: keyof P & string, partition: string) => {
      this.rt(name);
      const key = { poller: name, partition };
      await this.store.deleteKey(key);
      this.nextDue.delete(keyId(key));
    },
  };

  async inspect(): Promise<InspectReport> {
    const now = this.clock.now();
    const pollers: PollerInspect[] = [];
    for (const { rt, partition } of await this.allKeys()) {
      const key = { poller: rt.def.name, partition: partition.key };
      const state = await this.store.loadState(key);
      const strategy = getStrategy(rt.def.cursor);
      const cursors: PollerInspect['cursors'] = {};
      let lagMs: number | null = null;
      if (state) {
        for (const [lane, lc] of Object.entries(state.lanes)) {
          if (lc?.cursor != null) {
            try {
              cursors[lane as keyof typeof cursors] = JSON.parse(lc.cursor);
            } catch {
              cursors[lane as keyof typeof cursors] = lc.cursor;
            }
          }
        }
        const live = state.lanes.live?.cursor;
        if (live != null) {
          try {
            lagMs = strategy.lagMs(rt.def.cursor, strategy.deserialize(rt.def.cursor, live), now);
          } catch {
            lagMs = null;
          }
        }
      }
      pollers.push({
        poller: key.poller,
        partition: key.partition,
        paused: state?.paused ?? false,
        lease: await this.store.getLease(key),
        cursors,
        schedule:
          state?.schedule ??
          initialScheduleState(now, { schedule: rt.def.schedule, circuit: rt.def.circuit }),
        lastPoll: state?.schedule.lastPoll ?? null,
        outboxPending: await this.store.countPending(key),
        parked: await this.store.countParked(key),
        items: await this.store.countItems(key),
        lagMs,
      });
    }
    return { instanceId: this.instanceId, status: this._status, generatedAt: now, pollers };
  }

  async migrate(): Promise<void> {
    await this.store.migrate();
  }
}

export { MemoryStore };
