import { type Attributes, type HrTime, SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  type Histogram as HistogramData,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import type { WatukuyEvent } from '../core/event.ts';
import type { PollSummary } from '../core/poller-types.ts';
import type { HookContext, Hooks } from '../core/ports.ts';
import type { ParkedRow } from '../core/store-types.ts';
import { otelHooks } from './hooks.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const ALL_HOOKS = [
  'onPollStart',
  'onPollEnd',
  'onFetch',
  'onCommit',
  'onEvent',
  'onDelivered',
  'onRetry',
  'onParked',
  'onInvalid',
  'onError',
  'onLeaseAcquired',
  'onLeaseLost',
  'onCircuitOpen',
  'onCircuitClose',
  'onBudgetWait',
  'onScheduleChange',
] as const satisfies ReadonlyArray<keyof Hooks>;

function hctx(overrides: Partial<HookContext> = {}): HookContext {
  return { poller: 'orders', partition: 'acme', lane: 'live', instanceId: 'i-1', ...overrides };
}

function summary(overrides: Partial<PollSummary> = {}): PollSummary {
  return {
    lane: 'live',
    startedAt: 1_000_000,
    durationMs: 250,
    pages: 2,
    items: 40,
    events: { created: 3, updated: 2, deleted: 1 },
    notModified: false,
    truncated: false,
    ...overrides,
  };
}

function ev(overrides: Partial<WatukuyEvent<unknown>> = {}): WatukuyEvent<unknown> {
  return {
    id: 'evt-1',
    type: 'created',
    source: 'urn:watukuy:orders',
    subject: 'o-1',
    time: '2026-01-01T00:00:00.000Z',
    poller: 'orders',
    partition: 'acme',
    lane: 'live',
    sequence: 1,
    cursor: null,
    data: { id: 'o-1' },
    attempt: 1,
    ...overrides,
  };
}

function parked(kind: ParkedRow['kind']): ParkedRow {
  return {
    id: 'p-1',
    kind,
    event: kind === 'poison' ? ev() : null,
    item: kind === 'invalid' ? { bad: true } : undefined,
    error: { name: 'Error', message: 'boom' },
    attempts: 5,
    parkedAt: 1,
    holdKey: null,
  };
}

/** Drive every hook once with well-formed input. */
async function fireAll(hooks: Hooks, ctx: HookContext = hctx()): Promise<void> {
  await hooks.onPollStart?.({ ...ctx, startedAt: 1_000_000 });
  await hooks.onFetch?.({ ...ctx, page: 1, durationMs: 10, items: 5, notModified: false });
  await hooks.onCommit?.({ ...ctx, events: 2, upserts: 5, deletes: 0, durationMs: 4 });
  await hooks.onEvent?.({ ...ctx, event: ev() });
  await hooks.onDelivered?.({ ...ctx, event: ev(), attempt: 1, durationMs: 7 });
  await hooks.onRetry?.({
    ...ctx,
    event: ev(),
    attempt: 1,
    error: { name: 'Error', message: 'x' },
    delayMs: 100,
  });
  await hooks.onParked?.({ ...ctx, row: parked('poison') });
  await hooks.onInvalid?.({ ...ctx, item: {}, issues: [{ message: 'bad' }] });
  await hooks.onError?.({ ...ctx, error: { name: 'Error', message: 'x' }, phase: 'fetch' });
  await hooks.onLeaseAcquired?.({ ...ctx, lease: { owner: 'i-1', epoch: 1, expiresAt: 2 } });
  await hooks.onLeaseLost?.({ ...ctx, epoch: 1 });
  await hooks.onCircuitOpen?.({ ...ctx, failures: 5, probeAt: 3 });
  await hooks.onCircuitClose?.(ctx);
  await hooks.onBudgetWait?.({ ...ctx, budget: 'erp', waitMs: 12 });
  await hooks.onScheduleChange?.({ ...ctx, intervalMs: 5000, nextDueAt: 9, reason: 'idle' });
  await hooks.onPollEnd?.({ ...ctx, summary: summary() });
}

function ms(t: HrTime): number {
  return t[0] * 1000 + t[1] / 1e6;
}

// ---------------------------------------------------------------------------------------------
// Harness: in-memory tracer + meter, never registered globally
// ---------------------------------------------------------------------------------------------

