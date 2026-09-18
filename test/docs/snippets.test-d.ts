/**
 * Documentation snippets, type-checked.
 *
 * Every non-trivial code sample from README.md and docs/ is reproduced here so `tsc` proves the
 * documentation compiles against the real API. Imports are rewritten from `'watukuy'` /
 * `'watukuy/testing'` / `'watukuy/otel'` / `'watukuy/sinks'` to relative source paths.
 *
 * Store, NestJS, and serverless snippets import the subpath sources directly
 * (`../../src/stores/*`, `../../src/nestjs`). `storeContractSuite` is imported from
 * `../../src/testing/store-contract.ts` because `src/testing/index.ts` does not re-export it yet.
 * Third-party SDK types that are not installed at the repo root (`pg`, `@aws-sdk/client-sqs`,
 * `@cloudflare/workers-types`, `@nestjs/schedule`, `bullmq`, `kafkajs`, `inngest`) are declared
 * structurally below. Every snippet is referenced from the registry at the bottom so the linter
 * sees it used; none of them is executed (vitest only type-checks `.test-d.ts` files).
 */
import { createServer } from 'node:http';
import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HealthCheck, HealthCheckService, TerminusModule } from '@nestjs/terminus';
import type { Meter } from '@opentelemetry/api';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  createWatukuy,
  customCursor,
  definePoller,
  type Engine,
  type HandlerContext,
  type Hooks,
  type InspectReport,
  MemoryStore,
  type PollerMap,
  type TickResult,
  toCloudEvent,
  type WatukuyEvent,
} from '../../src/index.ts';
import {
  InjectWatukuy,
  OnWatukuyEvent,
  WATUKUY_ENGINE,
  WatukuyHealthIndicator,
  WatukuyModule,
} from '../../src/nestjs/index.ts';
import { otelHooks } from '../../src/otel/index.ts';
import {
  type BullMQQueueLike,
  bullmqSink,
  type KafkaProducerLike,
  kafkaSink,
  type SqsSendMessageInput,
  sqsSink,
  verifyWebhookSignature,
  webhookSink,
} from '../../src/sinks/index.ts';
import { type PgClientLike, PostgresStore } from '../../src/stores/postgres/index.ts';
import { RedisBudgetStore, RedisStore } from '../../src/stores/redis/index.ts';
import { SqliteStore } from '../../src/stores/sqlite/index.ts';
import {
  assertChaosReport,
  describeChaos,
  FakeApi,
  fakeItems,
  runChaos,
  SeededRandom,
  VirtualClock,
} from '../../src/testing/index.ts';
import { storeContractSuite } from '../../src/testing/store-contract.ts';

// ---------------------------------------------------------------------------------------------
// External collaborators referenced by the docs (queues, databases, SDKs). Declared, never run.
// ---------------------------------------------------------------------------------------------

declare const queue: BullMQQueueLike;
declare const pool: {
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>;
};
declare const pgPool: PgClientLike;
declare const redis: unknown;
declare const sqs: { send(command: unknown): Promise<unknown> };
declare function Cron(expression: string): MethodDecorator;
declare class OrdersQueue {
  add(name: string, data: unknown, opts: { jobId: string }): Promise<unknown>;
}
declare const db: { tenants(): Promise<Tenant[]> };
declare const handle: (event: WatukuyEvent<Invoice>) => Promise<void>;
declare const downstream: { tryEnqueue(event: unknown): Promise<boolean> };
declare const warehouse: {
  apply(event: unknown): Promise<void>;
  upsert(event: unknown): Promise<void>;
};
declare const notify: (event: unknown) => Promise<void>;
declare const alerts: { page(message: string): Promise<void> };
declare const metrics: {
  gauge(name: string, value: number, tags: Record<string, string>): void;
};
declare const meter: Meter;
declare const producer: KafkaProducerLike;
declare const inngest: {
  send(event: { name: string; id: string; data: unknown }): Promise<unknown>;
};
declare const temporal: {
  workflow: {
    signalWithStart(
      workflow: unknown,
      options: {
        taskQueue: string;
        workflowId: string;
        signal: unknown;
        signalArgs: unknown[];
        args: unknown[];
      },
    ): Promise<unknown>;
  };
};
declare const orderWorkflow: unknown;
declare const orderChanged: unknown;
declare const stripe: {
  events: {
    list(
      params: { starting_after?: string | undefined; limit: number },
      options: { signal: AbortSignal },
    ): Promise<{ data: { id: string }[]; has_more: boolean }>;
  };
};
declare class SQSClient {
  constructor(options: object);
  send(command: unknown): Promise<unknown>;
}
declare class SendMessageCommand {
  constructor(input: SqsSendMessageInput | { QueueUrl: string; MessageBody: string });
}

interface Product {
  sku: string;
  name: string;
  price: number;
}
interface Invoice {
  id: string;
  etag: string;
  customerId: string;
}
interface Tenant {
  id: string;
  slug: string;
  token: string;
}

// ---------------------------------------------------------------------------------------------
// README: quickstart (see the README quickstart), verbatim apart from the import paths.
// ---------------------------------------------------------------------------------------------

