# NestJS adapter (`watukuy/nestjs`)

A thin module over the core API: it creates the engine as a provider, wires `@OnWatukuyEvent` methods as handlers at bootstrap, starts and stops the engine with the application, and offers a Terminus health indicator built on `inspect()`. Built against NestJS 12, peer range `@nestjs/common >=11 <13`.

## Install

```sh
npm install watukuy @nestjs/common @nestjs/core reflect-metadata
npm install @nestjs/terminus   # optional, for the health indicator
```

watukuy is ESM-only. NestJS 12 is pure ESM and imports it directly. A NestJS 11 app compiled to CommonJS uses `require(esm)`, which is native on Node 22.12+; no extra configuration is needed.

## Register the module

```ts
import { Module } from '@nestjs/common';
import { WatukuyModule } from 'watukuy/nestjs';
import { SqliteStore } from 'watukuy/store-sqlite';
import { orders } from './orders.poller.ts';

@Module({
  imports: [
    WatukuyModule.forRoot({
      store: new SqliteStore({ path: './watukuy.db' }),
      budgets: { erp: { requests: 100, per: '1m' } },
      pollers: { orders },            // or an array: [orders]
    }),
  ],
})
export class AppModule {}
```

`WatukuyModuleOptions` is `EngineOptions` (see [api.md](./api.md)) with three additions:

| Option | Default | Meaning |
|---|---|---|
| `pollers` | none | `definePoller()` results as an array or a name-keyed object. Feature modules may contribute more; all contributions are merged. |
| `mode` | `'daemon'` | `'daemon'` calls `engine.start()` at `onApplicationBootstrap` and `engine.stop()` at `beforeApplicationShutdown`. `'manual'` only creates the engine; call `engine.tick()` yourself. |
| `stop` | `{ drain: true, timeout: '30s' }` | Passed to `engine.stop()` on shutdown. |

`forRoot` also takes `isGlobal` (default `true`) so `WATUKUY_ENGINE` is injectable from any module. The module does **not** run `store.migrate()` for you; call it where you build the store.

For options that depend on other providers:

```ts
WatukuyModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => {
    const store = new PostgresStore({ client: new pg.Pool({ connectionString: config.getOrThrow('DATABASE_URL') }) });
    await store.migrate();
    return { store, pollers: [orders], instanceId: config.get('HOSTNAME'), stop: { drain: true, timeout: '20s' } };
  },
});
```

Feature modules add pollers with `WatukuyModule.forFeature([invoices])`; the root module merges them into one engine.

## Handle events

```ts
import { Injectable } from '@nestjs/common';
import type { HandlerContext, WatukuyEvent } from 'watukuy';
import { OnWatukuyEvent } from 'watukuy/nestjs';
import type { Order } from './orders.poller.ts';

@Injectable()
export class OrdersHandler {
  constructor(private readonly queue: OrdersQueue) {}

  @OnWatukuyEvent('orders')
  async onOrder(event: WatukuyEvent<Order>, ctx: HandlerContext): Promise<void> {
    ctx.logger.info('order changed', { type: event.type, id: event.subject });
    await this.queue.add('order-sync', event, { jobId: event.id });
  }
}
```

At `onApplicationBootstrap` the explorer scans providers and controllers for `@OnWatukuyEvent(name)` methods and registers each with `engine.on(name, method.bind(instance))`, then (in daemon mode) calls `engine.start()`. One handler per poller: two decorated methods for the same poller, or a name no registered poller has, fail the bootstrap with a `ConfigError`. The host class must be a singleton provider (the default scope); request- and transient-scoped classes are rejected because there is no instance to bind at bootstrap.

## Inject the engine

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Engine, PollerMap } from 'watukuy';
import { InjectWatukuy, WATUKUY_ENGINE } from 'watukuy/nestjs';

@Injectable()
export class SyncAdminService {
  constructor(@Inject(WATUKUY_ENGINE) private readonly engine: Engine<PollerMap>) {}
  // or the shorthand: constructor(@InjectWatukuy() private readonly engine: Engine<PollerMap>) {}

  pollNow(name: string) { return this.engine.trigger(name); }
  status() { return this.engine.inspect(); }
  parked(name: string) { return this.engine.parked.list(name); }
}
```

The engine is an ordinary provider under the `WATUKUY_ENGINE` token (`Symbol.for('watukuy:engine')`), so controllers can expose operations (`trigger`, `pause`, `backfill`, `parked.retry`) behind your own auth. Other tokens: `WATUKUY_OPTIONS` (the resolved module options), `WATUKUY_POLLERS` (feature contributions), `WATUKUY_POLLER_MAP`.

## Manual mode with Nest's scheduler

If the app should not run the daemon loop (several replicas behind an external scheduler, or a serverless deployment of the Nest app), set `mode: 'manual'` and call `tick()` from `@nestjs/schedule`:

```ts
WatukuyModule.forRoot({ store, pollers: { orders }, mode: 'manual' });

@Injectable()
export class PollCron {
  constructor(@InjectWatukuy() private readonly engine: Engine<PollerMap>) {}

  @Cron('*/1 * * * *')
  tick() { return this.engine.tick({ maxDuration: '50s' }); }
}
```

Handlers are still wired at bootstrap, so `tick()` has somewhere to deliver.

## Health indicator

```ts
import { Controller, Get, Module } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TerminusModule } from '@nestjs/terminus';
import { WatukuyHealthIndicator } from 'watukuy/nestjs';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService, private readonly watukuy: WatukuyHealthIndicator) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.watukuy.isHealthy('watukuy', { maxLagMs: 10 * 60_000 })]);
  }
}

@Module({
  imports: [TerminusModule /* , WatukuyModule.forRoot(...) */],
  controllers: [HealthController],
  providers: [WatukuyHealthIndicator],   // not registered by WatukuyModule: terminus is optional
})
export class HealthModule {}
```

`isHealthy(key, { maxLagMs?, allowOpenCircuit? })` calls `engine.inspect()` and reports `down` when any poller's circuit is `'open'` (unless `allowOpenCircuit: true`), when a timestamp poller's `lagMs` exceeds `maxLagMs`, or when the module runs in daemon mode and the engine status is not `'running'`. The result is structurally a Terminus `HealthIndicatorResult`, with `engineStatus`, `instanceId`, `mode`, `reasons` (human-readable causes when down), and one row per `(poller, partition)` with `paused`, `circuit`, `lagMs`, `outboxPending`, `parked`, and `leaseOwner`. The class has no runtime dependency on `@nestjs/terminus`, so the entry point loads without it.

## Validation schemas

Pollers accept any Standard Schema v1 validator, which is what Nest 12's validation pipeline also supports. Reuse the Zod or Valibot schemas you already have for DTOs as `schema` in `definePoller`; the item type is inferred from them, and invalid upstream records are quarantined rather than crashing the poller.

## Without the adapter

Everything above can be done by hand:

```ts
@Injectable()
export class WatukuyService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly engine = createWatukuy({ store: new SqliteStore({ path: './watukuy.db' }), pollers: { orders } });

  constructor(private readonly handler: OrdersHandler) {}

  async onApplicationBootstrap() {
    this.engine.on('orders', (e, ctx) => this.handler.onOrder(e, ctx));
    await this.engine.start();
  }

  beforeApplicationShutdown() {
    return this.engine.stop({ drain: true, timeout: '30s' });
  }
}
```

A complete application lives in `examples/nestjs-app` (SQLite store, `forRootAsync`, decorator handler, Terminus health, operations controller).

Related: [observability.md](./observability.md), [runbook.md](./runbook.md), [serverless.md](./serverless.md).