interface Harness {
  hooks: Hooks;
  spans(): ReadableSpan[];
  span(name: string): ReadableSpan;
  metric(name: string): Promise<MetricData | undefined>;
  points(name: string): Promise<DataPoint<number>[]>;
  histogram(name: string): Promise<DataPoint<HistogramData>[]>;
  shutdown(): Promise<void>;
}

const open: Harness[] = [];

function setup(options: Parameters<typeof otelHooks>[0] = {}): Harness {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });

  const hooks = otelHooks({
    tracer: tracerProvider.getTracer('test'),
    meter: meterProvider.getMeter('test'),
    ...options,
  });

  const metric = async (name: string) => {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === name);
  };

  const h: Harness = {
    hooks,
    spans: () => spanExporter.getFinishedSpans(),
    span: (name) => {
      const s = spanExporter.getFinishedSpans().find((x) => x.name === name);
      if (!s) throw new Error(`no span ${name}`);
      return s;
    },
    metric,
    points: async (name) => ((await metric(name))?.dataPoints ?? []) as DataPoint<number>[],
    histogram: async (name) =>
      ((await metric(name))?.dataPoints ?? []) as DataPoint<HistogramData>[],
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.shutdown()));
});

function point(points: DataPoint<number>[], attrs: Attributes): DataPoint<number> | undefined {
  return points.find((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v));
}

// ---------------------------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------------------------

