# Observability

Three layers: **hooks** (raw lifecycle callbacks), **`watukuy/otel`** (spans and metrics built on the hooks), and **`inspect()`** (a serializable snapshot of persisted state for health endpoints and dashboards). Plus a `Logger` port.

## Hooks

Pass one or several hook sets to `createWatukuy({ hooks })`. Every hook is optional, may be sync or async, and is awaited. Errors thrown by a hook are logged at `warn` and never affect the engine. All payloads extend `HookContext = { poller, partition, lane, instanceId }`.

| Hook | Extra payload | Fires |
|---|---|---|
| `onLeaseAcquired` | `{ lease: { owner, epoch, expiresAt } }` | once per key run, after `acquireLease` |
| `onPollStart` | `{ startedAt }` | at the start of each lane cycle |
| `onFetch` | `{ page, durationMs, items, notModified }` | after each `fetch` page |
| `onCommit` | `{ events, upserts, deletes, durationMs }` | after each `commitPoll` |
| `onEvent` | `{ event }` | once per event committed to the outbox |
| `onDelivered` | `{ event, attempt, durationMs }` | after a handler succeeded and the event was acked |
| `onRetry` | `{ event, attempt, error, delayMs }` | after a handler failed with attempts left |
| `onParked` | `{ row: ParkedRow }` | when a poison event is parked |
| `onInvalid` | `{ item, issues }` | once per quarantined item |
| `onError` | `{ error, phase: 'fetch' \| 'commit' \| 'dispatch' \| 'lease' \| 'schedule' }` | when a lane cycle fails |
| `onLeaseLost` | `{ epoch }` | when a write is rejected with `LeaseLostError` or a renewal fails |
| `onCircuitOpen` | `{ failures, probeAt }` | when the circuit opens (consecutive failures or poison halt) |
| `onCircuitClose` | none | when a probe (or any successful cycle) closes an open circuit |
| `onBudgetWait` | `{ budget, waitMs }` | once per granted budget request that had to wait |
| `onScheduleChange` | `{ intervalMs, nextDueAt, reason }` | after every live cycle; `reason` is one of `events:speed-up`, `idle:back-off`, `not-modified`, `fixed`, `catch-up`, `paced`, `throttled`, `backoff`, `circuit-open`, `probe-failed` |
| `onPollEnd` | `{ summary: PollSummary }` | at the end of each lane cycle, success or failure |

`error` payloads are `SerializedError` objects: `{ name, message, code?, stack?, status?, cause? }`.

```ts
import { createWatukuy, type Hooks } from 'watukuy';

const audit: Hooks = {
  onParked: ({ poller, partition, row }) =>
    alerts.page(`watukuy: ${poller}/${partition} parked ${row.id}: ${row.error.message}`),
  onCircuitOpen: ({ poller, partition, failures, probeAt }) =>
    alerts.page(`watukuy: circuit open for ${poller}/${partition} after ${failures} failures; probe at ${new Date(probeAt).toISOString()}`),
  onScheduleChange: ({ poller, intervalMs, reason }) =>
    metrics.gauge('poll_interval_ms', intervalMs, { poller, reason }),
};

const engine = createWatukuy({ store, pollers: { orders }, hooks: [audit] });
```

The ordering of hooks within one cycle is `onLeaseAcquired → onPollStart → (onFetch → onCommit → onEvent* → onDelivered*)* → onScheduleChange → onPollEnd`.

## OpenTelemetry (`watukuy/otel`)

```ts
import { createWatukuy } from 'watukuy';
import { otelHooks } from 'watukuy/otel';

const engine = createWatukuy({
  store,
  pollers: { orders },
  hooks: [otelHooks({ attributes: { 'service.name': 'erp-sync' } })],
});
```

Requires the optional peer `@opentelemetry/api`. With no SDK registered the API returns no-op tracers and meters, so shipping the hooks everywhere costs a few `Map` lookups. Options: `tracer`, `meter` (defaults `trace.getTracer('watukuy', VERSION)` / `metrics.getMeter('watukuy', VERSION)`), `attributes` (added to every span and metric), `recordEventIds` (adds `watukuy.event.id` to deliver spans; off by default because of cardinality).

**Spans** (attributes `watukuy.poller`, `watukuy.partition`, `watukuy.lane`, `watukuy.instance_id`):

| Span | One per | Attributes |
|---|---|---|
| `watukuy.poll` | lane cycle | `watukuy.pages`, `watukuy.items`, `watukuy.events.created` / `.updated` / `.deleted`, `watukuy.not_modified`, `watukuy.truncated`; status `ERROR` when `onError` fired during the cycle for a non-dispatch phase |
| `watukuy.fetch` | page, child of the poll span | `watukuy.page`, `watukuy.items`, `watukuy.not_modified` |
| `watukuy.commit` | commit, child of the poll span | `watukuy.events`, `watukuy.upserts`, `watukuy.deletes` |
| `watukuy.deliver` | successful delivery | `watukuy.event.type`, `watukuy.attempt`, optionally `watukuy.event.id` |

**Metrics** (attributes `watukuy.poller`, `watukuy.partition`, `watukuy.lane`; `instance_id` deliberately omitted):

