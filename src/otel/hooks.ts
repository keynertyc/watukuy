import {
  type Attributes,
  type Context,
  type Counter,
  context,
  type Histogram,
  type Meter,
  metrics,
  type ObservableGauge,
  type ObservableResult,
  type Span,
  type SpanStatus,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import type { HookContext, Hooks } from '../core/ports.ts';
import type { PKey } from '../core/store-types.ts';
import { VERSION } from '../core/version.ts';

/** Instrumentation scope name for the default tracer and meter. */
const SCOPE_NAME = 'watukuy';
/** Instrumentation scope version. Mirrors `package.json#version`. */
const SCOPE_VERSION = VERSION;

/** `watukuy.circuit.state` values. */
const CIRCUIT_CLOSED = 0;
const CIRCUIT_HALF_OPEN = 1;
const CIRCUIT_OPEN = 2;

/** Separator for composite map keys; a control character cannot appear in a poller name. */
const SEP = String.fromCharCode(0);

/** Bucket boundaries (ms) shared by every duration histogram. */
const DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
];

/**
 * Options for {@link otelHooks}.
 *
 * @example
 * ```ts
 * import { trace, metrics } from '@opentelemetry/api';
 * import { otelHooks } from 'watukuy/otel';
 *
 * const hooks = otelHooks({
 *   tracer: trace.getTracer('erp-sync'),
 *   meter: metrics.getMeter('erp-sync'),
 *   attributes: { 'service.name': 'erp-sync' },
 *   recordEventIds: true,
 * });
 * ```
 */
export interface OtelHooksOptions {
  /** @default trace.getTracer('watukuy', VERSION) */
  tracer?: Tracer | undefined;
  /** @default metrics.getMeter('watukuy', VERSION) */
  meter?: Meter | undefined;
  /** Extra attributes added to every span and metric (e.g. `{ 'service.name': 'erp-sync' }`). */
  attributes?: Record<string, string | number | boolean> | undefined;
  /** Record event ids on `watukuy.deliver` spans (off by default; can be high-cardinality). */
  recordEventIds?: boolean | undefined;
}

/** Parameter type of one hook. */
type Arg<K extends keyof Hooks> = Parameters<NonNullable<Hooks[K]>>[0];

/** A poll cycle whose span is open, keyed by poller + partition + lane. */
interface ActivePoll {
  span: Span;
  /** Message of the last non-dispatch error reported for this key; `null` while healthy. */
  error: string | null;
}

/** One data point reported by an observable gauge. */
interface GaugeEntry {
  attributes: Attributes;
  value: number;
}

interface Instruments {
  pollDuration: Histogram;
  itemsFetched: Counter;
  eventsEmitted: Counter;
  eventsDelivered: Counter;
  eventsRetried: Counter;
  eventsParked: Counter;
  itemsInvalid: Counter;
  errors: Counter;
  leaseLost: Counter;
  circuitOpened: Counter;
  budgetWaits: Counter;
  budgetWait: Histogram;
  deliverDuration: Histogram;
  circuitState: ObservableGauge;
  scheduleInterval: ObservableGauge;
}

