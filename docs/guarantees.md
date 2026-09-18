# Guarantees

These ten promises are the contract. Each one says what it means when you build on it, and which tests hold it in place. If you find a way to break one, that is a bug, not a caveat.

## G1. At-least-once delivery

**Promise.** Once an item change is observed, its event is delivered to the handler at least once. Never at-most-once.

**In practice.** Your handler may see the same event twice: after a crash between commit and ack, after a lease loss mid-dispatch, or after a `stop({ drain: false })`. It will never see a change zero times. Design handlers to be idempotent, and dedup by `event.id` (G2) where that matters.

**How it is tested.** `test/integration/lifecycle.test.ts` wraps the store so `commitPoll` succeeds and then the process "crashes"; a fresh engine on the same store delivers every event. The chaos suite asserts that every mutation applied to the `FakeApi` has at least one delivered event across all kill points.

## G2. Deterministic event ids

**Promise.** The same observation produces the same `event.id` across restarts, instances, and replays, so consumers dedup by id.

**In practice.** `event.id` is the SHA-256 (hex) of `watukuy|v1|<source>|<partition>|<identity>|<version-or-hash>|<schemaVersion>|<type>`, with `|` and `\` escaped inside parts. Two engines observing the same version of the same item produce byte-identical ids. Replay re-emits with the original id. `resetCursor` followed by a re-poll produces the same ids as the first pass. Use the id as a queue job id, an SQS dedup id, a Kafka message key, or a unique column.

**How it is tested.** Two independent worlds produce identical id lists; replay ids equal the originals; `resetCursor({ clearSnapshot: true })` re-creates with the same ids. Unit tests in `src/diff` pin the id material and escaping.

## G3. Ordering per key

**Promise.** Events with the same ordering key (default: item identity) within one poller partition are delivered in observation order. No ordering across keys.

**In practice.** `created`, then `updated`, then `deleted` for one item arrive in that order, even with `delivery.concurrency: 32`, even when a retry is in progress for that key, even after a park with `holdKey: true`. Nothing is promised about the relative order of two different items, or of two partitions, or of two pollers.

**How it is tested.** The `holdKey` test parks a `created`, then commits an `updated` for the same key, and shows the `updated` waits until the parked event is retried, then both arrive in order. The chaos suite checks per-key order for every seed.

## G4. Atomic commit

**Promise.** The new cursor, the snapshot delta, and the pending events of a poll are committed in a single store transaction (the outbox). There is no window where the cursor advanced but events were lost.

**In practice.** You never need a "re-fetch on crash" strategy, and you never see a cursor that skipped past changes it did not record. Stores that cannot offer this (a hypothetical eventually-consistent key-value store) cannot be watukuy stores.

**How it is tested.** The store contract suite runs `commitPoll` atomicity and fencing checks against every built-in store. The chaos suite's `FaultyStore` makes `commitPoll` fail (`after-fetch`) and verifies nothing was persisted, and checks after every run that no delivered event lacks a matching cursor advance.

## G5. Single active poller

**Promise.** One active poller per `(poller, partition)` across all instances, via leases with fencing epochs. A stale lease holder cannot write.

**In practice.** Deploy three replicas with the same store and the API sees one poller. A replica paused by GC for a minute wakes up, tries to write with epoch 7 while epoch 8 is current, receives `LeaseLostError`, drops its work, and fires `onLeaseLost`. The default TTL is `30s`, renewed every `ttl / 3` and after every committed page.

**How it is tested.** Two engines on one store: the second reports `skippedLeased` and receives no events. A direct store test acquires with owner A, lets the lease expire, acquires with owner B, and shows A's write is rejected.

## G6. Rate budgets are never exceeded

**Promise.** Budgets are never exceeded by this process. With a Redis-backed budget, never exceeded across instances.

**In practice.** `budgets: { erp: { requests: 100, per: '1m' } }` is a hard cap for every poller and partition that declares `budget: 'erp'`, across all lanes. The HTTP helper charges before sending. If tokens run out, the cycle waits up to `maxWait` (default: the poller's `schedule.max`) and fires `onBudgetWait`; after that it defers with `BudgetTimeoutError`. For several processes, pass a `budgetStore` backed by Redis.

**How it is tested.** Two pollers share a `2 per 10s` budget and need six requests; the tick blocks until virtual time releases tokens and exactly six calls are made. Unit tests cover burst, refill, round-robin and weighted fairness, and lane priority.

## G7. Isolation of failures

**Promise.** A failing handler never blocks other ordering keys. Poison events park with full context and can be retried or discarded.

**In practice.** One customer's malformed record does not stop the other ten thousand. After `retry.attempts` the event lands in the parked table with the error, stack, and attempt history; `engine.parked.list()` shows it, `retry()` puts it back, `discard()` drops it. Only that ordering key is held (and only when `holdKey: true`).

**How it is tested.** A handler that throws for one item: the other items are delivered on the first tick, the poison is parked after three attempts with `attempts: 3` and `holdKey` set to the identity, and `inspect()` shows `parked: 1`, `outboxPending: 0`.

## G8. Deterministic under test

**Promise.** Clock and randomness are injectable. The test suite has zero real sleeps and zero network.

**In practice.** `createWatukuy({ clock: new VirtualClock(), random: new SeededRandom(7) })` makes every backoff, jitter, lease expiry, and AIMD step reproducible. `FakeApi` stands in for the vendor. A flaky poller test is a bug in the poller, not in the clock.

**How it is tested.** Every integration test in the repository uses `VirtualClock` and `SeededRandom`; a test asserts `pendingTimers() === 0` after `stop()`.

## G9. Crash-safe at every kill point

**Promise.** Killing the process at any store boundary recovers via the outbox. Proven by the seeded chaos suite.

**In practice.** Kill points K1..K7 (see [how-it-works.md](./how-it-works.md#kill-points)) plus failures inside store transactions are all recoverable without operator action. Recovery costs at most one duplicate delivery per in-flight event.

**How it is tested.** `runChaos({ seed, killPoints: 'all', steps })` from `watukuy/testing` drives the engine with seeded `FakeApi` mutations, arms a random kill point each step (`before-acquire`, `after-fetch`, `after-commit`, `mid-dispatch`, `before-ack`, `after-ack-before-schedule`, `during-release`, plus a throwing `handler`), drops the engine without `stop()` when a store-level kill fires, lets the lease expire, and continues with a fresh instance on the same store. After quiescence, `assertChaosReport` checks convergence (G1), duplicate ids (G2), per-key order (G3), an empty outbox and nothing parked (G4, G7), and lease exclusivity (G5). One seed per PR, fifty nightly; failing seeds become regression tests.

## G10. Bounded memory

**Promise.** Handler concurrency and iterator backpressure bound in-flight work. Pages are staged, not accumulated, except in `snapshotDiff`, which documents its memory profile.

**In practice.** The dispatcher loads `dispatchBatchSize` rows (default 100) at a time and runs at most `delivery.concurrency` handlers. `subscribe()` does not pull the next slice until you ask for the next event. Incremental strategies hold one page in memory. `snapshotDiff` and `reconcile` hold a `Set` of identities seen this cycle (strings only, no payloads) plus one page; with `retain: 'payload'` each stored row also carries the last payload in the store, not in memory.

**How it is tested.** `subscribe()` acks on `next()` and leaves the outbox empty only after the consumer pulled everything. The store contract suite exercises `streamIdentities` in batches on every store.

## Explicit non-guarantees

- **Exactly-once.** Not offered. Dedup by `event.id` at the consumer. A consumer-side idempotency helper is on the roadmap.
- **Ordering across pollers or partitions.** None. Two tenants' events interleave arbitrarily.
- **Intermediate states.** If an item goes A → B → A between two polls, you see nothing. If it goes A → B → C you see one `updated` with `data: C` (and `previous: A` with `retain: 'payload'`). This is standard CDC compaction.
- **Deletes on incremental strategies without reconcile.** `timestamp`, `token`, `page`, and `custom` cannot know an item disappeared. Configure `reconcile` or use `snapshotDiff`.
- **Deletes from a truncated full scan.** If `maxPagesPerCycle` or a `tick()` deadline cuts a `snapshotDiff` or reconcile listing short, that cycle emits no `deleted` events. Size `maxPagesPerCycle` to cover the full listing.
- **Delivery to a handler that is not attached.** Events accumulate in the outbox (with a warning) until `on()` or `subscribe()` is called. In `tick()` mode, attach before ticking.

Related: [how-it-works.md](./how-it-works.md), [delivery.md](./delivery.md).
