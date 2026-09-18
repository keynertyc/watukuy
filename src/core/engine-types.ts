import type { Duration } from './duration.ts';
import type { SerializedError } from './errors.ts';
import type { EventHandler, WatukuyEvent } from './event.ts';
import type { AnyPollerDefinition, ItemOf, Lane, Partition, PollSummary } from './poller-types.ts';
import type { Clock, Hooks, Logger, Random } from './ports.ts';
import type {
  Lease,
  ParkedRow,
  RateBudgetStore,
  ScheduleState,
  StateStore,
} from './store-types.ts';

export interface BudgetConfig {
  requests: number;
  per: Duration;
  /** Max accumulated tokens. @default requests */
  burst?: number | undefined;
  /** @default 'round-robin' */
  fairness?: 'round-robin' | 'weighted' | undefined;
  /** Longest wait for tokens before deferring the cycle. @default the poller's schedule.max */
  maxWait?: Duration | undefined;
}

export type PollerMap = Record<string, AnyPollerDefinition>;

export interface EngineOptions<P extends PollerMap> {
  store: StateStore;
  pollers: P;
  budgets?: Record<string, BudgetConfig> | undefined;
  budgetStore?: RateBudgetStore | undefined;
  /** Identifies this process in leases and `inspect()`. @default random */
  instanceId?: string | undefined;
  clock?: Clock | undefined;
  random?: Random | undefined;
  logger?: Logger | undefined;
  hooks?: Hooks | Hooks[] | undefined;
  lease?: { ttl?: Duration | undefined; renewEvery?: Duration | undefined } | undefined;
  /** Base for event `source`. @default 'urn:watukuy:' */
  sourcePrefix?: string | undefined;
  /** Global `fetch` implementation for the HTTP helper. @default globalThis.fetch */
  fetch?: typeof globalThis.fetch | undefined;
  /** Outbox rows loaded per dispatch slice. @default 100 */
  dispatchBatchSize?: number | undefined;
}

export type EngineStatus = 'idle' | 'running' | 'stopping' | 'stopped';

export interface StopOptions {
  /** Wait for in-flight handlers. @default true */
  drain?: boolean | undefined;
  /** @default '30s' */
  timeout?: Duration | undefined;
}

export interface TickOptions {
  /** Cooperative time budget for the whole pass. @default none */
  maxDuration?: Duration | undefined;
  /** Only these pollers. */
  only?: string[] | undefined;
}

export interface TickPollResult {
  poller: string;
  partition: string;
  lane: Lane;
  items: number;
  events: number;
  delivered: number;
  durationMs: number;
  error: SerializedError | null;
}

export interface TickResult {
  polled: TickPollResult[];
  /** Due keys skipped because another instance holds the lease. */
  skippedLeased: number;
  /** Keys not yet due. */
  skippedNotDue: number;
  durationMs: number;
  timedOut: boolean;
}

export interface BackfillOptions {
  /** Serialized-cursor-compatible start (the API's own string, or `null` for the beginning). */
  from: string | null;
  /** Stop cursor; defaults to the live cursor at the time of the call. */
  to?: string | null | undefined;
  partition?: string | undefined;
  /** Re-emit even when identity/version is already known. @default false */
  force?: boolean | undefined;
}

export interface ReplayOptions {
  from: string | number | Date;
  to?: string | number | Date | undefined;
  partition?: string | undefined;
}

export interface ReplayResult {
  replayed: number;
}

export interface ResetCursorOptions {
  partition?: string | undefined;
  /** New serialized cursor, or `null` for the strategy's initial. */
  to: string | null;
  /** Also drop the item snapshot. @default false */
  clearSnapshot?: boolean | undefined;
}

export interface PollerInspect {
  poller: string;
  partition: string;
  paused: boolean;
  lease: Lease | null;
  cursors: Partial<Record<Lane, unknown>>;
  schedule: ScheduleState;
  lastPoll: PollSummary | null;
  outboxPending: number;
  parked: number;
  items: number;
  /** `now - cursor` for timestamp pollers, else `null`. */
  lagMs: number | null;
}

export interface InspectReport {
  instanceId: string;
  status: EngineStatus;
  generatedAt: number;
  pollers: PollerInspect[];
}

export interface SubscribeOptions {
  signal?: AbortSignal | undefined;
}

/** The running engine (PLAN §4.5). Create with `createWatukuy()`. */
export interface Engine<P extends PollerMap> {
  readonly status: EngineStatus;
  readonly instanceId: string;

  /** Register the handler for a poller. Returns an unsubscribe function. One handler per poller. */
  on<K extends keyof P & string>(name: K, handler: EventHandler<ItemOf<P[K]>>): () => void;
  /** Pull-based consumption with backpressure. Mutually exclusive with `on()` for the same poller. */
  subscribe<K extends keyof P & string>(
    name: K,
    options?: SubscribeOptions,
  ): AsyncIterable<WatukuyEvent<ItemOf<P[K]>>>;

  start(): Promise<void>;
  stop(options?: StopOptions): Promise<void>;
  /** One pass over due pollers, then return (serverless mode, PLAN §5.10). */
  tick(options?: TickOptions): Promise<TickResult>;

  trigger(name: keyof P & string, options?: { partition?: string | undefined }): Promise<void>;
  pause(name: keyof P & string, options?: { partition?: string | undefined }): Promise<void>;
  resume(name: keyof P & string, options?: { partition?: string | undefined }): Promise<void>;
  backfill(name: keyof P & string, options: BackfillOptions): Promise<void>;
  replay(name: keyof P & string, options: ReplayOptions): Promise<ReplayResult>;
  resetCursor(name: keyof P & string, options: ResetCursorOptions): Promise<void>;

  parked: {
    list(
      name: keyof P & string,
      options?: {
        partition?: string | undefined;
        kind?: 'poison' | 'invalid' | undefined;
        limit?: number | undefined;
      },
    ): Promise<ParkedRow[]>;
    retry(
      name: keyof P & string,
      ids: string[],
      options?: { partition?: string | undefined },
    ): Promise<number>;
    discard(
      name: keyof P & string,
      ids: string[],
      options?: { partition?: string | undefined },
    ): Promise<number>;
  };
  partitions: {
    list(name: keyof P & string): Promise<Partition<unknown>[]>;
    remove(name: keyof P & string, partition: string): Promise<void>;
  };

  inspect(): Promise<InspectReport>;
  migrate(): Promise<void>;
}
