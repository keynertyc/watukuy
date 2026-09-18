# watukuy examples

Every example runs from a clean clone with no credentials:

```sh
pnpm install && pnpm build
pnpm --dir examples/<name> start
```

Each directory is a workspace package (`"watukuy": "workspace:*"`) with its own `README.md`
(what it shows, how to run it, what you will see). Node 24 runs the `.ts` files directly via
type stripping; the NestJS app is the one exception and compiles with `tsc` first. Long-running
examples accept `--duration <seconds>` and exit on their own; otherwise stop them with Ctrl+C.

| Example | Shows | Run |
|---|---|---|
| [legacy-orders](./legacy-orders/) | **The headline demo.** A fake legacy ERP over `node:http` (keyset paging, ETag/304, 429 + `Retry-After`, soft deletes) polled with a zod schema, timestamp cursor with tie-break and overlap, `ctx.http`, adaptive schedule, `retain: 'payload'` diffs, `SqliteStore` resume across restarts, graceful SIGINT. | `pnpm demo` (repo root) |
| [nestjs-app](./nestjs-app/) | NestJS 12: `WatukuyModule.forRootAsync`, `@OnWatukuyEvent` handler, Terminus `/health` with `WatukuyHealthIndicator`, `/inspect` and `POST /orders/trigger` controllers, same fake ERP in-process. | `pnpm --dir examples/nestjs-app start` |
| [cloudflare-worker-tick](./cloudflare-worker-tick/) | `engine.tick({ maxDuration: '25s' })` from a Workers cron trigger against jsonplaceholder (`page` cursor), `MemoryStore`, `wrangler dev --test-scheduled`. | `pnpm --dir examples/cloudflare-worker-tick start` |
| [multi-tenant](./multi-tenant/) | `partitions()` with three tenants, per-tenant cursor and lease, events tagged with `partition`, `pause`/`resume` of a single partition. `FakeApi` backend, real clock. | `pnpm --dir examples/multi-tenant start` |
| [webhook-sink](./webhook-sink/) | `webhookSink({ url, secret })` posting signed CloudEvents to a `node:http` receiver that verifies them with `verifyWebhookSignature`; simulated 503 shows dispatcher retries with the same `webhook-id`. | `pnpm --dir examples/webhook-sink start` |
| [bullmq-sink](./bullmq-sink/) | `bullmqSink(queue)` with a real BullMQ `Queue` + `Worker` (`jobId = event.id`). Needs Redis at `localhost:6379`; exits 0 with a hint when absent. | `pnpm --dir examples/bullmq-sink start` |

## Conventions

- Plain `console.log` with a `[prefix]` per component; no logging libraries.
- Comments explain *why* (which watukuy guarantee or option is at work), not what the line does.
- Type-check all examples together from the repo root: `pnpm typecheck` (the root
  `tsconfig.json` includes `examples/`). Lint/format: `pnpm exec biome check examples`.
- Data files written by the demos (`*.db`, `*.erp.json`, `dist/`) are git-ignored.