/**
 * Hooks that emit OpenTelemetry spans and metrics for every poller in an engine.
 *
 * Zero-cost when no SDK is registered: `@opentelemetry/api` returns no-op tracers and meters, so
 * the hooks only pay for a few Map lookups. Hooks never throw; any internal failure is swallowed so
 * observability can never affect the engine.
 *
 * **Spans** (attributes prefixed `watukuy.`: `poller`, `partition`, `lane`, `instance_id`, plus
 * any `options.attributes`):
 * - `watukuy.poll` — one per cycle, opened in `onPollStart` and closed in `onPollEnd`. Carries
 *   `watukuy.pages`, `watukuy.items`, `watukuy.events.{created,updated,deleted}`,
 *   `watukuy.not_modified`, `watukuy.truncated`. Status is `ERROR` when `onError` fired for the
 *   same key during the cycle (any phase except `dispatch`, which belongs to the handler, not the
 *   poll). A span still open when the next cycle starts, or when the lease is lost, is closed with
 *   `ERROR`.
 * - `watukuy.fetch` — one per page, child of the active poll span; `watukuy.page`, `watukuy.items`,
 *   `watukuy.not_modified`.
 * - `watukuy.commit` — one per commit, child of the active poll span; `watukuy.events`,
 *   `watukuy.upserts`, `watukuy.deletes`.
 * - `watukuy.deliver` — one per successful delivery; `watukuy.event.type`, `watukuy.attempt` and,
 *   with `recordEventIds`, `watukuy.event.id`.
 *
 * **Metrics** (attributes `watukuy.poller`, `watukuy.partition`, `watukuy.lane` plus
 * `options.attributes`; instance id is deliberately left out to keep cardinality low):
 * - Histogram `watukuy.poll.duration` (ms), `watukuy.outcome` = `ok` | `error`.
 * - Counters `watukuy.items.fetched`, `watukuy.events.emitted` (`watukuy.event.type`),
 *   `watukuy.events.delivered`, `watukuy.events.retried`, `watukuy.events.parked`
 *   (`watukuy.kind`), `watukuy.items.invalid`, `watukuy.errors` (`watukuy.phase`),
 *   `watukuy.lease.lost`, `watukuy.circuit.opened`, `watukuy.budget.waits` (`watukuy.budget`).
 * - Histograms `watukuy.budget.wait` (ms, `watukuy.budget`) and `watukuy.deliver.duration` (ms).
 * - Observable gauges per `(poller, partition)`: `watukuy.circuit.state` (0 closed, 1 half-open
 *   while a probe cycle runs, 2 open) and `watukuy.schedule.interval` (ms).
 *
 * `watukuy.lag.seconds` is not emitted here: lag is a property of the stored cursor and will be
 * reported by an `inspect()`-backed observer in a later milestone.
 *
 * @example
 * ```ts
 * import { createWatukuy } from 'watukuy';
 * import { otelHooks } from 'watukuy/otel';
 *
 * const engine = createWatukuy({
 *   pollers: [orders],
 *   hooks: [otelHooks({ attributes: { 'service.name': 'erp-sync' } })],
 * });
 * ```
 */
