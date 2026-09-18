# Serverless and scheduled runtimes

`engine.tick()` is the one-shot mode: run one pass over every due `(poller, partition)`, drain outboxes, persist schedules, release leases, return a summary. Call it from any scheduler. Because all state (cursors, intervals, circuits, outbox, leases) lives in the store, `tick()` invocations from different containers, or a mix of `tick()` and `start()`, behave like one daemon.

## `tick()` semantics

```ts
const result = await engine.tick({ maxDuration: '50s', only: ['orders'] });
```

| Option | Default | Meaning |
|---|---|---|
| `maxDuration` | none | Cooperative deadline for the whole pass. Checked before each key and between pages; a running page is never interrupted. |
| `only` | all pollers | Restrict the pass to these poller names. |

```ts
interface TickResult {
  polled: TickPollResult[];  // one entry per (poller, partition, lane) that ran
  skippedLeased: number;     // due keys another instance is working on
  skippedNotDue: number;     // keys not due yet (or paused)
  durationMs: number;
  timedOut: boolean;         // the deadline stopped the pass before every key was visited
}

interface TickPollResult {
  poller: string;
  partition: string;
  lane: 'live' | 'backfill' | 'reconcile' | 'replay';
  items: number;
  events: number;
  delivered: number;
  durationMs: number;
  error: SerializedError | null;   // fetch failures land here, never thrown
}
```

What one tick does per key, in order: drain the pending outbox, run the live lane if due (or forced), run reconcile if due, run backfill if active, save the schedule, release the lease. Up to four keys run concurrently. When `maxDuration` cuts a cycle short, the summary is `truncated`, the key is marked due immediately, and the next tick picks up from the last committed page.

Rules of the road:

- **Attach handlers before `tick()`.** A poller without a consumer commits its events to the outbox and delivers them on a later tick once a consumer exists. Nothing is lost, but nothing is delivered either.
- **Retries need ticks.** A handler failure schedules a retry at `nextAttemptAt`; it is delivered by the next tick that runs after that time. Your cron cadence bounds retry latency. A five-minute cron with a `2m` backoff cap means a failed event is retried on the next invocation.
- **Leases outlive the invocation only on a crash.** A normal tick releases every lease before returning. If the platform kills the function mid-run, the lease expires after `lease.ttl` (default `30s`) and the next tick takes over; events committed before the kill are drained first. Keep `lease.ttl` above your longest single page fetch and below your cron period.
- **Set `maxDuration` below the platform timeout** with a margin for the slowest page: Lambda at 60s with `maxDuration: '50s'`, Workers cron at 30s CPU (wall-clock is generous) with `'25s'`.
- **Constructing the engine per invocation is fine.** It holds no state that matters. Module-level construction lets warm invocations reuse the store connection.

## Cloudflare Workers (cron trigger)

```ts
import { createWatukuy } from 'watukuy';
import { PostgresStore } from 'watukuy/store-postgres';
import { Pool } from 'pg';
import { orders } from './pollers.ts';

interface Env { HYPERDRIVE: Hyperdrive; QUEUE: Queue }

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 2 });
    const engine = createWatukuy({ store: new PostgresStore({ client: pool }), pollers: { orders } });
    engine.on('orders', (event) => env.QUEUE.send(event));
    ctx.waitUntil(
      engine.tick({ maxDuration: '25s' }).finally(() => pool.end()),
    );
  },
};
```

`wrangler.jsonc`:

```jsonc
{
  "triggers": { "crons": ["*/1 * * * *"] },
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive-id>" }]
}
```

Notes: the core needs only WinterTC APIs and runs on `workerd` as is. `SqliteStore` uses `node:sqlite` and is not available on Workers; use Postgres over Hyperdrive (with `nodejs_compat` for `pg`) or Redis. `MemoryStore` works for a demo but forgets everything between invocations. A Durable Object store is on the roadmap.

## AWS Lambda + EventBridge Scheduler

