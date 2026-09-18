# FAQ

### Is delivery exactly-once?

No. At-least-once, with deterministic ids (`event.id`), so dedup at the consumer is one line: a queue job id, a unique column, or a version compare. See [delivery.md](./delivery.md#dedup-at-the-consumer).

### Why did I get the same event twice?

A crash or lease loss after the handler ran but before the ack was stored, a `stop({ drain: false })`, or a `subscribe()` loop that threw. Both copies have the same `event.id`. If you see two events with different ids for the same item, they are two distinct observations (two different versions).

### Why did I get no `deleted` events?

Incremental strategies (`timestamp`, `token`, `page`, `custom`) cannot see what disappeared. Add `reconcile: { every, fetch }` or use `snapshotDiff`. If you use `snapshotDiff` and still see none, check that the full listing fits in `maxPagesPerCycle` (a truncated scan emits no deletes) and that the API is not answering `304`.

### Why does `event.data` come back `undefined`?

It is a `deleted` event and the poller has `retain: 'hash'` (the default). Set `retain: 'payload'` to get the last known payload on deletes and `previous` on updates.

### The first poll emitted thousands of `created` events. Can I skip them?

Set `cursor.initial` to "now" for `timestamp` pollers so the live lane starts from the present, then `backfill()` history at your own pace if you need it. For `snapshotDiff`, the first scan necessarily creates everything; consumers can ignore `created` events until a marker time if they only want changes from now on.

### Every item came back as `updated` after a deploy. Why?

You changed `fingerprint` (or the item shape the default fingerprint hashes) without bumping `schemaVersion`. Bump it; `onSchemaChange: 'rebaseline'` (default) then rewrites the hashes silently. See [runbook.md](./runbook.md#schema-drift).

### What happens if my handler is slow?

The poller keeps polling; the outbox fills; `inspect().pollers[i].outboxPending` grows; `delivery.concurrency` bounds how many handlers run at once. Raise `concurrency`, or hand off to a queue in the handler and let the queue absorb the load.

### What happens if the handler is not registered yet?

Events are committed to the outbox and a warning is logged once. They are delivered on the next drain after `on()` or `subscribe()` is attached. Nothing is lost. In `tick()` mode, attach before ticking.

### Can I run several instances?

Yes. One store, N processes. Leases with fencing epochs ensure one active poller per `(poller, partition)`; the others report `skippedLeased`. Use Postgres or Redis for cross-host deployments; SQLite is for a single host.

### Can several pollers share one rate limit?

Yes: declare a budget in `createWatukuy({ budgets: { erp: { requests: 100, per: '1m' } } })` and set `budget: 'erp'` on each poller. Lane priority (live > reconcile > backfill > replay) and round-robin or weighted fairness apply. For a limit shared across processes, pass a Redis `budgetStore`.

### How do I poll one API for many customers?

`partitions()` returning one entry per tenant. Each gets its own cursor, lease, schedule, circuit, and outbox. See [multi-tenant.md](./multi-tenant.md).

### Does it retry HTTP requests?

The HTTP helper never retries. The scheduler does: exponential backoff with full jitter, exact `Retry-After` sleeps on `429`, and a circuit breaker after `circuit.failures` consecutive failures. Two retry layers cause storms.

### Why is the interval growing?

AIMD: idle cycles (no events, or `304`) multiply the interval by 1.5 up to `schedule.max`; cycles with events halve it down to `schedule.min`. `onScheduleChange` reports the `reason`. Set `adaptive: false` to pin the interval at `min`.

### Can I use it without `ctx.http`?

Yes. Call `fetch` or an SDK inside your `fetch` function and return `{ items }`. You lose ETag/304 handling, proactive rate-limit pacing, and budget charging. Throw on errors so the scheduler backs off.

### Does it work on Cloudflare Workers, Bun, Deno?

The core uses only WinterTC APIs and is tested on Node and Bun; `workerd` runs it with `MemoryStore` or `PostgresStore` over Hyperdrive. `SqliteStore` needs `node:sqlite`. A Durable Object store is on the roadmap.

### Is it ESM-only? I am on CommonJS.

Yes, ESM-only. On Node 22.12+ `require('watukuy')` works through `require(esm)`. There is no dual build, by design.

### Which store should I pick?

SQLite for one node, Postgres for many, Redis when you also need a distributed rate budget. `MemoryStore` for tests. See [stores.md](./stores.md).

### How big can a `snapshotDiff` dataset be?

Memory per cycle is one page plus a `Set` of identity strings; the snapshot lives in the store. A million items is fine on SQLite or Postgres. The constraint is API quota (you list everything every cycle) and `maxPagesPerCycle`. Bucketed hashing for very large datasets is on the roadmap.

### Can I change a poller's `name`?

The name is the store key. Renaming starts from scratch (new cursor, new snapshot, all `created` again with new ids because `source` changes). Keep names stable; use `source` if you only need a different event `source` URI.

### Are event ids stable across watukuy versions?

The id material is versioned (`watukuy|v1|...`). A change to the layout would use a new prefix and be a major version.

### Where are the CloudEvents?

`toCloudEvent(event)` converts the native envelope losslessly; the webhook sink sends that format by default. The native envelope stays because `specversion` and `datacontenttype` are poor everyday ergonomics.

### How do I test a poller?

`watukuy/testing`: `VirtualClock`, `SeededRandom`, `FakeApi` (with `fetchImpl()` for the HTTP path). No sleeps, no network. See the README's "Testing your pollers" and `test/integration/` in the repository.

### How do I report a security issue?

Privately, through GitHub's vulnerability reporting on the repository. See [stability.md](./stability.md#security).