const Order = z.object({
  id: z.string(),
  updatedAt: z.iso.datetime(),
  status: z.enum(['open', 'paid', 'cancelled']),
  total: z.number(),
});
type Order = z.infer<typeof Order>;

const orders = definePoller({
  name: 'orders',
  schema: Order, // any Standard Schema v1 validator; infers the item type
  identity: (o) => o.id, // stable id per item
  version: (o) => o.updatedAt, // optional; defaults to the content hash
  fingerprint: (o) => ({ status: o.status, total: o.total }), // optional; what counts as a change
  schemaVersion: 1, // bump deliberately when your fingerprint changes

  cursor: {
    strategy: 'timestamp',
    field: 'updatedAt',
    tieBreak: 'id', // composite keyset (updatedAt, id): no skipped ties
    initial: '2026-01-01T00:00:00Z',
    lag: '30s', // never read past now - lag (late commits)
    overlap: '2m', // re-scan this window each cycle; dedup by version
  },

  fetch: async ({ cursor, http, signal }) => {
    const res = await http.get('https://erp.example.com/orders', {
      query: { updated_since: cursor.value, after_id: cursor.tieBreak, limit: 500 },
      signal,
    });
    if (res.notModified) return { items: [] }; // ETag 304: nothing to diff, counts as idle
    const body = await res.json<{ data: unknown[]; has_more: boolean }>();
    return { items: body.data, hasMore: body.has_more };
  },

  schedule: { min: '5s', max: '5m', adaptive: true },
  budget: 'erp', // shared token bucket
});

const quickstartEngine = createWatukuy({
  store: new SqliteStore({ path: './watukuy.db' }), // durable, zero dependencies
  budgets: { erp: { requests: 100, per: '1m' } },
  pollers: { orders }, // keyed object: engine.on('orders') is fully typed
});

async function quickstart(): Promise<void> {
  const engine = quickstartEngine;
  engine.on('orders', async (event) => {
    // event.type: 'created' | 'updated' | 'deleted'
    // event.data: Order        event.previous?: Order (when retain: 'payload')
    await queue.add('order-sync', event, { jobId: event.id }); // at-least-once + dedup by id
  });

  await engine.start();
}

// ---------------------------------------------------------------------------------------------
// README: "Runs anywhere"
// ---------------------------------------------------------------------------------------------

const worker = {
  scheduled: () => quickstartEngine.tick({ maxDuration: '50s' }),
};

// ---------------------------------------------------------------------------------------------
// README: "Testing your pollers"
// ---------------------------------------------------------------------------------------------

async function testingSnippet(): Promise<void> {
  const clock = new VirtualClock('2026-01-01T00:00:00Z');
  const api = new FakeApi({
    clock,
    identity: (o) => o.id,
    timestampField: 'updatedAt',
    items: fakeItems(20),
  });

  const items = definePoller({
    name: 'items',
    identity: (o: { id: string; updatedAt: string; value: number }) => o.id,
    version: (o) => o.updatedAt,
    cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
    fetch: async ({ cursor }) => api.listSince({ since: cursor.value, afterId: cursor.tieBreak }),
    schedule: { min: '5s', max: '1m', jitter: 0 },
  });

  const engine = createWatukuy({
    store: new MemoryStore(),
    pollers: { items },
    clock,
    random: new SeededRandom(1),
  });
  const seen: string[] = [];
  engine.on('items', (e) => void seen.push(`${e.type}:${e.subject}`));

  await engine.tick(); // 20 created
  api.update('item-001', { value: 99 });
  await clock.advance(5_000); // time only moves when you say so
  await engine.tick(); // 1 updated
}

// ---------------------------------------------------------------------------------------------
// Advanced example (see the README), adapted: orderingKey receives the event, parked.retry takes the
// poller name, PostgresStore takes `{ client }`.
// ---------------------------------------------------------------------------------------------

// Pull-only API with no delta support: full-response diff, emits deletes.
const catalog = definePoller({
  name: 'catalog',
  identity: (p: Product) => p.sku,
  cursor: { strategy: 'snapshotDiff' },
  fetch: async ({ page, http, signal }) => {
    const res = await http.get(`https://vendor.example.com/products?page=${page}`, { signal });
    const body = await res.json<{ items: Product[]; pages: number }>();
    return { items: body.items, hasMore: page < body.pages };
  },
  schedule: { min: '10m', max: '6h', adaptive: true },
  retain: 'payload', // enables event.previous
});

