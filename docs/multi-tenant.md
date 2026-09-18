# Multi-tenant pollers with partitions

One connector, N customer accounts. That is the dominant shape of real integrations, so partitions are a first-class concept and the store key is `(poller, partition)` everywhere.

## Declaring partitions

```ts
import { definePoller } from 'watukuy';

interface Tenant { id: string; slug: string; token: string }
interface Invoice { id: string; etag: string; customerId: string }

export const invoices = definePoller({
  name: 'invoices',
  partitions: async () => (await db.tenants()).map((t) => ({ key: t.id, data: t })),
  partitionsRefresh: '5m',                      // default
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
    return { items: body.data, cursor: body.next };
  },
  schedule: { min: '30s', max: '15m' },
  budget: 'vendor',
});
```

`partitions` returns `Partition<Data>[]`, synchronously or as a promise. Each `key` must be a non-empty string and unique within the poller; a `ConfigError` is thrown otherwise. `Data` is inferred and flows into `fetch` as `partition.data` (and into the handler context as `ctx.partition`). It is **never persisted**: credentials, base URLs, and slugs can live there safely and change between refreshes.

Without `partitions`, the poller has one partition with key `''`.

## What is per partition, what is shared

| Per `(poller, partition)` | Shared by all partitions of a poller |
|---|---|
| live / backfill / reconcile cursors | the definition (`identity`, `version`, `fingerprint`, `cursor`, `fetch`) |
| lease and fencing epoch | the handler or `subscribe()` iterator |
| schedule: interval, next due, throttle window | the rate budget (fairness is computed across `${poller}/${partition}` requesters) |
| circuit breaker | `schemaVersion` and `retain` |
| outbox and `sequence` counter | hooks and logger |
| parked events (poison and invalid) | |
| HTTP validators (ETag / Last-Modified) | |
| item snapshot | |

Consequences: a tenant whose API is down opens only that tenant's circuit; a tenant with a poison event holds only that tenant's ordering key; a tenant's `lag` is its own. Events carry `partition` and the event id includes it, so two tenants seeing an identically-versioned item with the same identity produce different ids.

## Refresh, add, remove

`partitions()` is re-evaluated when `partitionsRefresh` (default `5m`) has elapsed, at the start of a daemon loop iteration or a `tick()`, and on demand with `engine.partitions.list(name)`. If it throws, the error is logged and the previous list is kept.

- **Added** partitions are due immediately with a fresh state (`initial` cursor, `schedule.min`).
- **Removed** partitions are **paused, not deleted**: the state row gets `paused: true` through an unfenced write, and it disappears from `inspect()` and from scheduling. Its cursor, snapshot, outbox, and parked rows stay in the store. If the tenant comes back, `partitions()` returns it, and `resume()` (or simply the refresh marking it due) continues from where it left off.
- **Deleting** is explicit: `await engine.partitions.remove('invoices', 't_42')` removes every row for the key (state, lease, items, outbox, parked, validators, log). Use it when a tenant churns for good.

```ts
const current = await engine.partitions.list('invoices');   // forces a refresh, returns the list
await engine.partitions.remove('invoices', 't_42');
```

## Per-partition operations

Every operation on a partitioned poller takes `{ partition }`; omitting it throws a `ConfigError` (`poller 'invoices' is partitioned; pass { partition }`).

```ts
await engine.trigger('invoices', { partition: 't_42' });
await engine.pause('invoices', { partition: 't_42' });
await engine.resume('invoices', { partition: 't_42' });
await engine.backfill('invoices', { from: null, partition: 't_42' });
await engine.replay('invoices', { from: '2026-09-01T00:00:00Z', partition: 't_42' });
await engine.resetCursor('invoices', { partition: 't_42', to: null, clearSnapshot: true });

const parked = await engine.parked.list('invoices', { partition: 't_42', kind: 'poison' });
await engine.parked.retry('invoices', parked.map((p) => p.id), { partition: 't_42' });
```

`inspect()` returns one `PollerInspect` per active partition, so a `/healthz` can report per-tenant lag, circuit state, and parked counts.

## Budgets across tenants

A budget is named per poller, not per partition. When two hundred tenants share `budget: 'vendor'`, the token bucket is one bucket and the fairness rule decides who goes next: `'round-robin'` (default) serves the requester served least recently, `'weighted'` uses each poller's `budgetWeight`. Lane priority applies first: a tenant's live poll beats another tenant's backfill.

If the vendor enforces a **per-tenant** quota instead, do not use a shared budget; rely on the per-partition scheduler, which reads each tenant's own `RateLimit` headers and `Retry-After` and paces that partition independently.

## Handler ergonomics

```ts
engine.on('invoices', async (event, ctx) => {
  const tenant = ctx.partition.data as Tenant;          // the same object fetch() saw
  await warehouse.upsert(tenant.id, event.subject, event.data);
});
```

`event.partition` is the key; `ctx.partition` is the full `Partition` including `data`. Prefer `event.partition` for anything you persist, since `data` is transient.

## Scale notes

- A `tick()` runs up to four keys concurrently; a daemon runs every due key concurrently. Two hundred tenants at `min: '30s'` with 200ms pages is comfortable on one instance. Beyond that, add replicas: leases distribute keys automatically.
- Each partition costs one `loadState` and one `countPending` per scheduler pass even when idle. With thousands of tenants prefer longer `schedule.max` and let AIMD find the idle ones.
- Partition keys appear in metric attributes (`watukuy.partition`); with very high cardinality consider disabling `watukuy/otel` per-partition metrics at the collector.

Related: [how-it-works.md](./how-it-works.md), [runbook.md](./runbook.md), [observability.md](./observability.md).
