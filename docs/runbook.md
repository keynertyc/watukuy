# Runbook

Operating watukuy in production. Every operation here is available on the engine; the CLI (`npx watukuy ...`, shipping with the SQL stores) exposes the same operations against a store URL for use without the application process.

## Poll now

```ts
await engine.trigger('orders');                          // single-partition
await engine.trigger('invoices', { partition: 't_42' }); // partitioned
```

Marks the key due immediately and clears any `Retry-After` window. An open circuit stays open, so the forced run is a half-open probe: success closes it. In daemon mode the loop wakes at once; in tick mode the next `tick()` runs it.

## Pause and resume

```ts
await engine.pause('catalog');
await engine.resume('catalog');
```

Paused keys are skipped by the scheduler and by `tick()` (counted in `skippedNotDue`). Pending outbox rows are not delivered while paused. `resume()` marks the key due now. Both are unfenced writes: they work from any process, including one that does not hold the lease.

## Backfill

```ts
await engine.backfill('orders', { from: '2025-01-01T00:00:00Z' });             // to: live cursor at call time
await engine.backfill('orders', { from: null, to: '2025-06-30T23:59:59Z' });   // bounded window
await engine.backfill('orders', { from: null, force: true });                  // re-emit known items as updated
```

`from` and `to` are the API's own raw cursor strings (`null` = the beginning for timestamp/token, the initial cursor for page/custom). The lane runs under the same lease at lower budget priority than live, commits per page, tags events `lane: 'backfill'`, and skips identities already known at the same version unless `force`. Progress: `inspect().pollers[i].cursors.backfill`; completion: the state's `lanes.backfill.done`. Calling `backfill()` again replaces the lane's cursor and target. Not available for `snapshotDiff` pollers (throws `ConfigError`).

## Replay

```ts
const { replayed } = await engine.replay('orders', { from: '2026-09-01T00:00:00Z', to: new Date() });
```

Requires `log: { retention: '7d' }` on the poller; otherwise `ReplayUnavailableError`. Copies logged events in the time range back into the outbox with their **original ids**, a fresh `sequence`, and `lane: 'replay'`; they are delivered on the next drain. `from` / `to` accept ISO strings, epoch milliseconds, or `Date`. Replay acquires the key's lease briefly (retrying for a few seconds if another instance holds it).

## Reset the cursor

```ts
await engine.resetCursor('orders', { to: '2026-09-15T00:00:00Z' });              // rewind the live lane
await engine.resetCursor('orders', { to: null, clearSnapshot: true });           // start over completely
```

`to` is the raw cursor string or `null` for the strategy's initial cursor. Without `clearSnapshot` the re-poll re-observes items but the version map suppresses everything unchanged: you get only what actually differs. With `clearSnapshot: true` the item rows are dropped and everything is re-emitted as `created` **with the same ids** as the first time (G2), so an idempotent consumer is unaffected. The key is marked due now.

## Parked events

```ts
const poison  = await engine.parked.list('orders', { kind: 'poison' });
const invalid = await engine.parked.list('orders', { kind: 'invalid', limit: 100 });

await engine.parked.retry('orders', poison.map((p) => p.id));    // back to the outbox, holds released
await engine.parked.discard('orders', invalid.map((p) => p.id)); // drop
```

Triage a poison row: `row.error.message` and `row.error.stack` are the last failure, `row.error.history` the earlier ones, `row.attempts` the count, `row.event` the full event, `row.holdKey` the ordering key being held. Fix the handler (deploy) and `retry`; held events for that key then flow in order. Discard only when the event is genuinely unprocessable; the change is then lost to that consumer (a later `updated` for the same item will still arrive).

An `invalid` row carries the raw `item` and the validation `issues`. Fix the schema or the upstream record, then `discard`; the next cycle that includes the item re-validates it.

## Stuck lease

Symptom: `inspect()` shows a `lease` whose `owner` is an instance that no longer exists, `expiresAt` is in the past, and other instances report `skippedLeased`.

This resolves itself: `acquireLease` succeeds on an expired lease. `skippedLeased` is retried after `max(1s, ttl / 2)`. If it does not resolve, the clock of the instance that reports it is behind the one that wrote `expiresAt`; leases compare the store's `now` argument from the caller, so check NTP across instances. As a last resort, `engine.partitions.remove(name, partition)` deletes the key entirely (including its snapshot), which you do not want for a live poller; prefer waiting out the TTL.

Symptom: `onLeaseLost` firing regularly. The instance holds the lease longer than `lease.ttl` without renewing. Causes: a `fetch` page slower than the TTL (renewal happens after each committed page and on a `ttl / 3` heartbeat, so this needs a very slow API plus a blocked event loop), or a stopped-the-world process (GC pause, `SIGSTOP`, laptop sleep). Raise `lease.ttl` or lower `maxPagesPerCycle` / page size.

## Circuit open

