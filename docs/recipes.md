# Recipes

Copy-paste starting points. Every snippet compiles against the public API; replace the vendor URLs and the downstream clients with yours.

## Fan out to a queue: BullMQ

```ts
import { Queue } from 'bullmq';
import { bullmqSink } from 'watukuy/sinks';

const queue = new Queue('orders', { connection: { host: 'localhost', port: 6379 } });

engine.on('orders', bullmqSink(queue, {
  jobName: (e) => `order.${e.type}`,          // default `${poller}.${type}`
  jobOptions: { attempts: 5, removeOnComplete: true },
  format: 'raw',                              // default 'cloudevents'
}));
```

`jobId` is always `event.id`, so BullMQ drops redeliveries and the queue sees each change once. The same by hand:

```ts
engine.on('orders', async (event) => {
  await queue.add('order-sync', event, { jobId: event.id });
});
```

## SQS (FIFO)

```ts
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsSink } from 'watukuy/sinks';

engine.on('orders', sqsSink(new SQSClient({}), {
  queueUrl: process.env.QUEUE_URL!,
  createCommand: (input) => new SendMessageCommand(input),   // the SDK is yours, not a dependency
  messageGroupId: (e) => e.data?.customerId ?? e.subject,     // align with delivery.orderingKey
}));
```

FIFO (default): `MessageDeduplicationId = event.id`, `MessageGroupId` = the ordering key, message attributes `poller`, `type`, `contentType`. Pass `fifo: false` for standard queues.

## Kafka

```ts
import { Kafka } from 'kafkajs';
import { kafkaSink } from 'watukuy/sinks';

const producer = new Kafka({ brokers: ['kafka:9092'] }).producer();
await producer.connect();

engine.on('orders', kafkaSink(producer, { topic: 'erp.orders', format: 'binary' }));
```

Key is `event.subject`, so one item's changes land on one partition in order. `binary` (default) puts `event.data` in the value and the envelope in `ce_*` headers per the CloudEvents Kafka binding; `structured` puts the whole CloudEvent JSON in the value.

## Re-emit as signed webhooks (Standard Webhooks)

```ts
import { webhookSink } from 'watukuy/sinks';

engine.on('orders', webhookSink({
  url: 'https://customer.example.com/hooks/orders',
  secret: process.env.WEBHOOK_SECRET!,          // 'whsec_<base64>' or a raw string
  headers: { 'x-tenant': 'acme' },
  timeoutMs: 10_000,
}));
```

Each event is POSTed as `toCloudEvent(event)` (`application/cloudevents+json`) with `webhook-id` (= `event.id`), `webhook-timestamp` (unix seconds), and `webhook-signature` (`v1,<base64 HMAC-SHA256>` over `${id}.${timestamp}.${body}`). Non-success responses throw `WebhookDeliveryError` (with `status`, `bodyText`, `retryAfterMs`), so the dispatcher retries and eventually parks. This is the tagline made literal.

Receiver side, with the verifier from the same module:

```ts
import { verifyWebhookSignature } from 'watukuy/sinks';

export async function POST(req: Request) {
  const body = await req.text();
  const ok = await verifyWebhookSignature({
    secret: process.env.WEBHOOK_SECRET!,
    id: req.headers.get('webhook-id')!,
    timestamp: req.headers.get('webhook-timestamp')!,
    signatureHeader: req.headers.get('webhook-signature')!,
    body,
  });
  if (!ok) return new Response('invalid signature', { status: 401 });
  const ce = JSON.parse(body);      // ce.type === 'orders.updated', ce.data is the item
  return new Response(null, { status: 204 });
}
```

## Inngest step

```ts
import { Inngest } from 'inngest';

const inngest = new Inngest({ id: 'erp-sync' });

engine.on('orders', async (event) => {
  await inngest.send({ name: 'erp/order.changed', id: event.id, data: event });   // id dedups
});
```

## Temporal signal or workflow start

```ts
engine.on('orders', async (event) => {
  await temporal.workflow.signalWithStart(orderWorkflow, {
    taskQueue: 'orders',
    workflowId: `order-${event.subject}`,        // one workflow per item
    signal: orderChanged,
    signalArgs: [event],
    args: [event.subject],
  });
});
```

`workflowId` per subject plus the deterministic `event.id` inside the signal gives you idempotency on both ends.

## Pull-based consumer with `for await`

```ts
const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());

for await (const event of engine.subscribe('orders', { signal: ac.signal })) {
  await warehouse.apply(event);     // acked when the loop pulls the next event
}
```