```ts
import { createWatukuy } from 'watukuy';
import { SqliteStore } from 'watukuy/store-sqlite';
import { orders } from './pollers.ts';

// Module scope: reused across warm invocations. SQLite on EFS, or swap for PostgresStore.
const engine = createWatukuy({
  store: new SqliteStore({ path: '/mnt/efs/watukuy.db' }),
  pollers: { orders },
  instanceId: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
});
engine.on('orders', async (event) => {
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL!, MessageBody: JSON.stringify(event) }));
});

export const handler = async () => engine.tick({ maxDuration: '50s' });
```

Schedule with EventBridge Scheduler (`rate(1 minute)`) and a 60s function timeout. Set `reservedConcurrentExecutions: 1` if you want exactly one invocation at a time; otherwise concurrent invocations are harmless, the second sees `skippedLeased`.

## Vercel cron

```ts
// app/api/cron/poll/route.ts
import { createWatukuy } from 'watukuy';
import { PostgresStore } from 'watukuy/store-postgres';
import { Pool } from 'pg';
import { orders } from '@/pollers';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const engine = createWatukuy({ store: new PostgresStore({ client: pool }), pollers: { orders } });
engine.on('orders', async (event) => { await inngest.send({ name: 'erp/order.changed', id: event.id, data: event }); });

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const result = await engine.tick({ maxDuration: '50s' });
  return Response.json(result);
}
```

`vercel.json`: `{ "crons": [{ "path": "/api/cron/poll", "schedule": "* * * * *" }] }`. Set `maxDuration` in the route config to at least the tick deadline plus a margin. Use the Node.js runtime, not Edge, for `pg`.

## Kubernetes CronJob

```ts
// scripts/tick.ts — run with: node scripts/tick.ts
import { createWatukuy } from 'watukuy';
import { PostgresStore } from 'watukuy/store-postgres';
import { Pool } from 'pg';
import { orders } from '../src/pollers.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresStore({ client: pool });
const engine = createWatukuy({ store, pollers: { orders }, instanceId: process.env.HOSTNAME });
engine.on('orders', async (event) => { /* ... */ });

const result = await engine.tick({ maxDuration: '4m' });
console.log(JSON.stringify(result));
await store.close();
await pool.end();
```

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: watukuy-tick }
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid       # or Allow: extra pods just see skippedLeased
  jobTemplate:
    spec:
      activeDeadlineSeconds: 290
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: tick
              image: ghcr.io/acme/erp-sync:1.4.0
              command: ["node", "scripts/tick.ts"]
              envFrom: [{ secretRef: { name: erp-sync } }]
```

If the pod is `SIGKILL`ed at the deadline, the lease expires after `lease.ttl` and the next job resumes from the outbox. For a long-running Deployment instead of a CronJob, call `engine.start()` and handle `SIGTERM` with `engine.stop({ drain: true, timeout: '30s' })`.

The same pass is available without a custom script: `npx watukuy tick --config ./watukuy.config.ts --max-duration 4m`, where the config module exports the engine (`export default engine`). `npx watukuy run --config ...` is the daemon equivalent, stopping on `SIGINT` / `SIGTERM`.

## Mixing daemon and tick

A Deployment running `start()` and a CronJob running `tick()` against the same store cooperate through leases and the persisted schedule: whichever is due first and gets the lease runs, the other skips. This is a reasonable way to add a "poll now" endpoint (`engine.trigger()` then `engine.tick({ only: [name] })`) to a service whose main loop is elsewhere.

## Portability

The core (`src/core`, `src/scheduler`, `src/cursor`, `src/diff`, `src/budget`, `src/http`, `src/validate`) uses only `fetch`, `AbortSignal`, `crypto.subtle.digest`, `TextEncoder`, timers, and `queueMicrotask`. There are no `node:` imports outside stores, the CLI, and the NestJS adapter, and a test enforces it. CI runs the core suite on Node 22, 24, 26 and on Bun. Pass a custom `fetch` with `createWatukuy({ fetch })` when the runtime's global is missing or wrapped (proxies, instrumentation, `undici` agents).

Related: [how-it-works.md](./how-it-works.md), [stores.md](./stores.md), [runbook.md](./runbook.md).
