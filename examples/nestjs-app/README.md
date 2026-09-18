# nestjs-app

A NestJS 12 application using the `watukuy/nestjs` adapter:

- `WatukuyModule.forRootAsync()` builds the engine from an injected dependency (the fake ERP's
  URL) with a `SqliteStore`, so restarts resume from the saved cursor.
- `OrdersHandler`, a regular provider whose method is decorated with `@OnWatukuyEvent('orders')`.
- `GET /health`: `@nestjs/terminus` endpoint backed by `WatukuyHealthIndicator`.
- `GET /inspect`: `engine.inspect()` as JSON. `POST /orders/trigger`: poll now.
- The same fake legacy ERP as `examples/legacy-orders` (imported from `../legacy-orders/fake-erp.ts`
  and started in-process as a Nest provider), so no network and no credentials.

## Run

```sh
pnpm install && pnpm build          # once, at the repo root
pnpm --dir examples/nestjs-app start
```

`start` compiles with `tsc -p tsconfig.build.json` (decorators are not erasable syntax, so Node's
type stripping cannot run this one directly) and then runs `node dist/nestjs-app/src/main.js`.
`PORT` overrides 3000; `--duration <seconds>` closes the app after N seconds.

```sh
curl localhost:3000/health
curl localhost:3000/inspect
curl -X POST localhost:3000/orders/trigger
```

Ctrl+C triggers `app.enableShutdownHooks()` -> `beforeApplicationShutdown` ->
`engine.stop({ drain: true, timeout: '10s' })`, then the ERP provider closes.

## What you will see

Console:

```
[nest] http://localhost:3000  GET /health  GET /inspect  POST /orders/trigger
[orders] #1 created ord_0001 Umbrella open $775.00
[orders] #2 created ord_0002 Globex open $697.69
...
[orders] #120 created ord_0120 Hooli open $606.03
[orders] #122 updated ord_0074 status open -> paid
[orders] #123 updated ord_0051 status open -> paid
[orders] #124 created ord_0121 Initech open $231.90
```

`GET /health`:

```json
{
  "status": "ok",
  "info": {
    "watukuy": {
      "status": "up",
      "engineStatus": "running",
      "instanceId": "watukuy-fri0kcjfzy",
      "mode": "daemon",
      "pollers": [
        { "poller": "orders", "partition": "", "paused": false, "circuit": "closed",
          "lagMs": 1609, "outboxPending": 0, "parked": 0, "leaseOwner": null }
      ],
      "reasons": []
    }
  },
  "error": {},
  "details": { "watukuy": { "...": "same as info" } }
}
```

The indicator reports `down` (HTTP 503 from terminus) when a circuit is open, when the engine is
not running in daemon mode, or when `lagMs` exceeds the `maxLagMs` passed in
`health.controller.ts` (60s here; the ERP changes every 2s so the lag stays around 1-2s).

`GET /inspect` (trimmed):

```json
{
  "status": "running",
  "pollers": [{
    "poller": "orders",
    "cursors": { "live": { "value": "2026-09-18T19:31:41.502Z", "tieBreak": "ord_0074" } },
    "schedule": { "intervalMs": 1000, "circuit": "closed", "lastPoll": { "items": 2, "events": { "created": 0, "updated": 1, "deleted": 0 } } },
    "outboxPending": 0, "parked": 0, "items": 120, "lagMs": 1627
  }]
}
```

## Layout

```
src/main.ts                bootstrap, enableShutdownHooks, --duration
src/app.module.ts          WatukuyModule.forRootAsync + TerminusModule + controllers
src/erp.module.ts          starts the fake ERP as a global provider (FAKE_ERP)
src/orders.poller.ts       definePoller (zod schema, timestamp cursor, ctx.http)
src/orders.handler.ts      @OnWatukuyEvent('orders')
src/health.controller.ts   /health with WatukuyHealthIndicator
src/inspect.controller.ts  /inspect, POST /orders/trigger (engine injected via WATUKUY_ENGINE)
tsconfig.build.json        emits ESM to dist/ (rootDir is examples/ because fake-erp.ts is shared)
```

## Notes

- `WatukuyModule` does not run store migrations; the `useFactory` calls `store.migrate()` before
  returning the options (idempotent).
- `WatukuyHealthIndicator` is not registered by `WatukuyModule` because terminus is an optional
  peer: it is listed in `AppModule.providers`.
- Interfaces are imported with `import type`; with `emitDecoratorMetadata` that is fine because
  interface-typed parameters emit `Object`. Classes used as injection tokens
  (`HealthCheckService`, `WatukuyHealthIndicator`) are value imports.
- Data files (`nestjs-orders.db`, `nestjs-orders.erp.json`) are written to the working
  directory, i.e. `examples/nestjs-app/` when started with `pnpm --dir` or `pnpm start`.