Throwing inside the loop leaves the current event unacked; it is redelivered on the next drain.

## API without item ids

Derive a stable identity from the fields that make a row unique, and let the fingerprint hash detect changes:

```ts
import { definePoller } from 'watukuy';

interface Rate { base: string; quote: string; rate: number; asOf: string }

const rates = definePoller({
  name: 'fx-rates',
  identity: (r: Rate) => `${r.base}/${r.quote}`,
  fingerprint: (r) => r.rate,                        // asOf changes every publish; rate is what matters
  cursor: { strategy: 'snapshotDiff' },
  fetch: async ({ http }) => {
    const res = await http.get('https://fx.example.com/latest');
    return { items: await res.json<Rate[]>() };
  },
  schedule: { min: '1m', max: '30m' },
});
```

## API with epoch-seconds timestamps

The default parser understands 10-digit epoch seconds and 13-digit milliseconds, and formats the overlap cursor back in the same shape. Nothing to configure:

```ts
interface Ticket { id: number; updated: number }   // updated: 1767225600 (seconds)

const tickets = definePoller({
  name: 'tickets',
  identity: (t: Ticket) => String(t.id),
  version: (t) => t.updated,
  cursor: { strategy: 'timestamp', field: 'updated', tieBreak: 'id', initial: null, overlap: '5m' },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://desk.example.com/api/tickets', {
      query: { since: cursor.value, after_id: cursor.tieBreak, per_page: 100 },
    });
    const body = await res.json<{ tickets: Ticket[]; next_page: string | null }>();
    return { items: body.tickets, hasMore: body.next_page !== null };
  },
});
```

For anything else (`'2026-01-01 12:00:00'`, `/Date(1767225600000)/`), pass `parse` and `format`; see [cursors.md](./cursors.md#pitfall-4-timestamp-formats-parse--format).

## GraphQL connection with the `token` strategy

```ts
interface Node { id: string; updatedAt: string }

const products = definePoller({
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
      validators: false,      // POST: no ETag round trip
    });
    const body = await res.json<{ data: { products: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } }>();
    const { nodes, pageInfo } = body.data.products;
    return { items: nodes, cursor: pageInfo.hasNextPage ? pageInfo.endCursor : null };
  },
});
```

Returning `cursor: null` at the last page ends the cycle and resets to `initial`, so the next cycle walks the connection from the start; unchanged nodes are suppressed by `version`. For a true incremental feed (a `changesSince` query returning a `syncToken`), return `{ items, cursor: syncToken, hasMore: false }` so the token is kept.

## Deletes for an incremental API: reconcile

```ts
const orders = definePoller({
  name: 'orders',
  identity: (o: { id: string; updatedAt: string }) => o.id,
  version: (o) => o.updatedAt,
  cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://erp.example.com/orders', { query: { updated_since: cursor.value, after_id: cursor.tieBreak } });
    return { items: await res.json<{ id: string; updatedAt: string }[]>() };
  },
  reconcile: {
    every: '6h',
    fetch: async ({ page, http }) => {
      const res = await http.get('https://erp.example.com/orders', { query: { page, limit: 1000, fields: 'id,updatedAt' } });
      const body = await res.json<{ data: { id: string; updatedAt: string }[]; has_more: boolean }>();
      return { items: body.data, hasMore: body.has_more };
    },
  },
});
```

Ask the listing endpoint for the minimum fields that let `identity` and `version` work; the reconcile lane only needs to know what exists and at which version.

## Backfill runbook snippet

Load history into a poller that started "from now":

```ts
// 1. Kick off a backfill lane from the beginning of time (or from a specific watermark).
await engine.backfill('orders', { from: '2025-01-01T00:00:00Z' });

// 2. In tick mode, keep ticking; in daemon mode nothing else to do. Watch progress:
const { pollers } = await engine.inspect();
console.log(pollers[0]?.cursors.backfill);       // moves toward the live cursor

// 3. Consumers can tell backfill events apart and, for example, skip notifications:
engine.on('orders', async (event) => {
  await warehouse.upsert(event);
  if (event.lane === 'live') await notify(event);
});
```

The backfill lane stops when it reaches the live cursor at the time of the call (or `to`), runs at lower budget priority than live, and suppresses items already known at the same version. `force: true` re-emits everything it walks as `updated`, which rebuilds a downstream from scratch.

Related: [delivery.md](./delivery.md), [cursors.md](./cursors.md), [runbook.md](./runbook.md).