export function otelHooks(options: OtelHooksOptions = {}): Hooks {
  const tracer = options.tracer ?? trace.getTracer(SCOPE_NAME, SCOPE_VERSION);
  const meter = options.meter ?? metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  const extra: Attributes = { ...(options.attributes ?? {}) };
  const recordEventIds = options.recordEventIds === true;

  const inst = createInstruments(meter);
  const polls = new Map<string, ActivePoll>();
  const circuit = new Map<string, GaugeEntry>();
  const intervals = new Map<string, GaugeEntry>();

  inst.circuitState.addCallback(guard((result) => observeAll(result, circuit)));
  inst.scheduleInterval.addCallback(guard((result) => observeAll(result, intervals)));

  const spanAttrs = (ctx: HookContext): Attributes => ({
    ...extra,
    'watukuy.poller': ctx.poller,
    'watukuy.partition': ctx.partition,
    'watukuy.lane': ctx.lane,
    'watukuy.instance_id': ctx.instanceId,
  });

  const metricAttrs = (ctx: HookContext): Attributes => ({
    ...extra,
    'watukuy.poller': ctx.poller,
    'watukuy.partition': ctx.partition,
    'watukuy.lane': ctx.lane,
  });

  const keyAttrs = (key: PKey): Attributes => ({
    ...extra,
    'watukuy.poller': key.poller,
    'watukuy.partition': key.partition,
  });

  /** Parent context for child spans: the active poll span when there is one. */
  const parentOf = (ctx: HookContext): Context => {
    const active = polls.get(pollKey(ctx));
    return active ? trace.setSpan(context.active(), active.span) : context.active();
  };

  // Timestamps are passed as `Date` on purpose: the SDK reads a plain number that is smaller than
  // `performance.now()` as a performance-relative timestamp, which would misplace the small epoch
  // values a virtual clock produces.
  const endPoll = (key: string, active: ActivePoll, status: SpanStatus, endTime: number): void => {
    polls.delete(key);
    active.span.setStatus(status);
    active.span.end(new Date(endTime));
  };

  /** Emit a span that already finished; `durationMs` is anchored to `Date.now()`. */
  const emitFinished = (name: string, ctx: HookContext, durationMs: number, attrs: Attributes) => {
    const end = Date.now();
    const span = tracer.startSpan(
      name,
      {
        startTime: new Date(end - Math.max(0, durationMs)),
        attributes: { ...spanAttrs(ctx), ...attrs },
      },
      parentOf(ctx),
    );
    span.end(new Date(end));
  };

  return {
    onPollStart: guard<Arg<'onPollStart'>>((ctx) => {
      const key = pollKey(ctx);
      const stale = polls.get(key);
      if (stale) {
        endPoll(
          key,
          stale,
          { code: SpanStatusCode.ERROR, message: 'superseded by a new cycle' },
          ctx.startedAt,
        );
      }
      const span = tracer.startSpan('watukuy.poll', {
        startTime: new Date(ctx.startedAt),
        attributes: spanAttrs(ctx),
      });
      polls.set(key, { span, error: null });

      // A cycle that starts while the circuit is open is the half-open probe.
      const state = circuit.get(pKey(ctx));
      if (state && state.value === CIRCUIT_OPEN) state.value = CIRCUIT_HALF_OPEN;
    }),

    onPollEnd: guard<Arg<'onPollEnd'>>((ctx) => {
      const key = pollKey(ctx);
      const active = polls.get(key);
      const s = ctx.summary;
      inst.pollDuration.record(s.durationMs, {
        ...metricAttrs(ctx),
        'watukuy.outcome': active && active.error !== null ? 'error' : 'ok',
      });
      if (!active) return;
      active.span.setAttributes({
        'watukuy.pages': s.pages,
        'watukuy.items': s.items,
        'watukuy.events.created': s.events.created,
        'watukuy.events.updated': s.events.updated,
        'watukuy.events.deleted': s.events.deleted,
        'watukuy.not_modified': s.notModified,
        'watukuy.truncated': s.truncated,
      });
      endPoll(
        key,
        active,
        active.error === null
          ? { code: SpanStatusCode.UNSET }
          : { code: SpanStatusCode.ERROR, message: active.error },
        s.startedAt + s.durationMs,
      );
    }),

    onFetch: guard<Arg<'onFetch'>>((ctx) => {
      emitFinished('watukuy.fetch', ctx, ctx.durationMs, {
        'watukuy.page': ctx.page,
        'watukuy.items': ctx.items,
        'watukuy.not_modified': ctx.notModified,
      });
      inst.itemsFetched.add(ctx.items, metricAttrs(ctx));
    }),

    onCommit: guard<Arg<'onCommit'>>((ctx) => {
      emitFinished('watukuy.commit', ctx, ctx.durationMs, {
        'watukuy.events': ctx.events,
        'watukuy.upserts': ctx.upserts,
        'watukuy.deletes': ctx.deletes,
      });
    }),

    onEvent: guard<Arg<'onEvent'>>((ctx) => {
      inst.eventsEmitted.add(1, { ...metricAttrs(ctx), 'watukuy.event.type': ctx.event.type });
    }),

    onDelivered: guard<Arg<'onDelivered'>>((ctx) => {
      const attrs: Attributes = {
        'watukuy.event.type': ctx.event.type,
        'watukuy.attempt': ctx.attempt,
      };
      if (recordEventIds) attrs['watukuy.event.id'] = ctx.event.id;
      emitFinished('watukuy.deliver', ctx, ctx.durationMs, attrs);
      const m = metricAttrs(ctx);
      inst.eventsDelivered.add(1, m);
      inst.deliverDuration.record(ctx.durationMs, m);
    }),

    onRetry: guard<Arg<'onRetry'>>((ctx) => {
      inst.eventsRetried.add(1, metricAttrs(ctx));
    }),

    onParked: guard<Arg<'onParked'>>((ctx) => {
      inst.eventsParked.add(1, { ...metricAttrs(ctx), 'watukuy.kind': ctx.row.kind });
    }),

    onInvalid: guard<Arg<'onInvalid'>>((ctx) => {
      inst.itemsInvalid.add(1, metricAttrs(ctx));
    }),

    onError: guard<Arg<'onError'>>((ctx) => {
      inst.errors.add(1, { ...metricAttrs(ctx), 'watukuy.phase': ctx.phase });
      if (ctx.phase === 'dispatch') return;
      const active = polls.get(pollKey(ctx));
      if (!active) return;
      active.error = ctx.error.message;
      // `code` is deliberately not forwarded: the SDK would use it as `exception.type` instead of
      // the error class name.
      active.span.recordException({
        name: ctx.error.name,
        message: ctx.error.message,
        ...(ctx.error.stack === undefined ? {} : { stack: ctx.error.stack }),
      });
    }),

    onLeaseLost: guard<Arg<'onLeaseLost'>>((ctx) => {
      inst.leaseLost.add(1, metricAttrs(ctx));
      const prefix = `${pKey(ctx)}${SEP}`;
      const now = Date.now();
      for (const [key, active] of polls) {
        if (key.startsWith(prefix)) {
          endPoll(key, active, { code: SpanStatusCode.ERROR, message: 'lease lost' }, now);
        }
      }
    }),

    onCircuitOpen: guard<Arg<'onCircuitOpen'>>((ctx) => {
      inst.circuitOpened.add(1, metricAttrs(ctx));
      circuit.set(pKey(ctx), { attributes: keyAttrs(ctx), value: CIRCUIT_OPEN });
    }),

    onCircuitClose: guard<Arg<'onCircuitClose'>>((ctx) => {
      circuit.set(pKey(ctx), { attributes: keyAttrs(ctx), value: CIRCUIT_CLOSED });
    }),

    onBudgetWait: guard<Arg<'onBudgetWait'>>((ctx) => {
      const attrs = { ...metricAttrs(ctx), 'watukuy.budget': ctx.budget };
      inst.budgetWaits.add(1, attrs);
      inst.budgetWait.record(ctx.waitMs, attrs);
    }),

    onScheduleChange: guard<Arg<'onScheduleChange'>>((ctx) => {
      intervals.set(pKey(ctx), { attributes: keyAttrs(ctx), value: ctx.intervalMs });
    }),
  };
}

