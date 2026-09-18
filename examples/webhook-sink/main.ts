/**
 * "Webhooks for APIs that don't have them", literally.
 *
 * Two parties live in this file and only talk over HTTP:
 *
 *   receiver  a plain `node:http` server, the kind you would run in your own app. It verifies
 *             the Standard Webhooks signature with `verifyWebhookSignature()` and prints the
 *             CloudEvent. Once, it answers 503 to show that redeliveries reuse the same id.
 *   engine    watukuy polling a `FakeApi` (in-memory third-party API) and re-emitting every
 *             change with `webhookSink()`.
 *
 *   node main.ts --duration 20     # default: run until Ctrl+C
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Clock, type CloudEvent, createWatukuy, definePoller, MemoryStore } from 'watukuy';
import { verifyWebhookSignature, webhookSink } from 'watukuy/sinks';
import { FakeApi } from 'watukuy/testing';

interface Order {
  id: string;
  status: 'open' | 'paid' | 'shipped';
  total: number;
  updatedAt: string;
  [extra: string]: unknown;
}

// Standard Webhooks secret: `whsec_` + base64 key. Share it out of band with the receiver.
const SECRET = `whsec_${randomBytes(32).toString('base64')}`;

// ================================================================ receiver
const seen = new Set<string>();
let deliveries = 0;

const receiver = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/hooks/orders') {
    res.writeHead(404).end();
    return;
  }
  const body = await readBody(req);
  const id = header(req, 'webhook-id');

  // 1. Verify before parsing anything: constant-time HMAC over `${id}.${timestamp}.${body}`,
  //    timestamp within 5 minutes. Anyone can POST to your URL; only the engine knows SECRET.
  const ok = await verifyWebhookSignature({
    secret: SECRET,
    id,
    timestamp: header(req, 'webhook-timestamp'),
    signatureHeader: header(req, 'webhook-signature'),
    body,
  });
  if (!ok) {
    console.log(`[receiver] rejected ${id.slice(0, 12)}: bad signature -> 401`);
    res.writeHead(401).end();
    return;
  }

  // 2. Simulate one outage. The dispatcher retries with backoff; the retry carries the same
  //    webhook-id, so an idempotent receiver can dedupe on it.
  deliveries++;
  if (deliveries === 4) {
    console.log(`[receiver] ${id.slice(0, 12)} -> 503 (simulated outage; watch it come back)`);
    res.writeHead(503, { 'retry-after': '1' }).end();
    return;
  }

  // 3. The body is a CloudEvents 1.0 structured-mode JSON (`type` is `<poller>.<change>`).
  const ce = JSON.parse(body) as CloudEvent<Order>;
  const duplicate = seen.has(ce.id);
  seen.add(ce.id);
  const summary = duplicate
    ? '(redelivery of an id we already processed: skip)'
    : `${ce.data?.status ?? '?'} $${ce.data?.total ?? '?'}`;
  console.log(
    `[receiver] ${ce.type.padEnd(14)} ${ce.subject} seq=${ce.watukuysequence} ${summary}`,
  );
  res.writeHead(204).end();
});

await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/orders`;
console.log(`[receiver] listening at ${receiverUrl}`);

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ================================================================ engine
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const api = new FakeApi<Order>({ clock, identity: (o) => o.id, timestampField: 'updatedAt' });
for (let i = 1; i <= 3; i++) {
  api.add({ id: `ord-${i}`, status: 'open', total: 100 * i, updatedAt: '' });
}

const orders = definePoller({
  name: 'orders',
  identity: (o: Order) => o.id,
  version: (o) => o.updatedAt,
  cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
  fetch: async ({ cursor }) => {
    const page = api.listSince({ since: cursor.value, afterId: cursor.tieBreak, limit: 50 });
    return { items: page.items, hasMore: page.hasMore };
  },
  schedule: { min: '1s', max: '5s' },
  // Delivery failures (non-2xx, network errors) are retried by the dispatcher, never by the
  // sink, so there is exactly one retry policy. After `attempts` the event is parked.
  delivery: { retry: { attempts: 5, backoff: { base: '1s', factor: 2, max: '10s' } } },
});

const engine = createWatukuy({
  store: new MemoryStore(),
  pollers: { orders },
  hooks: {
    onRetry: ({ event, attempt, delayMs }) =>
      console.log(`[engine]   retry #${attempt} for ${event.subject} in ${delayMs}ms`),
    onParked: ({ row }) =>
      console.log(`[engine]   parked ${row.event?.subject} after ${row.attempts} attempts`),
  },
});

// This is the whole integration: the handler IS the webhook.
engine.on('orders', webhookSink({ url: receiverUrl, secret: SECRET }));
await engine.start();
console.log('[engine]   polling FakeApi; every change becomes a signed POST');

// Simulated activity on the third-party side.
const NEXT: Record<Order['status'], Order['status'] | null> = {
  open: 'paid',
  paid: 'shipped',
  shipped: null,
};
let nextId = 4;
const activity = setInterval(() => {
  const open = api.all().filter((o) => NEXT[o.status] !== null);
  if (open.length === 0 || Math.random() < 0.35) {
    api.add({
      id: `ord-${nextId++}`,
      status: 'open',
      total: Math.round(20 + Math.random() * 480),
      updatedAt: '',
    });
  } else {
    const o = open[Math.floor(Math.random() * open.length)] as Order;
    api.update(o.id, { status: NEXT[o.status] as Order['status'] });
  }
}, 2_000);

async function shutdown(reason: string): Promise<void> {
  clearInterval(activity);
  console.log(`[engine]   ${reason}: stopping`);
  await engine.stop({ drain: true });
  receiver.close();
  const p = (await engine.inspect()).pollers[0];
  console.log(
    `[engine]   done. delivered=${seen.size} pending=${p?.outboxPending} parked=${p?.parked}`,
  );
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
const flag = process.argv.indexOf('--duration');
const durationSec = flag === -1 ? 0 : Number(process.argv[flag + 1] ?? 0);
if (durationSec > 0)
  setTimeout(() => void shutdown(`${durationSec}s elapsed`), durationSec * 1_000);