| Instrument | Kind | Extra attributes |
|---|---|---|
| `watukuy.poll.duration` | histogram (ms) | `watukuy.outcome` = `ok` \| `error` |
| `watukuy.items.fetched` | counter | |
| `watukuy.events.emitted` | counter | `watukuy.event.type` |
| `watukuy.events.delivered` | counter | |
| `watukuy.events.retried` | counter | |
| `watukuy.events.parked` | counter | `watukuy.kind` = `poison` \| `invalid` |
| `watukuy.items.invalid` | counter | |
| `watukuy.errors` | counter | `watukuy.phase` |
| `watukuy.lease.lost` | counter | |
| `watukuy.circuit.opened` | counter | |
| `watukuy.budget.waits` | counter | `watukuy.budget` |
| `watukuy.budget.wait` | histogram (ms) | `watukuy.budget` |
| `watukuy.deliver.duration` | histogram (ms) | |
| `watukuy.circuit.state` | observable gauge per `(poller, partition)` | `0` closed, `1` half-open, `2` open |
| `watukuy.schedule.interval` | observable gauge per `(poller, partition)`, ms | |

Duration histograms share bucket boundaries from 5 ms to 60 s.

Lag is not an OTel metric in this release: it is a property of the stored cursor rather than of a hook, so read it from `inspect()` (below) and export it from your health endpoint or a periodic gauge callback:

```ts
meter.createObservableGauge('watukuy.lag.seconds').addCallback(async (result) => {
  const report = await engine.inspect();
  for (const p of report.pollers) {
    if (p.lagMs !== null) result.observe(p.lagMs / 1000, { 'watukuy.poller': p.poller, 'watukuy.partition': p.partition });
  }
});
```

## `inspect()`

```ts
const report = await engine.inspect();
```

```ts
interface InspectReport {
  instanceId: string;
  status: 'idle' | 'running' | 'stopping' | 'stopped';
  generatedAt: number;                 // epoch ms
  pollers: PollerInspect[];            // one per active (poller, partition)
}

interface PollerInspect {
  poller: string;
  partition: string;                   // '' for single-partition pollers
  paused: boolean;
  lease: { owner: string; epoch: number; expiresAt: number } | null;
  cursors: Partial<Record<'live' | 'backfill' | 'reconcile' | 'replay', unknown>>; // parsed cursor per lane
  schedule: {
    nextDueAt: number | null;
    intervalMs: number | null;
    consecutiveFailures: number;
    circuit: 'closed' | 'open' | 'half-open';
    circuitOpenedAt: number | null;
    throttledUntil: number | null;     // Retry-After window, epoch ms
    rateLimit: { limit?: number; remaining?: number; resetAt?: number; policy?: string; source: 'ietf' | 'legacy' | 'vendor' } | null;
    lastPollAt: number | null;
    lastPoll: PollSummary | null;
    lastError: SerializedError | null;
  };
  lastPoll: {                          // same object as schedule.lastPoll
    lane: string; startedAt: number; durationMs: number; pages: number; items: number;
    events: { created: number; updated: number; deleted: number };
    notModified: boolean; truncated: boolean;
  } | null;
  outboxPending: number;
  parked: number;
  items: number;                       // snapshot size
  lagMs: number | null;                // now - cursor for timestamp pollers, else null
}
```

Everything is plain JSON. Fields worth alerting on:

| Field | Alert when | Meaning |
|---|---|---|
| `schedule.circuit` | `!== 'closed'` | the API keeps failing, or a poison halt happened |
| `lagMs` | above your freshness SLO | the watermark is falling behind real time |
| `outboxPending` | growing across two reports | the handler is failing, slow, or not attached |
| `parked` | `> 0` | poison events or invalid items need a human |
| `schedule.consecutiveFailures` | `> 0` for long | fetch is erroring but the circuit has not opened yet |
| `schedule.throttledUntil` | far in the future | the API asked for a long `Retry-After` |
| `lease` | `owner` unexpected or `expiresAt` in the past while `status === 'running'` | a stuck or stolen lease |
| `schedule.lastError` | non-null | the last cycle failed; `name === 'PoisonHalt'` for a halted poller |

### Health endpoint example

```ts
import { createServer } from 'node:http';

createServer(async (_req, res) => {
  const report = await engine.inspect();
  const unhealthy = report.pollers.filter(
    (p) => p.schedule.circuit !== 'closed' || (p.lagMs ?? 0) > 10 * 60_000 || p.parked > 0,
  );
  res.writeHead(unhealthy.length ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: unhealthy.length ? 'degraded' : 'ok', unhealthy, report }));
}).listen(8080);
```

## Logger

`createWatukuy({ logger })` accepts any `{ debug, info, warn, error }(message, meta?)`. The default logs `warn` and `error` to the console and drops the rest. `silentLogger` drops everything; `childLogger(base, prefix, meta)` prefixes and merges metadata. `ctx.logger` in `fetch` and in handlers is already scoped to the poller and partition. Sensitive headers are redacted before they reach any log line (see [http-helper.md](./http-helper.md)).

Related: [runbook.md](./runbook.md), [how-it-works.md](./how-it-works.md).
