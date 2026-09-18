/**
 * Push every change into a BullMQ queue with `bullmqSink()`.
 *
 * Needs Redis at localhost:6379 (override with REDIS_HOST / REDIS_PORT):
 *
 *   docker run --rm -p 6379:6379 redis:7
 *   node main.ts --duration 20
 *
 * Without Redis the script prints a hint and exits 0, so it is safe in CI.
 *
 * Why a queue? Your handler becomes "add a job" (fast, durable, retried by BullMQ), and the
 * real work runs in workers you can scale. `jobId = event.id` is deterministic, so if watukuy
 * ever redelivers (at-least-once), BullMQ drops the duplicate: effectively-once at the queue.
 */
import { connect } from 'node:net';
import { Queue, Worker } from 'bullmq';
import { type Clock, type CloudEvent, createWatukuy, definePoller, MemoryStore } from 'watukuy';
import { bullmqSink } from 'watukuy/sinks';
import { FakeApi } from 'watukuy/testing';

const REDIS = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

if (!(await reachable(REDIS.host, REDIS.port))) {
  console.log(`[bullmq-sink] Redis is not reachable at ${REDIS.host}:${REDIS.port}.`);
  console.log('[bullmq-sink] Start one with:  docker run --rm -p 6379:6379 redis:7');
  console.log('[bullmq-sink] This example is optional; exiting 0.');
  process.exit(0);
}

interface Order {
  id: string;
  status: 'open' | 'paid' | 'shipped';
  total: number;
  updatedAt: string;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------- BullMQ side
const QUEUE = 'watukuy-orders';
const queue = new Queue(QUEUE, { connection: REDIS });

// Job data is the CloudEvent by default (`format: 'raw'` gives the WatukuyEvent instead).
const worker = new Worker<CloudEvent<Order>>(
  QUEUE,
  async (job) => {
    const ce = job.data;
    console.log(
      `[worker]  ${job.name.padEnd(14)} job=${String(job.id).slice(0, 12)} ${ce.subject} ` +
        `${ce.data?.status ?? '?'} $${ce.data?.total ?? '?'}`,
    );
  },
  { connection: REDIS },
);
worker.on('failed', (job, err) => console.log(`[worker]  failed ${job?.id}: ${err.message}`));

// ---------------------------------------------------------------- watukuy side
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const api = new FakeApi<Order>({ clock, identity: (o) => o.id, timestampField: 'updatedAt' });
for (let i = 1; i <= 3; i++)
  api.add({ id: `ord-${i}`, status: 'open', total: 100 * i, updatedAt: '' });

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
});

const engine = createWatukuy({ store: new MemoryStore(), pollers: { orders } });

// The sink: job name defaults to `${poller}.${type}` (e.g. `orders.updated`), jobId = event.id.
engine.on(
  'orders',
  bullmqSink(queue, { jobOptions: { removeOnComplete: 1_000, removeOnFail: 1_000 } }),
);
await engine.start();
console.log(`[engine]  polling FakeApi -> queue "${QUEUE}" on ${REDIS.host}:${REDIS.port}`);

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
  console.log(`[engine]  ${reason}: stopping`);
  await engine.stop({ drain: true });
  await worker.close();
  await queue.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
const flag = process.argv.indexOf('--duration');
const durationSec = flag === -1 ? 0 : Number(process.argv[flag + 1] ?? 0);
if (durationSec > 0)
  setTimeout(() => void shutdown(`${durationSec}s elapsed`), durationSec * 1_000);

/** TCP-level probe with a 1s timeout; avoids BullMQ's own reconnect loop when Redis is absent. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