/** Wrap a hook so it can never throw into the engine. */
function guard<T>(fn: (arg: T) => void): (arg: T) => void {
  return (arg) => {
    try {
      fn(arg);
    } catch {
      // Observability must never affect the engine.
    }
  };
}

/** Map key for a poll cycle: poller + partition + lane. */
function pollKey(ctx: HookContext): string {
  return `${ctx.poller}${SEP}${ctx.partition}${SEP}${ctx.lane}`;
}

/** Map key for per-partition gauges: poller + partition. */
function pKey(key: PKey): string {
  return `${key.poller}${SEP}${key.partition}`;
}

function observeAll(result: ObservableResult, entries: Map<string, GaugeEntry>): void {
  for (const entry of entries.values()) result.observe(entry.value, entry.attributes);
}

function createInstruments(meter: Meter): Instruments {
  const ms = (description: string) => ({
    description,
    unit: 'ms',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
  });
  return {
    pollDuration: meter.createHistogram('watukuy.poll.duration', ms('Duration of one poll cycle.')),
    itemsFetched: meter.createCounter('watukuy.items.fetched', {
      description: 'Items returned by fetch, across all pages.',
      unit: '{item}',
    }),
    eventsEmitted: meter.createCounter('watukuy.events.emitted', {
      description: 'Change events written to the outbox, by type.',
      unit: '{event}',
    }),
    eventsDelivered: meter.createCounter('watukuy.events.delivered', {
      description: 'Events acknowledged by a handler or sink.',
      unit: '{event}',
    }),
    eventsRetried: meter.createCounter('watukuy.events.retried', {
      description: 'Delivery attempts scheduled for retry after a handler error.',
      unit: '{event}',
    }),
    eventsParked: meter.createCounter('watukuy.events.parked', {
      description: 'Events or items moved to the parked table, by kind.',
      unit: '{event}',
    }),
    itemsInvalid: meter.createCounter('watukuy.items.invalid', {
      description: 'Items that failed schema validation.',
      unit: '{item}',
    }),
    errors: meter.createCounter('watukuy.errors', {
      description: 'Errors reported by the engine, by phase.',
      unit: '{error}',
    }),
    leaseLost: meter.createCounter('watukuy.lease.lost', {
      description: 'Times this instance lost the lease for a partition.',
      unit: '{lease}',
    }),
    circuitOpened: meter.createCounter('watukuy.circuit.opened', {
      description: 'Times the circuit breaker opened.',
      unit: '{transition}',
    }),
    budgetWaits: meter.createCounter('watukuy.budget.waits', {
      description: 'Times a fetch waited for rate-budget tokens.',
      unit: '{wait}',
    }),
    budgetWait: meter.createHistogram(
      'watukuy.budget.wait',
      ms('Time spent waiting for rate-budget tokens.'),
    ),
    deliverDuration: meter.createHistogram(
      'watukuy.deliver.duration',
      ms('Handler duration for one successful delivery.'),
    ),
    circuitState: meter.createObservableGauge('watukuy.circuit.state', {
      description: 'Circuit breaker state per partition: 0 closed, 1 half-open, 2 open.',
      unit: '1',
    }),
    scheduleInterval: meter.createObservableGauge('watukuy.schedule.interval', {
      description: 'Current adaptive poll interval per partition.',
      unit: 'ms',
    }),
  };
}