// Multi-tenant: one definition, N partitions, each with its own cursor, lease, schedule.
const invoices = definePoller({
  name: 'invoices',
  partitions: async () => (await db.tenants()).map((t) => ({ key: t.id, data: t })),
  partitionsRefresh: '5m',
  identity: (i: Invoice) => i.id,
  version: (i) => i.etag,
  cursor: { strategy: 'token', initial: null },
  fetch: async ({ cursor, partition, http, signal }) => {
    const res = await http.get(`https://api.vendor.com/${partition.data.slug}/invoices`, {
      query: { cursor: cursor.value ?? undefined },
      headers: { authorization: `Bearer ${partition.data.token}` },
      signal,
    });
    const body = await res.json<{ data: Invoice[]; next: string | null }>();
    return { items: body.data, cursor: body.next }; // token strategy: null cursor means done
  },
  reconcile: {
    // periodic full scan: catches deletes and missed updates
    every: '6h',
    fetch: async ({ page, partition, http, signal }) => {
      const res = await http.get(`https://api.vendor.com/${partition.data.slug}/invoices`, {
        query: { page, limit: 1000 },
        headers: { authorization: `Bearer ${partition.data.token}` },
        signal,
      });
      const body = await res.json<{ data: Invoice[]; has_more: boolean }>();
      return { items: body.data, hasMore: body.has_more };
    },
  },
  delivery: {
    orderingKey: (e) => e.data?.customerId ?? e.subject, // default is event.subject
    concurrency: 8,
    retry: { attempts: 5, backoff: { base: '1s', factor: 2, max: '2m' } },
    poison: { action: 'park', holdKey: true },
  },
  schedule: { min: '30s', max: '15m' },
  budget: 'vendor',
});

const advancedEngine = createWatukuy({
  store: new PostgresStore({ client: pgPool }),
  budgets: {
    erp: { requests: 100, per: '1m' },
    vendor: { requests: 600, per: '1m', fairness: 'round-robin' },
  },
  pollers: { orders, catalog, invoices },
  instanceId: process.env.HOSTNAME,
  hooks: [otelHooks()], // from 'watukuy/otel'
});

async function advancedUsage(signal: AbortSignal): Promise<void> {
  const engine = advancedEngine;

  // Pull-based consumption with backpressure
  for await (const event of engine.subscribe('invoices', { signal })) {
    await handle(event);
  }

  // Operations
  await engine.trigger('orders'); // poll now
  await engine.backfill('invoices', { from: null, partition: 't_42' }); // separate lane, low priority
  await engine.replay('orders', { from: '2026-09-01T00:00:00Z' }); // requires log: { retention }
  await engine.pause('catalog');
  await engine.resume('catalog');
  const parked = await engine.parked.list('orders');
  if (parked[0]) await engine.parked.retry('orders', [parked[0].id]);
  const status = await engine.inspect(); // per poller/partition health
  expectTypeOf(status).toEqualTypeOf<InspectReport>();
  await engine.stop({ drain: true, timeout: '30s' });
}

// ---------------------------------------------------------------------------------------------
// docs/serverless.md: tick() result shape (platform-specific snippets use PostgresStore /
// SqliteStore and are kept in comments at the end of this file).
// ---------------------------------------------------------------------------------------------

async function tickShape(): Promise<TickResult> {
  const result = await quickstartEngine.tick({ maxDuration: '50s', only: ['orders'] });
  expectTypeOf(result.polled[0]?.lane).toEqualTypeOf<
    'live' | 'backfill' | 'reconcile' | 'replay' | undefined
  >();
  return result;
}

// ---------------------------------------------------------------------------------------------
// docs/cursors.md
// ---------------------------------------------------------------------------------------------

interface CursorsOrder {
  id: string;
  updatedAt: string;
  status: string;
}

const cursorsTimestamp = definePoller({
  name: 'orders',
  identity: (o: CursorsOrder) => o.id,
  version: (o) => o.updatedAt,
  cursor: {
    strategy: 'timestamp',
    field: 'updatedAt', // dot paths allowed: 'meta.updatedAt'
    tieBreak: 'id', // default null
    initial: '2026-01-01T00:00:00Z', // or null to start from the beginning
    lag: '30s', // default 0
    overlap: '2m', // default 0
  },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://erp.example.com/orders', {
      query: {
        updated_since: cursor.value,
        after_id: cursor.tieBreak,
        limit: 500,
        sort: 'updatedAt,id',
      },
    });
    const body = await res.json<{ data: CursorsOrder[]; has_more: boolean }>();
    return { items: body.data, hasMore: body.has_more };
  },
});

// Pitfall 4: custom timestamp formats.
const customFormatCursor = {
  strategy: 'timestamp',
  field: 'modified',
  initial: null,
  overlap: '5m',
  parse: (raw: string) => Date.parse(`${raw.replace(' ', 'T')}Z`), // '2026-01-01 12:00:00'
  format: (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
} as const;

const cursorsCustomFormat = definePoller({
  name: 'legacy',
  identity: (o: { id: string; modified: string }) => o.id,
  cursor: customFormatCursor,
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://legacy.example.com/rows', {
      query: { modified_after: cursor.value },
    });
    return { items: await res.json<{ id: string; modified: string }[]>() };
  },
});

const cursorsToken = definePoller({
  name: 'invoices',
  identity: (i: Invoice) => i.id,
  version: (i) => i.etag,
  cursor: { strategy: 'token', initial: null },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://api.vendor.com/invoices', {
      query: { cursor: cursor.value ?? undefined },
    });
    const body = await res.json<{ data: Invoice[]; next: string | null }>();
    return { items: body.data, cursor: body.next };
  },
});