describe('otelHooks spans', () => {
  it('opens watukuy.poll on onPollStart and closes it on onPollEnd with summary attributes', async () => {
    const h = setup({ attributes: { 'service.name': 'erp-sync' } });
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1_000_000 });
    expect(h.spans()).toHaveLength(0);

    await h.hooks.onPollEnd?.({ ...ctx, summary: summary({ truncated: true }) });

    const poll = h.span('watukuy.poll');
    expect(poll.attributes).toMatchObject({
      'service.name': 'erp-sync',
      'watukuy.poller': 'orders',
      'watukuy.partition': 'acme',
      'watukuy.lane': 'live',
      'watukuy.instance_id': 'i-1',
      'watukuy.pages': 2,
      'watukuy.items': 40,
      'watukuy.events.created': 3,
      'watukuy.events.updated': 2,
      'watukuy.events.deleted': 1,
      'watukuy.not_modified': false,
      'watukuy.truncated': true,
    });
    expect(poll.status.code).toBe(SpanStatusCode.UNSET);
    expect(ms(poll.startTime)).toBe(1_000_000);
    expect(ms(poll.duration)).toBeCloseTo(250, 3);
    expect(poll.parentSpanContext).toBeUndefined();
  });

  it('marks the poll span ERROR and records the exception when onError fires during the cycle', async () => {
    const h = setup();
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1 });
    await h.hooks.onError?.({
      ...ctx,
      error: { name: 'HttpError', message: 'GET /orders responded 500', code: 'HTTP' },
      phase: 'fetch',
    });
    await h.hooks.onPollEnd?.({ ...ctx, summary: summary() });

    const poll = h.span('watukuy.poll');
    expect(poll.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'GET /orders responded 500',
    });
    expect(poll.events).toHaveLength(1);
    expect(poll.events[0]?.name).toBe('exception');
    expect(poll.events[0]?.attributes).toMatchObject({
      'exception.type': 'HttpError',
      'exception.message': 'GET /orders responded 500',
    });
  });

  it('does not blame the poll span for dispatch-phase (handler) errors', async () => {
    const h = setup();
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1 });
    await h.hooks.onError?.({ ...ctx, error: { name: 'E', message: 'x' }, phase: 'dispatch' });
    await h.hooks.onPollEnd?.({ ...ctx, summary: summary() });
    expect(h.span('watukuy.poll').status.code).toBe(SpanStatusCode.UNSET);
  });

  it('keys concurrent cycles by poller + partition + lane so they never collide', async () => {
    const h = setup();
    const a = hctx({ partition: 'a' });
    const b = hctx({ partition: 'b' });
    const bf = hctx({ partition: 'a', lane: 'backfill' });
    await h.hooks.onPollStart?.({ ...a, startedAt: 1 });
    await h.hooks.onPollStart?.({ ...b, startedAt: 2 });
    await h.hooks.onPollStart?.({ ...bf, startedAt: 3 });
    await h.hooks.onError?.({ ...b, error: { name: 'E', message: 'x' }, phase: 'commit' });

    await h.hooks.onPollEnd?.({ ...bf, summary: summary({ lane: 'backfill', items: 3 }) });
    await h.hooks.onPollEnd?.({ ...b, summary: summary({ items: 2 }) });
    await h.hooks.onPollEnd?.({ ...a, summary: summary({ items: 1 }) });

    const polls = h.spans().filter((s) => s.name === 'watukuy.poll');
    expect(polls).toHaveLength(3);
    const byKey = (p: string, l: string) =>
      polls.find(
        (s) => s.attributes['watukuy.partition'] === p && s.attributes['watukuy.lane'] === l,
      );
    expect(byKey('a', 'live')?.attributes['watukuy.items']).toBe(1);
    expect(byKey('a', 'live')?.status.code).toBe(SpanStatusCode.UNSET);
    expect(byKey('b', 'live')?.attributes['watukuy.items']).toBe(2);
    expect(byKey('b', 'live')?.status.code).toBe(SpanStatusCode.ERROR);
    expect(byKey('a', 'backfill')?.attributes['watukuy.items']).toBe(3);
  });

  it('ignores onPollEnd without a matching onPollStart', async () => {
    const h = setup();
    expect(() => h.hooks.onPollEnd?.({ ...hctx(), summary: summary() })).not.toThrow();
    expect(h.spans()).toHaveLength(0);
  });

  it('closes a stale poll span with ERROR when the same key starts a new cycle', async () => {
    const h = setup();
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1 });
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 500 });
    expect(h.spans()).toHaveLength(1);
    const stale = h.span('watukuy.poll');
    expect(stale.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'superseded by a new cycle',
    });
    expect(ms(stale.endTime)).toBe(500);

    await h.hooks.onPollEnd?.({ ...ctx, summary: summary({ startedAt: 500 }) });
    expect(h.spans().filter((s) => s.name === 'watukuy.poll')).toHaveLength(2);
  });

  it('closes every open poll span for a partition with ERROR when the lease is lost', async () => {
    const h = setup();
    await h.hooks.onPollStart?.({ ...hctx({ lane: 'live' }), startedAt: 1 });
    await h.hooks.onPollStart?.({ ...hctx({ lane: 'backfill' }), startedAt: 1 });
    await h.hooks.onPollStart?.({ ...hctx({ partition: 'other' }), startedAt: 1 });
    await h.hooks.onLeaseLost?.({ ...hctx(), epoch: 3 });

    const closed = h.spans();
    expect(closed).toHaveLength(2);
    for (const s of closed) {
      expect(s.attributes['watukuy.partition']).toBe('acme');
      expect(s.status).toEqual({ code: SpanStatusCode.ERROR, message: 'lease lost' });
    }
    // The other partition's cycle is untouched and still ends normally.
    await h.hooks.onPollEnd?.({ ...hctx({ partition: 'other' }), summary: summary() });
    expect(h.spans()).toHaveLength(3);
  });

  it('emits watukuy.fetch and watukuy.commit as children of the active poll span', async () => {
    const h = setup();
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1 });
    await h.hooks.onFetch?.({ ...ctx, page: 2, durationMs: 120, items: 20, notModified: false });
    await h.hooks.onCommit?.({ ...ctx, events: 6, upserts: 20, deletes: 1, durationMs: 15 });
    await h.hooks.onPollEnd?.({ ...ctx, summary: summary() });

    const poll = h.span('watukuy.poll');
    const fetch = h.span('watukuy.fetch');
    const commit = h.span('watukuy.commit');

    expect(fetch.parentSpanContext?.spanId).toBe(poll.spanContext().spanId);
    expect(fetch.spanContext().traceId).toBe(poll.spanContext().traceId);
    expect(fetch.attributes).toMatchObject({
      'watukuy.poller': 'orders',
      'watukuy.lane': 'live',
      'watukuy.page': 2,
      'watukuy.items': 20,
      'watukuy.not_modified': false,
    });
    expect(ms(fetch.duration)).toBeCloseTo(120, 3);

    expect(commit.parentSpanContext?.spanId).toBe(poll.spanContext().spanId);
    expect(commit.attributes).toMatchObject({
      'watukuy.events': 6,
      'watukuy.upserts': 20,
      'watukuy.deletes': 1,
    });
    expect(ms(commit.duration)).toBeCloseTo(15, 3);
  });

  it('emits watukuy.deliver with type and attempt, parented to the poll span when one is active', async () => {
    const h = setup();
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1 });
    await h.hooks.onDelivered?.({
      ...ctx,
      event: ev({ type: 'updated' }),
      attempt: 2,
      durationMs: 33,
    });
    await h.hooks.onPollEnd?.({ ...ctx, summary: summary() });

    const deliver = h.span('watukuy.deliver');
    expect(deliver.parentSpanContext?.spanId).toBe(h.span('watukuy.poll').spanContext().spanId);
    expect(deliver.attributes).toMatchObject({
      'watukuy.event.type': 'updated',
      'watukuy.attempt': 2,
    });
    expect(deliver.attributes['watukuy.event.id']).toBeUndefined();
    expect(ms(deliver.duration)).toBeCloseTo(33, 3);
  });

  it('emits watukuy.deliver as a root span outside a cycle and records ids only when asked', async () => {
    const h = setup({ recordEventIds: true });
    await h.hooks.onDelivered?.({
      ...hctx(),
      event: ev({ id: 'evt-42' }),
      attempt: 1,
      durationMs: 5,
    });
    const deliver = h.span('watukuy.deliver');
    expect(deliver.parentSpanContext).toBeUndefined();
    expect(deliver.attributes['watukuy.event.id']).toBe('evt-42');
  });
});

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

