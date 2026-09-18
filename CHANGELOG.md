# watukuy

## 1.0.0

### Major Changes

- 272cef0: Initial release: embeddable, zero-dependency change-data-capture engine for pull-only APIs.
  
  - `definePoller` / `createWatukuy` with full type inference (Standard Schema or `identity`).
  - Cursor strategies: `timestamp` (composite keyset, lag, overlap), `token`, `page`, `snapshotDiff`,
    `custom` (`customCursor()`).
  - Transactional outbox commit, fenced leases, per-key ordered delivery with concurrency, retries,
    poison parking (`park` / `halt`, `holdKey`), backpressured `subscribe()`.
  - Adaptive AIMD scheduler with proactive rate-limit pacing, `Retry-After`, backoff, circuit breaker.
  - Shared rate budgets (round-robin / weighted, lane priority), Redis-backed distributed budgets.
  - Partitions for multi-tenant pollers; backfill, reconcile, and replay lanes.
  - `tick()` serverless mode; core runs on Node, Bun, and Cloudflare Workers.
  - HTTP helper: ETag/304, IETF `RateLimit` headers, RFC 9457 problem details, budget charging.
  - Stores: Memory, SQLite (`node:sqlite`), Postgres (pg / PGlite), Redis (ioredis / node-redis).
  - Integrations: NestJS module + decorator + health indicator, OpenTelemetry hooks, CloudEvents,
    signed webhook sink (Standard Webhooks), BullMQ / SQS / Kafka sinks, CLI.
  - Testing utilities: `FakeApi`, `VirtualClock`, `SeededRandom`, `storeContractSuite`, `runChaos`.

### Patch Changes

- cf49089: `watukuy/testing` no longer imports `vitest`: the store contract suite lives only under
  `watukuy/testing/store-contract`. A build-time check now guards every entry point against
  importing another entry or vitest.

## 1.0.0-rc.1

### Patch Changes

- `watukuy/testing` no longer imports `vitest`: the store contract suite lives only under
  `watukuy/testing/store-contract`. A build-time check now guards every entry point against
  importing another entry or vitest.

## 1.0.0-rc.0

### Major Changes

- 8b557a0: Initial release: embeddable, zero-dependency change-data-capture engine for pull-only APIs.
  
  - `definePoller` / `createWatukuy` with full type inference (Standard Schema or `identity`).
  - Cursor strategies: `timestamp` (composite keyset, lag, overlap), `token`, `page`, `snapshotDiff`,
    `custom` (`customCursor()`).
  - Transactional outbox commit, fenced leases, per-key ordered delivery with concurrency, retries,
    poison parking (`park` / `halt`, `holdKey`), backpressured `subscribe()`.
  - Adaptive AIMD scheduler with proactive rate-limit pacing, `Retry-After`, backoff, circuit breaker.
  - Shared rate budgets (round-robin / weighted, lane priority), Redis-backed distributed budgets.
  - Partitions for multi-tenant pollers; backfill, reconcile, and replay lanes.
  - `tick()` serverless mode; core runs on Node, Bun, and Cloudflare Workers.
  - HTTP helper: ETag/304, IETF `RateLimit` headers, RFC 9457 problem details, budget charging.
  - Stores: Memory, SQLite (`node:sqlite`), Postgres (pg / PGlite), Redis (ioredis / node-redis).
  - Integrations: NestJS module + decorator + health indicator, OpenTelemetry hooks, CloudEvents,
    signed webhook sink (Standard Webhooks), BullMQ / SQS / Kafka sinks, CLI.
  - Testing utilities: `FakeApi`, `VirtualClock`, `SeededRandom`, `storeContractSuite`, `runChaos`.
