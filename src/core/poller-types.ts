import type { CursorConfig, CursorValue, PageCursor } from './cursor-types.ts';
import type { Duration } from './duration.ts';
import type { WatukuyEvent } from './event.ts';
import type { HttpClient } from './http-types.ts';
import type { Logger } from './ports.ts';
import type { StandardSchemaV1 } from './standard-schema.ts';

/** Which loop produced an event or is running: the live incremental loop, a backfill, a reconcile sweep, or a replay. */
export type Lane = 'live' | 'backfill' | 'reconcile' | 'replay';

/** One tenant / account / shard of a poller (PLAN §5.8). */
export interface Partition<Data = undefined> {
  /** Stable key. `''` for single-partition pollers. */
  key: string;
  /** Anything your `fetch` needs: credentials, slugs, base URLs. Never persisted. */
  data: Data;
}

/** What `fetch` returns for one request. */
export interface Page<Item = unknown> {
  items: Item[];
  /**
   * `token` strategy: the next cursor, `null` when caught up.
   * `timestamp` strategy: optional override of the derived watermark.
   */
  cursor?: string | null | undefined;
  /** `true` makes the runner continue immediately with the next cursor (catch-up mode). */
  hasMore?: boolean | undefined;
}

/** Argument of a poller `fetch` function (PLAN §4.7). */
export interface FetchContext<Cursor, PData = undefined> {
  cursor: Cursor;
  /** 1-based request index within the current cycle. */
  page: number;
  partition: Partition<PData>;
  lane: Lane;
  /** HTTP helper with ETag, rate-limit parsing, budget charging (PLAN §5.11). Optional to use. */
  http: HttpClient;
  signal: AbortSignal;
  /** 1-based fetch attempt within this cycle (increments after transient errors). */
  attempt: number;
  logger: Logger;
}

/** A poller `fetch` function: returns one page per call, or an async iterable of pages. */
export type FetchFn<Item, Cursor, PData> = (
  ctx: FetchContext<Cursor, PData>,
) => Promise<Page<Item>> | AsyncIterable<Page<Item>>;

/** Exponential backoff parameters. */
export interface BackoffConfig {
  /** @default '1s' */
  base?: Duration | undefined;
  /** @default 2 */
  factor?: number | undefined;
  /** @default '10m' for the scheduler, '2m' for delivery retries */
  max?: Duration | undefined;
}

/** Polling cadence and adaptation (PLAN §5.6). */
export interface ScheduleConfig {
  /** Shortest interval between cycles. */
  min: Duration;
  /** Longest interval between cycles. */
  max: Duration;
  /**
   * AIMD adaptation: halve the interval after a cycle with events, grow it by 1.5x when idle.
   * @default true
   */
  adaptive?: boolean | undefined;
  /** Jitter fraction applied to every interval. @default 0.1 */
  jitter?: number | undefined;
  /** Backoff after fetch errors. */
  backoff?: BackoffConfig | undefined;
}

/** Circuit breaker thresholds (PLAN §5.6). */
export interface CircuitConfig {
  /** Consecutive failures that open the circuit. @default 5 */
  failures?: number | undefined;
  /** Half-open probe cadence while open. @default schedule.max */
  probeEvery?: Duration | undefined;
}

/** Delivery retry policy (PLAN §5.4). */
export interface RetryConfig {
  /** Total delivery attempts before the event is poison. @default 5 */
  attempts?: number | undefined;
  backoff?: BackoffConfig | undefined;
}

/** What happens when delivery attempts are exhausted (PLAN §5.4). */
export interface PoisonConfig {
  /**
   * `'park'` moves the event to the parked table; `'halt'` opens the poller circuit instead.
   * @default 'park'
   */
  action?: 'park' | 'halt' | undefined;
  /**
   * Keep later events for the same ordering key pending while one is parked, preserving order.
   * @default true
   */
  holdKey?: boolean | undefined;
}

/** Delivery semantics for a poller: ordering, concurrency, retries, poison handling, ack mode. */
export interface DeliveryConfig<Item> {
  /** Events with equal keys are delivered in order; different keys may run concurrently. @default event.subject */
  orderingKey?: ((event: WatukuyEvent<Item>) => string) | undefined;
  /** Max ordering keys in flight at once. @default 1 */
  concurrency?: number | undefined;
  retry?: RetryConfig | undefined;
  poison?: PoisonConfig | undefined;
  /** `'manual'` requires the handler to call `ctx.ack()`. @default 'auto' */
  ackMode?: 'auto' | 'manual' | undefined;
}

/** Periodic full-listing sweep that detects deletes for incremental strategies (PLAN §5.2). */
export interface ReconcileConfig<Item, PData> {
  every: Duration;
  /** Full listing, paged with `ctx.page`. */
  fetch: FetchFn<Item, PageCursor, PData>;
}

/** Event log retention; enables `engine.replay()`. */
export interface LogConfig {
  retention: Duration;
}

