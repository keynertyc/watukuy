# Roadmap

Post-1.0 work, in rough priority order. Each item becomes a GitHub issue at launch; vote with a
thumbs-up. Items marked *design-ready* already have a design sketch in the linked issue.

## 1.x

- **Durable Object / KV store for Cloudflare** — run `tick()` from a Durable Object alarm with
  state in the same object. *design-ready* (the `StateStore` port is runtime-agnostic).
- **Bucketed (Merkle-style) snapshot hashing** — compare 256 bucket digests before loading item
  rows, for `snapshotDiff` over millions of items.
- **Parallel backfill sharding** — split a backfill range into time windows across instances.
- **Schema-drift diagnostics** — emit a diagnostic when new keys appear across N items.
- **Active windows / quiet hours** — cron-style windows in which a poller may run.
- **`watukuy.lag.seconds` OpenTelemetry observable** backed by `inspect()`.
- **`onCircuitProbe` hook** so half-open is reported explicitly.
- **Trace context propagation into handlers** (`onDeliverStart` hook + `ctx.traceparent`) so `watukuy.deliver` spans parent the consumer's work.

## Later

- MySQL, MongoDB, DynamoDB stores.
- GraphQL pagination helpers (`pageInfo.endCursor` / `hasNextPage` presets for the `token` strategy).
- Per-item payload compression for `retain: 'payload'`.
- Admin UI over `inspect()` and the parked/lanes operations.
- Webhook *receiving* with reconciliation against polling (for APIs that have unreliable webhooks).
- Consumer-side idempotency store helper (exactly-once at the consumer).
- Deno-native store adapters.
- MCP server exposing `inspect()` and operations to coding agents.

## Not planned

- Exactly-once delivery inside the engine (dedupe by `event.id` at the consumer instead).
- Cross-poller ordering.
