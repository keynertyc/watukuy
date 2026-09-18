# Comparison

The summary table from the README, then the honest version: where each neighbor is the better choice and what watukuy costs you.

| | cron / `@nestjs/schedule` / BullMQ | Nango / Airbyte | Hookdeck / Svix | Inngest / Temporal / Trigger.dev | **watukuy** |
|---|---|---|---|---|---|
| What it is | scheduler | integration platform | webhook infra | durable execution | embeddable sync engine |
| Cursors, diffing, dedup, deletes | you build it | yes | n/a | you build it | **yes** |
| Runs inside your app process | yes | no | no | partially | **yes** |
| Data stays in your own store | yes | platform DB | SaaS | mixed | **yes** |
| Zero runtime dependencies | yes | no | no | no | **yes (core)** |
| Serverless one-shot mode | n/a | no | n/a | yes | **yes (`tick()`)** |
| Multi-instance safety | you build it | yes | n/a | yes | **yes (fenced leases)** |
| Typed end-to-end | partially | no | no | yes | **yes** |

## Schedulers: cron, `@nestjs/schedule`, BullMQ repeatables

They fire a function on a cadence. Everything about *what changed* is on you: the cursor and its edge cases (ties, late commits, crashes between "fetched" and "saved"), dedup, deletes, retries, `429` handling, and the fact that two replicas will both fire.

**Choose a scheduler when** the job is not a sync: a nightly report, a cache warm-up, a cleanup. Or when the API pushes a full, small dataset and you genuinely do not care which rows changed.

**watukuy costs you** a store (SQLite is enough for one node) and learning a definition format. In exchange, the seven bugs every hand-rolled poller ships with are already fixed and tested. You keep your scheduler for the things that are not syncs, and you can still call `engine.tick()` from it.

## Integration platforms: Nango, Airbyte

They do solve polling syncs, with connectors, OAuth handling, added/updated/deleted records, a UI, and a team maintaining vendor quirks. They are platforms: a service (or several) you deploy and operate, with their own database, and often with the fully self-hosted path behind an enterprise plan.

**Choose a platform when** you integrate dozens of well-known SaaS APIs, want prebuilt connectors and OAuth, and are fine running or paying for the platform. Airbyte in particular targets analytics loads into a warehouse.

**watukuy costs you** the connectors: you write `fetch` and `identity` for each API. In exchange it runs inside your process, keeps state in your database, has no external service to operate, and gives you per-record semantics (ordering keys, event ids, poison parking) that batch sync tools do not expose. Internal APIs owned by another team, on-prem ERPs, and government registries have no connectors anywhere; watukuy is for those.

## Webhook infrastructure: Hookdeck, Svix

They receive webhooks (queueing, retries, fan-out, dashboards) or send them (signing, retries, endpoint management). Neither creates webhooks from a source that does not emit them.

**Choose them when** the source already sends webhooks and you need reliability on the receiving side, or when you are a platform sending webhooks to many customers and want a hosted delivery service.

**watukuy is upstream of them.** `webhookSink` re-emits changes as Standard Webhooks with CloudEvents bodies, so a polled API can feed the same receiving pipeline as a native one. If you need hosted delivery to thousands of endpoints, point `webhookSink` at Svix's ingest or Hookdeck's source URL.

## Durable execution: Inngest, Temporal, Trigger.dev

They make *what to do* reliable: retries, sleeps, fan-out, human-in-the-loop, all with durable state. Their scheduled functions fire on a cadence like cron; detecting what changed is still your code.

**Choose them when** the work per event is a multi-step workflow. They are excellent at that, and they are the natural consumer of watukuy events: `engine.on('orders', (e) => inngest.send({ name: 'erp/order.changed', id: e.id, data: e }))`.

**watukuy costs you** another component. It gives you the change detection those engines do not do, with the guarantees (composite keyset cursor, atomic outbox, per-key ordering, deterministic ids) that a scheduled step calling `fetch` does not have. Inside a durable step, `engine.tick()` works as well: the state is in your store, not in the step's memory.

## Hand-rolled in-house poller

The real competitor. It is usually 200 lines, took a week, and works.

What it tends to be missing, in the order teams discover it: timestamp ties at page boundaries (skipped rows), late commits (skipped rows), crash between "fetched" and "cursor saved" (lost or duplicated events), deletes (never detected), `429` handled by retrying immediately (bans), two replicas polling twice (double delivery, double quota), one bad record stopping all tenants, no way to backfill or replay, no way to see the cursor. watukuy is the sum of those fixes, with a chaos suite that kills the process at every store boundary to prove it.

**Keep the hand-rolled poller when** it is one API, one instance, no deletes, and it has been fine for a year. Rewriting working code has a cost too.

## What watukuy is not

- Not a connector catalog. You bring `fetch`.
- Not a queue or a workflow engine. It emits; something else processes.
- Not exactly-once. At-least-once with deterministic ids; dedup is one line at the consumer.
- Not a webhook receiver (yet; reconciliation of received webhooks against polling is on the roadmap).
- Not a database-level CDC tool like Debezium. It reads APIs, not transaction logs.

Related: [guarantees.md](./guarantees.md), [faq.md](./faq.md).