const cursorsPage = definePoller({
  name: 'products',
  identity: (p: { sku: string }) => p.sku,
  cursor: { strategy: 'page', initial: 1 },
  fetch: async ({ cursor, http }) => {
    const res = await http.get(`https://vendor.example.com/products?page=${cursor.page}`);
    const body = await res.json<{ items: { sku: string }[]; pages: number }>();
    return { items: body.items, hasMore: cursor.page < body.pages };
  },
});

const cursorsSnapshot = definePoller({
  name: 'catalog',
  identity: (p: { sku: string; price: number }) => p.sku,
  cursor: { strategy: 'snapshotDiff' },
  fetch: async ({ page, http }) => {
    const res = await http.get(`https://vendor.example.com/products?page=${page}`);
    const body = await res.json<{ items: { sku: string; price: number }[]; pages: number }>();
    return { items: body.items, hasMore: page < body.pages };
  },
  schedule: { min: '10m', max: '6h' },
  retain: 'payload', // deleted events carry the last known payload
});

interface Row {
  id: number;
  name: string;
}

const cursorsCustom = definePoller({
  name: 'rows',
  identity: (r: Row) => String(r.id),
  cursor: customCursor({
    initial: { afterId: 0 },
    advance: ({ cursor, items }) => {
      const last = items.at(-1) as Row | undefined;
      return last
        ? { cursor: { afterId: last.id }, done: items.length < 100 }
        : { cursor, done: true };
    },
  }),
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://api.example.com/rows', {
      query: { after_id: cursor.afterId, limit: 100 },
    });
    return { items: await res.json<Row[]>() };
  },
});

const cursorsReconcile = definePoller({
  name: 'orders',
  identity: (o: CursorsOrder) => o.id,
  version: (o) => o.updatedAt,
  cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://erp.example.com/orders', {
      query: { updated_since: cursor.value, after_id: cursor.tieBreak },
    });
    return { items: await res.json<CursorsOrder[]>() };
  },
  reconcile: {
    every: '6h',
    fetch: async ({ page, http }) => {
      const res = await http.get('https://erp.example.com/orders', {
        query: { page, limit: 1000 },
      });
      const body = await res.json<{ data: CursorsOrder[]; has_more: boolean }>();
      return { items: body.data, hasMore: body.has_more };
    },
  },
});

// ---------------------------------------------------------------------------------------------
// docs/delivery.md
// ---------------------------------------------------------------------------------------------

const manualAckOrders = definePoller({
  name: 'orders',
  identity: (o: CursorsOrder) => o.id,
  cursor: { strategy: 'snapshotDiff' },
  fetch: async () => ({ items: [] as CursorsOrder[] }),
  delivery: { ackMode: 'manual' },
});

async function deliverySnippets(signal: AbortSignal): Promise<void> {
  const engine = createWatukuy({ store: new MemoryStore(), pollers: { orders: manualAckOrders } });

  engine.on('orders', async (event, ctx) => {
    const ok = await downstream.tryEnqueue(event);
    if (ok) ctx.ack(); // returning without ack() counts as a failure → retry
  });

  const rows = await engine.parked.list('orders', { kind: 'poison', limit: 50 });
  await engine.parked.retry(
    'orders',
    rows.map((r) => r.id),
  ); // back to the outbox as pending
  await engine.parked.discard('orders', [rows[0]!.id]); // gone for good

  // subscribe(): acked when the loop asks for the next event
  const other = createWatukuy({ store: new MemoryStore(), pollers: { orders: cursorsReconcile } });
  for await (const event of other.subscribe('orders', { signal })) {
    await handle(event as unknown as WatukuyEvent<Invoice>);
  }
}

function dedupHandlers(engine: Engine<{ orders: typeof cursorsReconcile }>): void {
  // Queue job id
  engine.on('orders', async (event) => {
    await queue.add('order-sync', event, { jobId: event.id }); // BullMQ ignores a duplicate jobId
  });

  // Unique column
  const applyChange = async (event: WatukuyEvent<CursorsOrder>): Promise<void> => {
    void toCloudEvent(event);
  };
  const handler = async (event: WatukuyEvent<CursorsOrder>): Promise<void> => {
    const { rowCount } = await pool.query(
      'INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [event.id],
    );
    if (rowCount === 0) return; // already processed
    await applyChange(event);
  };
  void handler;
}

// ---------------------------------------------------------------------------------------------
// docs/observability.md
// ---------------------------------------------------------------------------------------------

const audit: Hooks = {
  onParked: ({ poller, partition, row }) =>
    alerts.page(`watukuy: ${poller}/${partition} parked ${row.id}: ${row.error.message}`),
  onCircuitOpen: ({ poller, partition, failures, probeAt }) =>
    alerts.page(
      `watukuy: circuit open for ${poller}/${partition} after ${failures} failures; probe at ${new Date(probeAt).toISOString()}`,
    ),
  onScheduleChange: ({ poller, intervalMs, reason }) =>
    metrics.gauge('poll_interval_ms', intervalMs, { poller, reason }),
};

