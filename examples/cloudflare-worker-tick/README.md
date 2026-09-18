# cloudflare-worker-tick

`engine.tick()` on a Cloudflare Workers cron trigger. There is no long-running process: each
invocation runs one bounded pass over the pollers that are due, drains the outbox, persists the
schedule and returns. Cursors, intervals and the outbox live in the store, so many short-lived
invocations behave like one daemon.

The poller reads `https://jsonplaceholder.typicode.com/posts` (public, no credentials) with
the `page` cursor strategy and `_page` / `_limit` query parameters. Its data never changes, so
the first tick emits 100 `created` events and later ticks emit nothing: the diff engine at work.

## Run

```sh
pnpm install && pnpm build          # once, at the repo root
pnpm --dir examples/cloudflare-worker-tick start     # wrangler dev --test-scheduled
```

In another terminal:

```sh
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"    # fire the cron handler by hand
curl  http://localhost:8787/                               # engine.inspect() as JSON
```

`--test-scheduled` exposes the `/__scheduled` endpoint; in production the `triggers.crons`
entry in `wrangler.jsonc` (`*/5 * * * *`) fires it. Deploy with `pnpm --dir examples/cloudflare-worker-tick deploy`.

## What you will see

First `/__scheduled` (wrangler terminal):

```
[posts] created #1 "sunt aut facere repellat provident occa"
[posts] created #2 "qui est esse"
...
[posts] created #100 "at nam consequatur ea labore ea harum"
[tick] cron="* * * * *" polled=1 events=100 skippedNotDue=0 timedOut=false 1792ms
```

Second `/__scheduled` within a minute (the poller is not due yet; `schedule.min` is `'1m'`):

```
[tick] cron="* * * * *" polled=0 events=0 skippedNotDue=1 timedOut=false 0ms
```

`GET /` (trimmed):

```json
{
  "status": "idle",
  "pollers": [{
    "poller": "posts",
    "cursors": { "live": { "page": 1 } },
    "schedule": {
      "intervalMs": 60000,
      "circuit": "closed",
      "rateLimit": { "source": "vendor", "limit": 1000, "remaining": 994 },
      "lastPoll": { "pages": 6, "items": 100, "events": { "created": 100, "updated": 0, "deleted": 0 } }
    },
    "items": 100
  }]
}
```

Note `rateLimit`: the HTTP helper parsed jsonplaceholder's `X-RateLimit-*` headers and the
scheduler will pace itself if `remaining` gets low.

## Store

`MemoryStore` is a demo choice. It lives as long as the isolate, so warm invocations reuse it,
but every cold start starts over and re-emits the full list as `created`. For real deployments
use `PostgresStore` over Hyperdrive or `RedisStore` (see `docs/serverless.md`). A Durable
Object store is on the roadmap (`ROADMAP.md`).

## Notes

- `maxDuration: '25s'` keeps the tick under the Workers cron CPU budget; a truncated cycle is
  marked due again and resumes from the last committed page on the next invocation.
- Handlers are registered at module scope, before any `tick()`. Events without a consumer stay
  in the outbox and are delivered on a later tick.
- `nodejs_compat` is not needed by watukuy's core (WinterTC APIs only); it is enabled for
  parity with deployments that add `pg` or a Redis client.
- Types come from `@cloudflare/workers-types` as a module import, so the example also
  typechecks under the repository's root `tsconfig.json` (which uses `@types/node`).