interface PollerConfigShared<Name extends string, Item, C extends CursorConfig, PData> {
  /** Stable name; used in store keys, event `source`, and metrics. */
  name: Name;
  /** Stable id per item. */
  identity: (item: Item) => string;
  /** Cheap change detector when the API exposes `updatedAt` / `etag`. Defaults to the content hash. */
  version?: ((item: Item) => string | number) | undefined;
  /** What counts as a change. Canonically hashed (RFC 8785). Defaults to the whole item. */
  fingerprint?: ((item: Item) => unknown) | undefined;
  /** Bump deliberately when `fingerprint` changes. @default 1 */
  schemaVersion?: number | undefined;
  cursor: C;
  schedule?: ScheduleConfig | undefined;
  /** Name of a shared rate budget declared in `createWatukuy`. */
  budget?: string | undefined;
  /** Weight for `fairness: 'weighted'` budgets. @default 1 */
  budgetWeight?: number | undefined;
  /** Requests per HTTP call charged to the budget. @default 1 */
  budgetCost?: number | undefined;
  partitions?: (() => Promise<Partition<PData>[]> | Partition<PData>[]) | undefined;
  /** @default '5m' */
  partitionsRefresh?: Duration | undefined;
  delivery?: DeliveryConfig<Item> | undefined;
  /** `'payload'` stores the last payload, enabling `event.previous` and `deleted.data`. @default 'hash' */
  retain?: 'hash' | 'payload' | undefined;
  reconcile?: ReconcileConfig<Item, PData> | undefined;
  /** @default 'quarantine' */
  onInvalid?: 'quarantine' | 'skip' | 'fail' | undefined;
  /** @default 'rebaseline' */
  onSchemaChange?: 'rebaseline' | 'emit' | undefined;
  /** @default 50 */
  maxPagesPerCycle?: number | undefined;
  circuit?: CircuitConfig | undefined;
  /** Enables `replay()`. */
  log?: LogConfig | undefined;
  /** Overrides the event `source`. @default `urn:watukuy:<name>` */
  source?: string | undefined;
}

/** `definePoller` input when a Standard Schema validates raw items. `fetch` returns raw `unknown` items. */
export interface PollerConfigWithSchema<
  Name extends string,
  S extends StandardSchemaV1,
  C extends CursorConfig,
  PData,
> extends PollerConfigShared<Name, StandardSchemaV1.InferOutput<S>, C, PData> {
  schema: S;
  fetch: FetchFn<unknown, CursorValue<C>, PData>;
}

/** `definePoller` input without a schema. `fetch` must return typed items. */
export interface PollerConfigWithoutSchema<Name extends string, Item, C extends CursorConfig, PData>
  extends PollerConfigShared<Name, Item, C, PData> {
  schema?: undefined;
  fetch: FetchFn<Item, CursorValue<C>, PData>;
}

/** Either `definePoller` input shape. */
export type PollerConfig<Name extends string, Item, C extends CursorConfig, PData> =
  | PollerConfigWithSchema<Name, StandardSchemaV1<unknown, Item>, C, PData>
  | PollerConfigWithoutSchema<Name, Item, C, PData>;

/** Fully normalized poller, durations in milliseconds, all defaults applied. Internal but exported for stores and adapters. */
export interface ResolvedPoller {
  name: string;
  source: string;
  schema: StandardSchemaV1 | undefined;
  identity: (item: never) => string;
  version: ((item: never) => string | number) | undefined;
  fingerprint: ((item: never) => unknown) | undefined;
  schemaVersion: number;
  cursor: CursorConfig;
  fetch: FetchFn<unknown, unknown, unknown>;
  schedule: {
    minMs: number;
    maxMs: number;
    adaptive: boolean;
    jitter: number;
    backoff: { baseMs: number; factor: number; maxMs: number };
  };
  budget: string | undefined;
  budgetWeight: number;
  budgetCost: number;
  partitions: (() => Promise<Partition<unknown>[]> | Partition<unknown>[]) | undefined;
  partitionsRefreshMs: number;
  delivery: {
    orderingKey: ((event: WatukuyEvent<never>) => string) | undefined;
    concurrency: number;
    retry: { attempts: number; backoff: { baseMs: number; factor: number; maxMs: number } };
    poison: { action: 'park' | 'halt'; holdKey: boolean };
    ackMode: 'auto' | 'manual';
  };
  retain: 'hash' | 'payload';
  reconcile: { everyMs: number; fetch: FetchFn<unknown, PageCursor, unknown> } | undefined;
  onInvalid: 'quarantine' | 'skip' | 'fail';
  onSchemaChange: 'rebaseline' | 'emit';
  maxPagesPerCycle: number;
  circuit: { failures: number; probeEveryMs: number };
  log: { retentionMs: number } | undefined;
}

/**
 * The object returned by `definePoller`. Carries the item type for `engine.on` inference.
 * Treat as opaque.
 */
export interface PollerDefinition<
  Name extends string = string,
  Item = unknown,
  C extends CursorConfig = CursorConfig,
  PData = unknown,
> {
  readonly kind: 'watukuy.poller';
  readonly name: Name;
  readonly resolved: ResolvedPoller;
  /** Phantom types only; never set at runtime. */
  readonly '~types'?: { item: Item; cursor: CursorValue<C>; partition: PData };
}

/** A `PollerDefinition` with erased type parameters. */
export type AnyPollerDefinition = PollerDefinition<string, unknown, CursorConfig, unknown>;

/** Extracts the item type from a `PollerDefinition`. */
export type ItemOf<P> =
  P extends PollerDefinition<string, infer I, CursorConfig, unknown> ? I : never;
/** Extracts the partition data type from a `PollerDefinition`. */
export type PartitionDataOf<P> =
  P extends PollerDefinition<string, unknown, CursorConfig, infer D> ? D : never;

/** Summary of one completed poll cycle, persisted for `inspect()` and passed to `onPollEnd`. */
export interface PollSummary {
  lane: Lane;
  startedAt: number;
  durationMs: number;
  pages: number;
  items: number;
  events: { created: number; updated: number; deleted: number };
  notModified: boolean;
  /** `true` when `maxPagesPerCycle` stopped the cycle with more data available. */
  truncated: boolean;
}