const observedEngine = createWatukuy({
  store: new MemoryStore(),
  pollers: { orders: cursorsReconcile },
  hooks: [otelHooks({ attributes: { 'service.name': 'erp-sync' } }), audit],
});

function lagGauge(engine: Engine<PollerMap>): void {
  meter.createObservableGauge('watukuy.lag.seconds').addCallback(async (result) => {
    const report = await engine.inspect();
    for (const p of report.pollers) {
      if (p.lagMs !== null)
        result.observe(p.lagMs / 1000, {
          'watukuy.poller': p.poller,
          'watukuy.partition': p.partition,
        });
    }
  });
}

function healthEndpoint(engine: Engine<PollerMap>): void {
  createServer(async (_req, res) => {
    const report = await engine.inspect();
    const unhealthy = report.pollers.filter(
      (p) => p.schedule.circuit !== 'closed' || (p.lagMs ?? 0) > 10 * 60_000 || p.parked > 0,
    );
    res.writeHead(unhealthy.length ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: unhealthy.length ? 'degraded' : 'ok', unhealthy, report }));
  }).listen(8080);
}

// ---------------------------------------------------------------------------------------------
// docs/http-helper.md
// ---------------------------------------------------------------------------------------------

const httpHelperPoller = definePoller({
  name: 'orders',
  identity: (o: CursorsOrder) => o.id,
  cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
  fetch: async ({ cursor, http, signal }) => {
    const res = await http.get('https://erp.example.com/orders', {
      query: { updated_since: cursor.value, after_id: cursor.tieBreak, limit: 500 },
      headers: { authorization: `Bearer ${process.env.ERP_TOKEN}` },
      signal,
    });
    if (res.notModified) return { items: [] };
    const body = await res.json<{ data: unknown[]; has_more: boolean }>();
    return { items: body.data as CursorsOrder[], hasMore: body.has_more };
  },
});

const sdkPoller = definePoller({
  name: 'stripe-events',
  identity: (e: { id: string }) => e.id,
  cursor: { strategy: 'token', initial: null },
  fetch: async ({ cursor, signal }) => {
    const page = await stripe.events.list(
      { starting_after: cursor.value ?? undefined, limit: 100 },
      { signal },
    );
    return { items: page.data, cursor: page.has_more ? page.data.at(-1)!.id : null };
  },
});

// ---------------------------------------------------------------------------------------------
// docs/recipes.md
// ---------------------------------------------------------------------------------------------

function recipesSinks(engine: Engine<{ orders: typeof invoicesLike }>): void {
  engine.on(
    'orders',
    bullmqSink(queue, {
      jobName: (e) => `order.${e.type}`, // default `${poller}.${type}`
      jobOptions: { attempts: 5, removeOnComplete: true },
      format: 'raw', // default 'cloudevents'
    }),
  );
}

const invoicesLike = definePoller({
  name: 'orders',
  identity: (i: Invoice) => i.id,
  cursor: { strategy: 'snapshotDiff' },
  fetch: async () => ({ items: [] as Invoice[] }),
});

function recipesSqs(engine: Engine<{ orders: typeof invoicesLike }>): void {
  engine.on(
    'orders',
    sqsSink(new SQSClient({}), {
      queueUrl: process.env.QUEUE_URL!,
      createCommand: (input) => new SendMessageCommand(input), // the SDK is yours, not a dependency
      messageGroupId: (e) => e.data?.customerId ?? e.subject, // align with delivery.orderingKey
    }),
  );
}

async function recipesKafkaAndWebhook(
  engine: Engine<{ orders: typeof invoicesLike }>,
): Promise<void> {
  engine.on('orders', kafkaSink(producer, { topic: 'erp.orders', format: 'binary' }));

  const other = createWatukuy({ store: new MemoryStore(), pollers: { orders: invoicesLike } });
  other.on(
    'orders',
    webhookSink({
      url: 'https://customer.example.com/hooks/orders',
      secret: process.env.WEBHOOK_SECRET!, // 'whsec_<base64>' or a raw string
      headers: { 'x-tenant': 'acme' },
      timeoutMs: 10_000,
    }),
  );
}

async function webhookReceiver(req: Request): Promise<Response> {
  const body = await req.text();
  const ok = await verifyWebhookSignature({
    secret: process.env.WEBHOOK_SECRET!,
    id: req.headers.get('webhook-id')!,
    timestamp: req.headers.get('webhook-timestamp')!,
    signatureHeader: req.headers.get('webhook-signature')!,
    body,
  });
  if (!ok) return new Response('invalid signature', { status: 401 });
  const ce = JSON.parse(body); // ce.type === 'orders.updated', ce.data is the item
  void ce;
  return new Response(null, { status: 204 });
}