Symptom: `schedule.circuit === 'open'`, `onCircuitOpen` fired, `schedule.lastError` set.

1. Read `lastError`. `HttpError` with `status` 5xx: the API is down; the probe every `circuit.probeEvery` (default `schedule.max`) will close the circuit when it recovers. A 4xx other than 429: your request is wrong (expired token, bad cursor format), fix and `trigger()`. `ConfigError` from the timestamp parser: the API changed its date format; set `cursor.parse`. `PoisonHalt`: a poison event with `action: 'halt'`; inspect `parked`, fix, `retry`, then `trigger()`.
2. `trigger()` forces a probe now instead of waiting.
3. Consecutive failures below `circuit.failures` show as `consecutiveFailures > 0` with `circuit: 'closed'`: backoff is in progress.

A `429` never opens the circuit. If a poller is permanently throttled, `schedule.throttledUntil` tells you until when, and `rateLimit` shows what the API advertised.

## Schema drift

You changed `fingerprint` (or the shape of the item the default fingerprint hashes). Every stored hash is now stale, and without intervention the next poll would emit `updated` for every item.

Procedure:

1. Bump `schemaVersion` in the same deploy as the fingerprint change.
2. Decide what consumers should see: `onSchemaChange: 'rebaseline'` (default) rewrites the stored hashes silently as items are re-observed, no events; `'emit'` emits `updated` for every item whose new hash differs from the stored one, once.
3. For incremental strategies, only items re-observed by the live lane are rebaselined; run a `reconcile` or a `backfill({ from: null })` to touch everything if the difference matters to you.

Event ids include `schemaVersion`, so post-bump events never collide with pre-bump ones.

Forgot to bump: the deploy produced a flood of `updated`. It is not a correctness problem (dedup is by id, and each id is a real observation), it is noise. Bump now to stop it repeating on the next full scan.

## Partition removed by mistake

The partition's state was paused, not deleted. Return it from `partitions()`, then `engine.resume(name, { partition })`. Everything continues from its last cursor.

## Graceful shutdown

```ts
process.on('SIGTERM', () => void engine.stop({ drain: true, timeout: '30s' }));
```

`drain: true` (default) waits for in-flight cycles and handlers up to `timeout`, then aborts what is left; aborted deliveries are not acked and are redelivered on the next run (G1). `drain: false` aborts immediately. After `stop()` the status is `'stopped'` and all timers are cleared.

## What to alert on

From `inspect()` (see [observability.md](./observability.md) for the full shape):

| Field | Condition | Page? |
|---|---|---|
| `schedule.circuit` | `open` for longer than `probeEvery` × 2 | yes |
| `lagMs` | above the freshness SLO for the poller | yes |
| `parked` | `> 0` | ticket |
| `outboxPending` | increasing across three consecutive checks | yes |
| `schedule.lastError` | non-null with `code: 'CONFIG'` | yes: no probe will fix it |
| `schedule.throttledUntil` | more than `schedule.max` in the future | ticket: the vendor asked for a long pause |
| `lease.expiresAt` | in the past while the report's `status` is `running` and `skippedLeased > 0` in ticks | ticket |

From hooks or `watukuy/otel`: `watukuy.events.parked`, `watukuy.circuit.opened`, `watukuy.lease.lost`, `watukuy.errors{phase}`, `watukuy.budget.wait` p99.

## CLI

`npx watukuy` mirrors the engine operations. Commands load the engine from a config module (`--config`, default `./watukuy.config.{ts,mts,js,mjs}`) that does `export default engine`, `export const engine = createWatukuy(...)`, or `export default { engine }`; written in TypeScript it runs directly on Node 22.18+ / 24.

```sh
npx watukuy inspect        --config ./watukuy.config.ts [--json]
npx watukuy tick           --config ./watukuy.config.ts --max-duration 50s     # one pass, then exit
npx watukuy run            --config ./watukuy.config.ts                        # daemon until SIGINT/SIGTERM
npx watukuy trigger        --poller orders [--partition t_42]
npx watukuy pause          --poller orders
npx watukuy resume         --poller orders
npx watukuy backfill       --poller orders --from null [--to <cursor>] [--force] [--partition t_42]
npx watukuy replay         --poller orders --from 2026-09-01T00:00:00Z [--to <iso|ms>]
npx watukuy reset-cursor   --poller orders --to null --clear-snapshot
npx watukuy parked ls      --poller orders [--kind poison|invalid]
npx watukuy parked retry   --poller orders --ids <id>,<id>
npx watukuy parked discard --poller orders --ids <id>
npx watukuy migrate        --store sqlite --path ./watukuy.db      # or --store postgres --url "$DATABASE_URL", or --config
```

`--json` switches every command to machine-readable output. Programmatic use: `import { runCli } from 'watukuy/cli'`.

Related: [observability.md](./observability.md), [delivery.md](./delivery.md), [cursors.md](./cursors.md).
