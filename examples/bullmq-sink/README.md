# bullmq-sink

Every change becomes a BullMQ job with `bullmqSink(queue)`. A `Worker` in the same process
consumes the jobs and prints them. Job data is the CloudEvent; `jobId = event.id`, so if
watukuy ever redelivers (at-least-once), BullMQ drops the duplicate.

## Requirements

Redis at `localhost:6379` (override with `REDIS_HOST` / `REDIS_PORT`):

```sh
docker run --rm -p 6379:6379 redis:7
```

The script probes the TCP port first. **Without Redis it prints a hint and exits 0**, so the
example is optional to run but always safe to invoke (and it always typechecks).

## Run

```sh
pnpm install && pnpm build          # once, at the repo root
pnpm --dir examples/bullmq-sink start
# or: node examples/bullmq-sink/main.ts --duration 20
```

## What you will see

Without Redis:

```
[bullmq-sink] Redis is not reachable at 127.0.0.1:6379.
[bullmq-sink] Start one with:  docker run --rm -p 6379:6379 redis:7
[bullmq-sink] This example is optional; exiting 0.
```

With Redis, one line per job as the worker processes it (job name = `${poller}.${type}`):

```
[engine]  polling FakeApi -> queue "watukuy-orders" on 127.0.0.1:6379
[worker]  orders.created job=d684f2292e1a ord-1 open $100
[worker]  orders.created job=9f8da6238732 ord-2 open $200
[worker]  orders.created job=a456daf2aad0 ord-3 open $300
[worker]  orders.updated job=5178d14d5f4e ord-3 paid $300
[worker]  orders.created job=c18f916132af ord-4 open $71
[worker]  orders.updated job=9caf147c32cf ord-2 paid $200
[worker]  orders.updated job=df498de86560 ord-4 paid $71
[worker]  orders.updated job=2192382bee8f ord-1 paid $100
[worker]  orders.updated job=1cfb7cb6bca6 ord-2 shipped $200
[engine]  14s elapsed: stopping
```

(`job=` is the first 12 hex chars of `event.id`, the deterministic BullMQ `jobId`.)

## Notes

- The sink never retries: a failing `queue.add` is retried by watukuy's dispatcher with
  backoff and eventually parked. BullMQ's own `attempts`/`backoff` apply to the worker side;
  pass them through `jobOptions`.
- `removeOnComplete` / `removeOnFail` are passed via `jobOptions` so the demo does not fill
  Redis. Any BullMQ job option works; `jobId` is always overwritten with `event.id`.
- To keep the queue's ordering aligned with watukuy's, consume with one worker per
  `event.subject` group or use BullMQ groups (Pro). The dispatcher itself delivers events with
  equal ordering keys sequentially.