function recipesDurable(engine: Engine<{ orders: typeof invoicesLike }>): void {
  engine.on('orders', async (event) => {
    await inngest.send({ name: 'erp/order.changed', id: event.id, data: event }); // id dedups
  });

  const other = createWatukuy({ store: new MemoryStore(), pollers: { orders: invoicesLike } });
  other.on('orders', async (event) => {
    await temporal.workflow.signalWithStart(orderWorkflow, {
      taskQueue: 'orders',
      workflowId: `order-${event.subject}`, // one workflow per item
      signal: orderChanged,
      signalArgs: [event],
      args: [event.subject],
    });
  });
}

async function recipesForAwait(engine: Engine<{ orders: typeof invoicesLike }>) {
  const ac = new AbortController();
  process.on('SIGTERM', () => ac.abort());

  for await (const event of engine.subscribe('orders', { signal: ac.signal })) {
    await warehouse.apply(event); // acked when the loop pulls the next event
  }
}

interface Rate {
  base: string;
  quote: string;
  rate: number;
  asOf: string;
}

const rates = definePoller({
  name: 'fx-rates',
  identity: (r: Rate) => `${r.base}/${r.quote}`,
  fingerprint: (r) => r.rate, // asOf changes every publish; rate is what matters
  cursor: { strategy: 'snapshotDiff' },
  fetch: async ({ http }) => {
    const res = await http.get('https://fx.example.com/latest');
    return { items: await res.json<Rate[]>() };
  },
  schedule: { min: '1m', max: '30m' },
});

interface Ticket {
  id: number;
  updated: number;
} // updated: 1767225600 (seconds)

const tickets = definePoller({
  name: 'tickets',
  identity: (t: Ticket) => String(t.id),
  version: (t) => t.updated,
  cursor: {
    strategy: 'timestamp',
    field: 'updated',
    tieBreak: 'id',
    initial: null,
    overlap: '5m',
  },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://desk.example.com/api/tickets', {
      query: { since: cursor.value, after_id: cursor.tieBreak, per_page: 100 },
    });
    const body = await res.json<{ tickets: Ticket[]; next_page: string | null }>();
    return { items: body.tickets, hasMore: body.next_page !== null };
  },
});

interface Node {
  id: string;
  updatedAt: string;
}

