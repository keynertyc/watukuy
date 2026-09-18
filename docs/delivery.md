# Delivery

Everything after `commitPoll` is the dispatcher's job: take pending events out of the outbox, hand them to your handler in the right order, retry what fails, park what keeps failing, and ack what succeeded. This page covers the knobs under `delivery` and how to consume events correctly.

## The `delivery` options

```ts
delivery: {
  orderingKey: (event) => event.data?.customerId ?? event.subject, // default: event.subject
  concurrency: 8,                                                   // default 1
  retry: { attempts: 5, backoff: { base: '1s', factor: 2, max: '2m' } },
  poison: { action: 'park', holdKey: true },
  ackMode: 'auto',
}
```

| Option | Default | Meaning |
|---|---|---|
| `orderingKey` | `(event) => event.subject` | Events with equal keys are delivered strictly in `sequence` order; different keys may run concurrently. The function receives the **event**, so `data` may be `undefined` for `deleted` events under `retain: 'hash'`. |
| `concurrency` | `1` | Maximum ordering keys in flight at once. |
| `retry.attempts` | `5` | Total delivery attempts before the event is poison. `1` means no retry. |
| `retry.backoff` | `{ base: '1s', factor: 2, max: '2m' }` | Exponential backoff with **full jitter**: the delay before attempt *n* is uniform in `[0, min(max, base * factor^(n-1))]`. |
| `poison.action` | `'park'` | `'park'` moves the event to the parked table; `'halt'` also opens the poller's circuit. |
| `poison.holdKey` | `true` | Keep later events for the same ordering key pending while one is parked. |
| `ackMode` | `'auto'` | `'manual'` requires the handler to call `ctx.ack()` before returning. |

## Ordering keys and concurrency

The dispatcher loads up to `dispatchBatchSize` (engine option, default 100) pending rows in `sequence` order, groups them by ordering key, and runs `min(concurrency, groups)` workers. Each worker takes a group and delivers its rows one by one. Acks are per event, so out-of-order completion **across** keys is safe, while order **within** a key is preserved (G3).

Choose the key by what must stay ordered downstream:

- Default `event.subject` (the identity): per-item order. Right for most sync jobs.
- A parent id (`customerId`, `accountId`): per-aggregate order, when a child's `updated` must not overtake its parent's `created`.
- A constant: fully serial delivery. Use `concurrency: 1` and the default key instead; it is the same thing with a better metric label.

`concurrency` bounds the handler's parallelism, not the number of requests to the third-party API: that is the scheduler's and the budget's job.

## Retries

A handler that throws (or rejects) is recorded with `recordAttempt`, the delay is computed with full jitter, and the row's `nextAttemptAt` is set. The group is blocked for the rest of this drain so later events for the same key wait. The runner and daemon wake up at the earliest `nextRetryAt`, so a retry never has to wait for the next poll interval. `event.attempt` is 1-based and increments with each try.

The hook `onRetry` receives `{ event, attempt, error, delayMs }`. A `HandlerError` is never thrown at you; the original error is serialized (`name`, `message`, `stack`, `code`, `status`, `cause`) and stored on the row.

## Poison: park or halt

After `attempts` failures the event is poison.

**`action: 'park'`** (default) writes a `ParkedRow`:

```ts
interface ParkedRow {
  id: string;                  // the event id
  kind: 'poison' | 'invalid';  // 'invalid' rows come from schema validation (see below)
  event: WatukuyEvent | null;  // the event, for poison
  item: unknown;               // the raw item, for invalid
  error: {                     // serialized last error
    name: string; message: string; stack?: string; code?: string; status?: number;
    history?: Array<{ at: number; message: string }>;
    issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>;
  };
  attempts: number;
  parkedAt: number;
  holdKey: string | null;      // the ordering key held, when holdKey: true
}
```

Other ordering keys keep flowing (G7). With **`holdKey: true`** the parked event's key is held: later events for that key stay pending in the outbox, so a fixed handler will process `created`, then `updated`, in order once you call `engine.parked.retry()`. With **`holdKey: false`** the key is released and later events flow past the parked one; use it when order does not matter and you would rather keep up.