describe('otelHooks metrics', () => {
  it('records poll duration with outcome ok or error', async () => {
    const h = setup({ attributes: { env: 'test' } });
    const ctx = hctx();
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 1 });
    await h.hooks.onPollEnd?.({ ...ctx, summary: summary({ durationMs: 100 }) });
    await h.hooks.onPollStart?.({ ...ctx, startedAt: 2 });
    await h.hooks.onError?.({ ...ctx, error: { name: 'E', message: 'x' }, phase: 'fetch' });
    await h.hooks.onPollEnd?.({ ...ctx, summary: summary({ durationMs: 300 }) });

    const metric = await h.metric('watukuy.poll.duration');
    expect(metric?.descriptor.unit).toBe('ms');
    expect(metric?.descriptor.description).not.toBe('');
    const pts = await h.histogram('watukuy.poll.duration');
    const ok = pts.find((p) => p.attributes['watukuy.outcome'] === 'ok');
    const err = pts.find((p) => p.attributes['watukuy.outcome'] === 'error');
    expect(ok?.value.count).toBe(1);
    expect(ok?.value.sum).toBe(100);
    expect(ok?.attributes).toMatchObject({
      env: 'test',
      'watukuy.poller': 'orders',
      'watukuy.partition': 'acme',
      'watukuy.lane': 'live',
    });
    expect(ok?.attributes['watukuy.instance_id']).toBeUndefined();
    expect(err?.value.count).toBe(1);
    expect(err?.value.sum).toBe(300);
  });

  it('increments counters with the right attributes', async () => {
    const h = setup();
    const ctx = hctx();
    await h.hooks.onFetch?.({ ...ctx, page: 1, durationMs: 1, items: 25, notModified: false });
    await h.hooks.onFetch?.({ ...ctx, page: 2, durationMs: 1, items: 15, notModified: false });
    await h.hooks.onEvent?.({ ...ctx, event: ev({ type: 'created' }) });
    await h.hooks.onEvent?.({ ...ctx, event: ev({ type: 'created' }) });
    await h.hooks.onEvent?.({ ...ctx, event: ev({ type: 'deleted' }) });
    await h.hooks.onDelivered?.({ ...ctx, event: ev(), attempt: 1, durationMs: 8 });
    await h.hooks.onRetry?.({
      ...ctx,
      event: ev(),
      attempt: 1,
      error: { name: 'E', message: 'x' },
      delayMs: 10,
    });
    await h.hooks.onParked?.({ ...ctx, row: parked('poison') });
    await h.hooks.onParked?.({ ...ctx, row: parked('invalid') });
    await h.hooks.onParked?.({ ...ctx, row: parked('invalid') });
    await h.hooks.onInvalid?.({ ...ctx, item: {}, issues: [{ message: 'bad' }] });
    await h.hooks.onError?.({ ...ctx, error: { name: 'E', message: 'x' }, phase: 'fetch' });
    await h.hooks.onError?.({ ...ctx, error: { name: 'E', message: 'x' }, phase: 'dispatch' });
    await h.hooks.onLeaseLost?.({ ...ctx, epoch: 1 });
    await h.hooks.onCircuitOpen?.({ ...ctx, failures: 5, probeAt: 1 });
    await h.hooks.onBudgetWait?.({ ...ctx, budget: 'erp', waitMs: 40 });
    await h.hooks.onBudgetWait?.({ ...ctx, budget: 'erp', waitMs: 60 });

    const base = {
      'watukuy.poller': 'orders',
      'watukuy.partition': 'acme',
      'watukuy.lane': 'live',
    };

    expect(point(await h.points('watukuy.items.fetched'), base)?.value).toBe(40);
    const emitted = await h.points('watukuy.events.emitted');
    expect(point(emitted, { ...base, 'watukuy.event.type': 'created' })?.value).toBe(2);
    expect(point(emitted, { ...base, 'watukuy.event.type': 'deleted' })?.value).toBe(1);
    expect(point(await h.points('watukuy.events.delivered'), base)?.value).toBe(1);
    expect(point(await h.points('watukuy.events.retried'), base)?.value).toBe(1);
    const parkedPts = await h.points('watukuy.events.parked');
    expect(point(parkedPts, { ...base, 'watukuy.kind': 'poison' })?.value).toBe(1);
    expect(point(parkedPts, { ...base, 'watukuy.kind': 'invalid' })?.value).toBe(2);
    expect(point(await h.points('watukuy.items.invalid'), base)?.value).toBe(1);
    const errors = await h.points('watukuy.errors');
    expect(point(errors, { ...base, 'watukuy.phase': 'fetch' })?.value).toBe(1);
    expect(point(errors, { ...base, 'watukuy.phase': 'dispatch' })?.value).toBe(1);
    expect(point(await h.points('watukuy.lease.lost'), base)?.value).toBe(1);
    expect(point(await h.points('watukuy.circuit.opened'), base)?.value).toBe(1);
    expect(
      point(await h.points('watukuy.budget.waits'), { ...base, 'watukuy.budget': 'erp' })?.value,
    ).toBe(2);

    const wait = (await h.histogram('watukuy.budget.wait'))[0];
    expect(wait?.attributes['watukuy.budget']).toBe('erp');
    expect(wait?.value.count).toBe(2);
    expect(wait?.value.sum).toBe(100);

    const deliver = (await h.histogram('watukuy.deliver.duration'))[0];
    expect(deliver?.value.count).toBe(1);
    expect(deliver?.value.sum).toBe(8);
  });

  it('declares units and descriptions on every instrument', async () => {
    const h = setup();
    await fireAll(h.hooks);
    const names = [
      'watukuy.poll.duration',
      'watukuy.items.fetched',
      'watukuy.events.emitted',
      'watukuy.events.delivered',
      'watukuy.events.retried',
      'watukuy.events.parked',
      'watukuy.items.invalid',
      'watukuy.errors',
      'watukuy.lease.lost',
      'watukuy.circuit.opened',
      'watukuy.budget.waits',
      'watukuy.budget.wait',
      'watukuy.deliver.duration',
      'watukuy.circuit.state',
      'watukuy.schedule.interval',
    ];
    for (const name of names) {
      const m = await h.metric(name);
      expect(m, name).toBeDefined();
      expect(m?.descriptor.unit, name).not.toBe('');
      expect(m?.descriptor.description, name).not.toBe('');
    }
  });

  it('reports circuit state and schedule interval per partition through observable gauges', async () => {
    const h = setup();
    const acme = hctx({ partition: 'acme' });
    const beta = hctx({ partition: 'beta' });
    const state = async (partition: string) =>
      point(await h.points('watukuy.circuit.state'), { 'watukuy.partition': partition })?.value;
    const interval = async (partition: string) =>
      point(await h.points('watukuy.schedule.interval'), { 'watukuy.partition': partition })?.value;

    // Nothing observed until a hook fires.
    expect(await h.points('watukuy.circuit.state')).toHaveLength(0);

    await h.hooks.onCircuitOpen?.({ ...acme, failures: 5, probeAt: 10 });
    await h.hooks.onCircuitClose?.(beta);
    expect(await state('acme')).toBe(2);
    expect(await state('beta')).toBe(0);

    // A cycle that starts while open is the half-open probe.
    await h.hooks.onPollStart?.({ ...acme, startedAt: 10 });
    expect(await state('acme')).toBe(1);

    // Probe fails: the circuit re-opens. Probe succeeds: it closes.
    await h.hooks.onCircuitOpen?.({ ...acme, failures: 6, probeAt: 20 });
    expect(await state('acme')).toBe(2);
    await h.hooks.onCircuitClose?.(acme);
    expect(await state('acme')).toBe(0);

    await h.hooks.onScheduleChange?.({ ...acme, intervalMs: 5_000, nextDueAt: 1, reason: 'idle' });
    await h.hooks.onScheduleChange?.({ ...beta, intervalMs: 500, nextDueAt: 1, reason: 'events' });
    expect(await interval('acme')).toBe(5_000);
    expect(await interval('beta')).toBe(500);
    await h.hooks.onScheduleChange?.({ ...acme, intervalMs: 7_500, nextDueAt: 1, reason: 'idle' });
    expect(await interval('acme')).toBe(7_500);

    // Gauges carry poller/partition but no lane.
    const pt = point(await h.points('watukuy.schedule.interval'), { 'watukuy.partition': 'acme' });
    expect(pt?.attributes['watukuy.poller']).toBe('orders');
    expect(pt?.attributes['watukuy.lane']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------------------------

describe('otelHooks robustness', () => {
  it('implements every hook the engine can call except onLeaseAcquired, and never returns a promise', () => {
    const hooks = otelHooks();
    for (const name of ALL_HOOKS) {
      if (name === 'onLeaseAcquired') continue;
      expect(typeof hooks[name], name).toBe('function');
    }
  });

  it('never throws when given odd input', async () => {
    const h = setup();
    const garbage = [undefined, null, {}, { poller: 1 }, { summary: null }, 'nope', 42] as any[];
    for (const name of ALL_HOOKS) {
      const fn = h.hooks[name] as ((ctx: any) => unknown) | undefined;
      if (!fn) continue;
      for (const g of garbage) {
        expect(() => fn(g), `${name}(${String(g)})`).not.toThrow();
      }
    }
    // Sequences that reference state that was never created.
    await h.hooks.onPollEnd?.({ ...hctx(), summary: summary() });
    await h.hooks.onError?.({ ...hctx(), error: { name: 'E', message: 'x' }, phase: 'fetch' });
    await h.hooks.onLeaseLost?.({ ...hctx(), epoch: 1 });
    await h.hooks.onFetch?.({ ...hctx(), page: 1, durationMs: -5, items: 0, notModified: true });
    const last = h
      .spans()
      .filter((s) => s.name === 'watukuy.fetch')
      .at(-1);
    expect(last?.attributes['watukuy.not_modified']).toBe(true);
    expect(ms(last?.duration ?? [0, 0])).toBe(0);
  });

  it('never throws when the tracer or meter misbehaves', async () => {
    const boom = () => {
      throw new Error('sdk exploded');
    };
    const tracer = { startSpan: boom, startActiveSpan: boom } as any;
    const meter = new Proxy({}, { get: () => boom }) as any;
    expect(() => otelHooks({ tracer, meter })).toThrow('sdk exploded');
    // Instrument creation failing is a configuration error and surfaces at construction; a tracer
    // that fails at runtime is swallowed.
    const hooks = otelHooks({ tracer });
    await expect(fireAll(hooks)).resolves.toBeUndefined();
  });

  it('works with the no-op global API when called with no options', async () => {
    const hooks = otelHooks();
    await expect(fireAll(hooks)).resolves.toBeUndefined();
    await expect(fireAll(hooks, hctx({ lane: 'backfill' }))).resolves.toBeUndefined();
  });
});