const graphqlProducts = definePoller({
  name: 'products',
  identity: (n: Node) => n.id,
  version: (n) => n.updatedAt,
  cursor: { strategy: 'token', initial: null },
  fetch: async ({ cursor, http, signal }) => {
    const res = await http.request('https://shop.example.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($after: String) { products(first: 250, after: $after, sortKey: UPDATED_AT) {
          nodes { id updatedAt } pageInfo { hasNextPage endCursor } } }`,
        variables: { after: cursor.value },
      }),
      signal,
      validators: false, // POST: no ETag round trip
    });
    const body = await res.json<{
      data: {
        products: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      };
    }>();
    const { nodes, pageInfo } = body.data.products;
    return { items: nodes, cursor: pageInfo.hasNextPage ? pageInfo.endCursor : null };
  },
});

async function backfillRunbook(engine: Engine<{ orders: typeof cursorsReconcile }>) {
  // 1. Kick off a backfill lane from the beginning of time (or from a specific watermark).
  await engine.backfill('orders', { from: '2025-01-01T00:00:00Z' });

  // 2. Watch progress:
  const { pollers } = await engine.inspect();
  console.log(pollers[0]?.cursors.backfill); // moves toward the live cursor

  // 3. Consumers can tell backfill events apart and, for example, skip notifications:
  engine.on('orders', async (event) => {
    await warehouse.upsert(event);
    if (event.lane === 'live') await notify(event);
  });
}

// ---------------------------------------------------------------------------------------------
// docs/multi-tenant.md and docs/runbook.md: per-partition operations
// ---------------------------------------------------------------------------------------------

async function partitionOperations(): Promise<void> {
  const engine = advancedEngine;
  await engine.trigger('invoices', { partition: 't_42' });
  await engine.pause('invoices', { partition: 't_42' });
  await engine.resume('invoices', { partition: 't_42' });
  await engine.backfill('invoices', { from: null, partition: 't_42' });
  await engine.replay('invoices', { from: '2026-09-01T00:00:00Z', partition: 't_42' });
  await engine.resetCursor('invoices', { partition: 't_42', to: null, clearSnapshot: true });

  const parked = await engine.parked.list('invoices', { partition: 't_42', kind: 'poison' });
  await engine.parked.retry(
    'invoices',
    parked.map((p) => p.id),
    { partition: 't_42' },
  );

  const current = await engine.partitions.list('invoices'); // forces a refresh, returns the list
  void current;
  await engine.partitions.remove('invoices', 't_42');

  engine.on('invoices', async (event, ctx: HandlerContext) => {
    const tenant = ctx.partition.data as Tenant; // the same object fetch() saw
    await warehouse.upsert({ tenant: tenant.id, subject: event.subject, data: event.data });
  });

  await engine.resetCursor('orders', { to: '2026-09-15T00:00:00Z' }); // rewind the live lane
  await engine.resetCursor('orders', { to: null, clearSnapshot: true }); // start over completely
  const { replayed } = await engine.replay('orders', {
    from: '2026-09-01T00:00:00Z',
    to: new Date(),
  });
  void replayed;
  process.on('SIGTERM', () => void engine.stop({ drain: true, timeout: '30s' }));
}

// ---------------------------------------------------------------------------------------------
// Type assertions
// ---------------------------------------------------------------------------------------------

describe('documentation snippets', () => {
  it('README quickstart infers Order from the zod schema', () => {
    quickstartEngine.on('orders', (event) => {
      expectTypeOf(event).toEqualTypeOf<WatukuyEvent<Order>>();
      expectTypeOf(event.data).toEqualTypeOf<Order | undefined>();
      expectTypeOf(event.type).toEqualTypeOf<'created' | 'updated' | 'deleted'>();
    });
    // @ts-expect-error unknown poller names are compile errors
    quickstartEngine.on('nope', () => {});
  });

  it('advanced example types partition data, ordering key events, and subscribe()', () => {
    advancedEngine.on('invoices', (event, ctx) => {
      expectTypeOf(event).toEqualTypeOf<WatukuyEvent<Invoice>>();
      expectTypeOf(ctx.ack).toEqualTypeOf<() => void>();
    });
    advancedEngine.on('catalog', (event) => {
      expectTypeOf(event.previous).toEqualTypeOf<Product | undefined>();
    });
    expectTypeOf(advancedEngine.subscribe('invoices')).toEqualTypeOf<
      AsyncIterable<WatukuyEvent<Invoice>>
    >();
  });

  it('cursor snippets type the cursor per strategy', () => {
    expectTypeOf(cursorsCustom.resolved.cursor.strategy).toEqualTypeOf<
      'timestamp' | 'token' | 'page' | 'snapshotDiff' | 'custom'
    >();
    expectTypeOf(cursorsCustomFormat.name).toEqualTypeOf<'legacy'>();
    expectTypeOf(tickets.name).toEqualTypeOf<'tickets'>();
    expectTypeOf(graphqlProducts.name).toEqualTypeOf<'products'>();
    expectTypeOf(rates.name).toEqualTypeOf<'fx-rates'>();
  });

  it('toCloudEvent keeps the item type', () => {
    quickstartEngine.on('orders', (event) => {
      const ce = toCloudEvent(event);
      expectTypeOf(ce.data).toEqualTypeOf<Order | undefined>();
      expectTypeOf(ce.watukuylane).toEqualTypeOf<'live' | 'backfill' | 'reconcile' | 'replay'>();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// docs/stores.md
// ---------------------------------------------------------------------------------------------

/** Structural stand-in for `pg.Pool` (the `pg` package is not a root dependency). */
declare class Pool {
  constructor(options: { connectionString: string | undefined; max?: number });
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

async function storesConstructors(): Promise<void> {
  new MemoryStore();
  new SqliteStore({ path: './watukuy.db' });
  new PostgresStore({ client: pgPool }); // pg.Pool or a PGlite instance
  new RedisStore({ client: redis }); // ioredis or node-redis instance, adapted automatically

  const engine = createWatukuy({
    store: new PostgresStore({ client: pgPool }),
    budgetStore: new RedisBudgetStore({ client: redis }), // optional: budgets shared across instances
    pollers: { catalog },
  });
  await engine.migrate(); // or store.migrate(), which it forwards to
}

function certifyCustomStore(): void {
  storeContractSuite({
    name: 'MyStore',
    create: async () => new MemoryStore(), // fresh, empty store per test; the suite calls migrate()
    destroy: (store) => store.close(), // default; drop tables or temp files here if needed
  });
}

// ---------------------------------------------------------------------------------------------
// docs/guarantees.md: the chaos harness
// ---------------------------------------------------------------------------------------------

async function chaosUsage(): Promise<void> {
  const report = await runChaos({ seed: 1, strategy: 'timestamp', steps: 120 });
  console.log(describeChaos(report));
  assertChaosReport(report);
}

// ---------------------------------------------------------------------------------------------
// docs/serverless.md
// ---------------------------------------------------------------------------------------------

// Minimal shapes of the Cloudflare bindings used by the Workers snippet.
interface Hyperdrive {
  connectionString: string;
}
interface CfQueue {
  send(body: unknown): Promise<void>;
}
interface ScheduledController {
  cron: string;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface Env {
  HYPERDRIVE: Hyperdrive;
  QUEUE: CfQueue;
}

const cloudflareWorker = {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 2 });
    const engine = createWatukuy({
      store: new PostgresStore({ client: pool }),
      budgets: { erp: { requests: 100, per: '1m' } },
      pollers: { orders },
    });
    engine.on('orders', (event) => env.QUEUE.send(event));
    ctx.waitUntil(engine.tick({ maxDuration: '25s' }).finally(() => pool.end()));
  },
};

function lambdaHandler(): () => Promise<TickResult> {
  // Module scope in the docs: reused across warm invocations. SQLite on EFS, or swap for PostgresStore.
  const engine = createWatukuy({
    store: new SqliteStore({ path: '/mnt/efs/watukuy.db' }),
    budgets: { erp: { requests: 100, per: '1m' } },
    pollers: { orders },
    instanceId: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
  });
  engine.on('orders', async (event) => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.QUEUE_URL!,
        MessageBody: JSON.stringify(event),
      }),
    );
  });

  return async () => engine.tick({ maxDuration: '50s' });
}

async function vercelCron(req: Request): Promise<Response> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const engine = createWatukuy({
    store: new PostgresStore({ client: pool }),
    budgets: { erp: { requests: 100, per: '1m' } },
    pollers: { orders },
  });
  engine.on('orders', async (event) => {
    await inngest.send({ name: 'erp/order.changed', id: event.id, data: event });
  });

  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const result = await engine.tick({ maxDuration: '50s' });
  return Response.json(result);
}

async function kubernetesTick(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PostgresStore({ client: pool });
  const engine = createWatukuy({
    store,
    budgets: { erp: { requests: 100, per: '1m' } },
    pollers: { orders },
    instanceId: process.env.HOSTNAME,
  });
  engine.on('orders', async (event) => {
    await warehouse.upsert(event);
  });

  const result = await engine.tick({ maxDuration: '4m' });
  console.log(JSON.stringify(result));
  await store.close();
  await pool.end();
}

// ---------------------------------------------------------------------------------------------
// docs/nestjs.md
// ---------------------------------------------------------------------------------------------

@Module({
  imports: [
    WatukuyModule.forRoot({
      store: new SqliteStore({ path: './watukuy.db' }),
      budgets: { erp: { requests: 100, per: '1m' } },
      pollers: { orders }, // or an array: [orders]
    }),
  ],
})
class AppModule {}

@Injectable()
class OrdersHandler {
  constructor(private readonly queue: OrdersQueue) {}

  @OnWatukuyEvent('orders')
  async onOrder(event: WatukuyEvent<Order>, ctx: HandlerContext): Promise<void> {
    ctx.logger.info('order changed', { type: event.type, id: event.subject });
    await this.queue.add('order-sync', event, { jobId: event.id });
  }
}

@Injectable()
class SyncAdminService {
  constructor(@Inject(WATUKUY_ENGINE) private readonly engine: Engine<PollerMap>) {}

  pollNow(name: string) {
    return this.engine.trigger(name);
  }
  status() {
    return this.engine.inspect();
  }
  parked(name: string) {
    return this.engine.parked.list(name);
  }
}

// Manual mode: the module only creates the engine; a Nest cron calls tick().
const manualModeModule = WatukuyModule.forRoot({
  store: new MemoryStore(),
  pollers: { catalog },
  mode: 'manual',
});

@Injectable()
class PollCron {
  constructor(@InjectWatukuy() private readonly engine: Engine<PollerMap>) {}

  @Cron('*/1 * * * *')
  tick() {
    return this.engine.tick({ maxDuration: '50s' });
  }
}

@Controller('health')
class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    private readonly watukuy: WatukuyHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.watukuy.isHealthy('watukuy', { maxLagMs: 10 * 60_000 })]);
  }
}

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [WatukuyHealthIndicator], // not registered by WatukuyModule: terminus is optional
})
class HealthModule {}

// Without the adapter
@Injectable()
class WatukuyService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly engine = createWatukuy({
    store: new SqliteStore({ path: './watukuy.db' }),
    budgets: { erp: { requests: 100, per: '1m' } },
    pollers: { orders },
  });

  constructor(private readonly handler: OrdersHandler) {}

  async onApplicationBootstrap() {
    this.engine.on('orders', (e, ctx) => this.handler.onOrder(e, ctx));
    await this.engine.start();
  }

  beforeApplicationShutdown() {
    return this.engine.stop({ drain: true, timeout: '30s' });
  }
}

describe('snippet registry', () => {
  it('references every snippet so the linter sees them used', () => {
    const snippets = {
      orders,
      quickstartEngine,
      quickstart,
      worker,
      testingSnippet,
      catalog,
      invoices,
      advancedEngine,
      advancedUsage,
      tickShape,
      cursorsTimestamp,
      cursorsCustomFormat,
      cursorsToken,
      cursorsPage,
      cursorsSnapshot,
      cursorsCustom,
      cursorsReconcile,
      manualAckOrders,
      deliverySnippets,
      dedupHandlers,
      audit,
      observedEngine,
      lagGauge,
      healthEndpoint,
      httpHelperPoller,
      sdkPoller,
      recipesSinks,
      invoicesLike,
      recipesSqs,
      recipesKafkaAndWebhook,
      webhookReceiver,
      recipesDurable,
      recipesForAwait,
      rates,
      tickets,
      graphqlProducts,
      backfillRunbook,
      partitionOperations,
      storesConstructors,
      certifyCustomStore,
      chaosUsage,
      cloudflareWorker,
      lambdaHandler,
      vercelCron,
      kubernetesTick,
      AppModule,
      OrdersHandler,
      SyncAdminService,
      manualModeModule,
      PollCron,
      HealthController,
      HealthModule,
      WatukuyService,
    };
    expectTypeOf(snippets).toBeObject();
  });
});