**`action: 'halt'`** parks the event and opens the poller's circuit. The key stops polling until the next probe (`circuit.probeEvery`), and `inspect()` shows `schedule.lastError.name === 'PoisonHalt'`. Use it when one bad event means the downstream is broken and continuing would only pile up parked rows.

Operations:

```ts
const rows = await engine.parked.list('orders', { kind: 'poison', limit: 50 });
await engine.parked.retry('orders', rows.map((r) => r.id));   // back to the outbox as pending
await engine.parked.discard('orders', [rows[0]!.id]);        // gone for good
```

For partitioned pollers pass `{ partition }` in the options.

## Quarantined items

Invalid items (those failing the Standard Schema, with `onInvalid: 'quarantine'`, the default) are written to the same parked table with `kind: 'invalid'`, the raw `item`, the validation `issues`, and `holdKey: null`. They never enter the outbox and never block delivery. List them with `engine.parked.list(name, { kind: 'invalid' })`. Fix the schema or the upstream data, then `discard` them; the item will be re-fetched and re-validated by the next cycle that includes it.

## Manual ack

```ts
const orders = definePoller({
  // ...
  delivery: { ackMode: 'manual' },
});

engine.on('orders', async (event, ctx) => {
  const ok = await downstream.tryEnqueue(event);
  if (ok) ctx.ack();                  // returning without ack() counts as a failure → retry
});
```

In `'manual'` mode the handler must call `ctx.ack()` **before it returns**. Returning without acking fails the delivery with a clear error and schedules a retry. Acking after the promise resolved has no effect. In `'auto'` mode `ctx.ack()` is a harmless no-op, which is why the built-in sinks always call it.

The handler context is `{ signal, logger, partition, attempt, ack }`. `signal` aborts when the engine stops without drain or the lease is lost.

## Pull-based consumption: `subscribe()`

```ts
const ac = new AbortController();

for await (const event of engine.subscribe('orders', { signal: ac.signal })) {
  await handle(event);   // the event is acked when the loop asks for the next one
}
```

`subscribe()` returns an `AsyncIterable` with backpressure: the dispatcher does not fetch the next outbox slice until the consumer pulls. An event is acknowledged when you call `next()` again (or `return()` by leaving the loop normally). If the loop body throws, or the signal aborts while an event is in flight, that event is **not** acked and will be redelivered (G1). The iterable can be iterated once. `on()` and `subscribe()` are mutually exclusive for one poller: attaching a second consumer throws a `ConfigError`.

`subscribe()` works with `start()` and with `tick()`. In tick mode, start iterating before (or concurrently with) the tick so the drain has somewhere to deliver.

## Events wait for a consumer

If a poller has no handler when it runs, its events are committed to the outbox and the engine logs one warning. They are delivered on the next drain after `on()` or `subscribe()` is attached, even if the poller is not due yet. Nothing is dropped.

## Dedup at the consumer

At-least-once means duplicates are possible: crash between ack and the next store call, a lost lease mid-dispatch, an overlap window that re-observes a change, a replay. Every duplicate carries the **same `event.id`** (G2). Pick one:

**Queue job id**

```ts
engine.on('orders', async (event) => {
  await queue.add('order-sync', event, { jobId: event.id }); // BullMQ ignores a duplicate jobId
});
```

**Unique column**

```sql
CREATE TABLE processed_events (id TEXT PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT now());
```

```ts
engine.on('orders', async (event) => {
  const { rowCount } = await pool.query(
    'INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [event.id],
  );
  if (rowCount === 0) return;          // already processed
  await applyChange(event);
});
```

**Version compare-and-set**: store the item's `version` (or the fingerprint hash you derive from `event.data`) next to your copy and skip events whose version is not newer. This also protects against out-of-order delivery across restarts of *your* consumer, which watukuy cannot see.

**Idempotent writes**: `UPSERT ... WHERE excluded.updated_at > current.updated_at`. If the handler is naturally idempotent, dedup is optional.

## Delivery and lanes

Backfill, reconcile, and replay events flow through the same dispatcher, same ordering keys, same retries, same parked table. `event.lane` tells you where an event came from; a consumer that only wants live changes can `if (event.lane !== 'live') return;` and still ack it.

Related: [guarantees.md](./guarantees.md), [runbook.md](./runbook.md), [recipes.md](./recipes.md).
