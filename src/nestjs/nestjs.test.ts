import 'reflect-metadata';
import { Controller, Injectable, Module, Scope } from '@nestjs/common';
import { HealthCheckService, type HealthIndicatorResult, TerminusModule } from '@nestjs/terminus';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { Engine, HandlerContext, PollerMap, StateStore, WatukuyEvent } from '../index.ts';
import { ConfigError, definePoller, MemoryStore } from '../index.ts';
import { createTestLogger, FakeApi, SeededRandom, VirtualClock } from '../testing/index.ts';
import {
  InjectWatukuy,
  OnWatukuyEvent,
  WATUKUY_ENGINE,
  WATUKUY_OPTIONS,
  WATUKUY_POLLER_MAP,
  WatukuyExplorer,
  WatukuyHealthIndicator,
  WatukuyModule,
  type WatukuyModuleOptions,
} from './index.ts';

// ---- fixtures ---------------------------------------------------------------------------------

interface Order {
  id: string;
  updatedAt: string;
  status: string;
  [k: string]: unknown;
}

function world(items = 3) {
  const clock = new VirtualClock('2026-01-01T00:00:00Z');
  const random = new SeededRandom(7);
  const api = new FakeApi<Order>({
    clock,
    identity: (o) => o.id,
    timestampField: 'updatedAt',
    pageSize: 100,
  });
  for (let i = 0; i < items; i++) api.add({ id: `o${i}`, updatedAt: clock.iso(), status: 'open' });
  const store: StateStore = new MemoryStore();
  const logger = createTestLogger();
  const orders = definePoller({
    name: 'orders',
    identity: (o: Order) => o.id,
    version: (o) => o.updatedAt,
    cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
    fetch: async ({ cursor }) => {
      const res = api.listSince({ since: cursor.value, afterId: cursor.tieBreak, limit: 100 });
      return { items: res.items, hasMore: res.hasMore };
    },
    schedule: { min: '5s', max: '1m', jitter: 0 },
  });
  const catalog = definePoller({
    name: 'catalog',
    identity: (o: Order) => o.id,
    cursor: { strategy: 'snapshotDiff' },
    fetch: async ({ page }) => {
      const res = api.listPage({ page, limit: 100 });
      return { items: res.items, hasMore: res.hasMore };
    },
    schedule: { min: '10s', max: '1m', jitter: 0 },
  });
  const base = {
    store,
    clock,
    random,
    logger,
    instanceId: 'nest-test',
  } satisfies Partial<WatukuyModuleOptions>;
  return { clock, random, api, store, logger, orders, catalog, base };
}

type World = ReturnType<typeof world>;

@Injectable()
class OrdersHandler {
  readonly seen: WatukuyEvent<Order>[] = [];
  readonly contexts: HandlerContext[] = [];

  @OnWatukuyEvent('orders')
  async onOrder(event: WatukuyEvent<Order>, ctx: HandlerContext): Promise<void> {
    // Throws (and parks the event) if `this` is not bound.
    this.seen.push(event);
    this.contexts.push(ctx);
  }
}

@Injectable()
class CatalogHandler {
  readonly seen: string[] = [];

  @OnWatukuyEvent('catalog')
  onCatalog(event: WatukuyEvent<Order>): void {
    this.seen.push(`${event.type}:${event.subject}`);
  }
}

async function bootstrap(metadata: Parameters<typeof Test.createTestingModule>[0]) {
  const mod = await Test.createTestingModule(metadata).compile();
  await mod.init();
  return mod;
}

function engineOf(mod: TestingModule): Engine<PollerMap> {
  return mod.get<Engine<PollerMap>>(WATUKUY_ENGINE);
}

/** Real-time wait (not the virtual clock) for an asynchronous side effect to become visible. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until(): condition not met in time');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

// ---- forRoot / decorators / explorer ------------------------------------------------------------

describe('WatukuyModule.forRoot (manual mode)', () => {
  it('delivers events to the @OnWatukuyEvent method with `this` bound', async () => {
    const w = world(3);
    const mod = await bootstrap({
      imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
      providers: [OrdersHandler],
    });
    const engine = engineOf(mod);
    expect(engine.status).toBe('idle');
    const handler = mod.get(OrdersHandler);
    const t = await engine.tick();
    expect(t.polled).toHaveLength(1);
    expect(handler.seen.map((e) => e.type)).toEqual(['created', 'created', 'created']);
    expect(handler.seen.map((e) => e.subject)).toEqual(['o0', 'o1', 'o2']);
    expect(handler.seen[0]?.data).toMatchObject({ id: 'o0', status: 'open' });
    expect(handler.contexts[0]?.partition.key).toBe('');
    expect(typeof handler.contexts[0]?.ack).toBe('function');
    expect((await engine.inspect()).pollers[0]?.outboxPending).toBe(0);

    await w.clock.advance(5_000);
    w.api.update('o1', { status: 'paid' });
    await w.clock.advance(5_000);
    await engine.tick();
    expect(handler.seen.at(-1)).toMatchObject({ type: 'updated', subject: 'o1' });
    await mod.close();
    expect(engine.status).toBe('stopped');
  });

  it('accepts pollers as a keyed object and exposes the merged map', async () => {
    const w = world(1);
    const mod = await bootstrap({
      imports: [
        WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: { orders: w.orders } }),
      ],
    });
    const map = mod.get<PollerMap>(WATUKUY_POLLER_MAP);
    expect(Object.keys(map)).toEqual(['orders']);
    expect(map.orders).toBe(w.orders);
    expect(mod.get<WatukuyModuleOptions>(WATUKUY_OPTIONS).mode).toBe('manual');
    await mod.close();
  });

  it('discovers handlers on controllers and inherited methods', async () => {
    const w = world(2);
    const seen: string[] = [];

    class Base {
      @OnWatukuyEvent('orders')
      onOrder(event: WatukuyEvent<Order>): void {
        seen.push(`${this.constructor.name}:${event.subject}`);
      }
    }
    @Controller()
    class OrdersController extends Base {}

    const mod = await bootstrap({
      imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
      controllers: [OrdersController],
    });
    await engineOf(mod).tick();
    expect(seen).toEqual(['OrdersController:o0', 'OrdersController:o1']);
    await mod.close();
  });

  it('@InjectWatukuy() injects the engine; isGlobal: false still works from the importing module', async () => {
    const w = world(0);
    @Injectable()
    class Ops {
      constructor(@InjectWatukuy() readonly engine: Engine<PollerMap>) {}
    }
    const mod = await bootstrap({
      imports: [
        WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders], isGlobal: false }),
      ],
      providers: [Ops],
    });
    expect(mod.get(Ops).engine).toBe(engineOf(mod));
    await mod.close();
  });

  it('WatukuyExplorer.discover() lists handlers without attaching', async () => {
    const w = world(0);
    const mod = await bootstrap({
      imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
      providers: [OrdersHandler],
    });
    const found = mod.get(WatukuyExplorer).discover();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ poller: 'orders', location: 'OrdersHandler#onOrder' });
    expect(found[0]?.instance).toBe(mod.get(OrdersHandler));
    await mod.close();
  });
});

// ---- forRootAsync / forFeature ----------------------------------------------------------------

describe('WatukuyModule.forRootAsync and forFeature', () => {
  it('forRootAsync builds options from an injected provider', async () => {
    const w = world(2);
    const CONFIG = Symbol('config');
    @Module({ providers: [{ provide: CONFIG, useValue: { mode: 'manual' } }], exports: [CONFIG] })
    class ConfigModule {}

    const mod = await bootstrap({
      imports: [
        WatukuyModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: async (config: { mode: 'manual' }) => ({
            ...w.base,
            mode: config.mode,
            pollers: [w.orders],
          }),
        }),
      ],
      providers: [OrdersHandler],
    });
    await engineOf(mod).tick();
    expect(mod.get(OrdersHandler).seen).toHaveLength(2);
    await mod.close();
  });

  it('forFeature contributes pollers from a feature module', async () => {
    const w = world(2);
    @Module({
      imports: [WatukuyModule.forFeature([w.catalog])],
      providers: [CatalogHandler],
    })
    class CatalogModule {}

    const mod = await bootstrap({
      imports: [
        WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] }),
        CatalogModule,
      ],
      providers: [OrdersHandler],
    });
    const map = mod.get<PollerMap>(WATUKUY_POLLER_MAP);
    expect(Object.keys(map).sort()).toEqual(['catalog', 'orders']);
    const t = await engineOf(mod).tick();
    expect(t.polled.map((p) => p.poller).sort()).toEqual(['catalog', 'orders']);
    expect(mod.get(OrdersHandler).seen).toHaveLength(2);
    expect(mod.get(CatalogHandler).seen.sort()).toEqual(['created:o0', 'created:o1']);
    await mod.close();
  });

  it('the same definition contributed twice counts once; a different definition with the same name is rejected', async () => {
    const w = world(0);
    @Module({ imports: [WatukuyModule.forFeature([w.orders])] })
    class A {}
    @Module({ imports: [WatukuyModule.forFeature([w.orders])] })
    class B {}
    const ok = await bootstrap({
      imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] }), A, B],
    });
    expect(Object.keys(ok.get<PollerMap>(WATUKUY_POLLER_MAP))).toEqual(['orders']);
    await ok.close();

    const clash = definePoller({
      name: 'orders',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'snapshotDiff' },
      fetch: async () => ({ items: [] }),
    });
    @Module({ imports: [WatukuyModule.forFeature([clash])] })
    class C {}
    await expect(
      bootstrap({
        imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] }), C],
      }),
    ).rejects.toThrow(/duplicate poller name 'orders'/);
  });
});

// ---- validation --------------------------------------------------------------------------------

describe('validation', () => {
  it('rejects a decorated method that references an unknown poller', async () => {
    const w = world(0);
    @Injectable()
    class Typo {
      @OnWatukuyEvent('ordres')
      on(): void {}
    }
    await expect(
      bootstrap({
        imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
        providers: [Typo],
      }),
    ).rejects.toThrow(
      /@OnWatukuyEvent\('ordres'\) on Typo#on references an unknown poller; registered pollers: orders/,
    );
  });

  it('rejects two handlers for the same poller', async () => {
    const w = world(0);
    @Injectable()
    class Second {
      @OnWatukuyEvent('orders')
      also(): void {}
    }
    await expect(
      bootstrap({
        imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
        providers: [OrdersHandler, Second],
      }),
    ).rejects.toThrow(/two @OnWatukuyEvent handlers \(OrdersHandler#onOrder and Second#also\)/);
  });

  it('rejects handlers on request-scoped providers with a clear message', async () => {
    const w = world(0);
    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {
      @OnWatukuyEvent('orders')
      on(): void {}
    }
    await expect(
      bootstrap({
        imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
        providers: [PerRequest],
      }),
    ).rejects.toThrow(/PerRequest#on: handlers must live on singleton providers/);
  });

  it('validates decorator arguments and module options eagerly', async () => {
    const w = world(0);
    expect(() => OnWatukuyEvent('')).toThrow(ConfigError);
    expect(() =>
      WatukuyModule.forRoot({ ...w.base, mode: 'later' as unknown as 'manual' }),
    ).toThrow(/mode must be 'daemon' or 'manual'/);
    expect(() =>
      WatukuyModule.forRoot({ ...w.base, pollers: [{} as unknown as typeof w.orders] }),
    ).toThrow(/pollers\[0\] is not a definePoller\(\) result/);
    expect(() => WatukuyModule.forRoot({ ...w.base, pollers: { nope: w.orders } })).toThrow(
      /pollers\.nope has name 'orders'/,
    );
    expect(() => WatukuyModule.forFeature('x' as unknown as [])).toThrow(/expected an array/);
    expect(() =>
      WatukuyModule.forRootAsync({} as unknown as Parameters<typeof WatukuyModule.forRootAsync>[0]),
    ).toThrow(/requires a useFactory function/);
    // Engine-level validation surfaces at compile time.
    await expect(
      bootstrap({
        imports: [WatukuyModule.forRoot({ ...w.base, store: undefined as unknown as StateStore })],
      }),
    ).rejects.toThrow(/store is required/);
  });

  it('type-checks the decorated method signature', () => {
    class Ok {
      @OnWatukuyEvent('orders')
      a(_event: WatukuyEvent<Order>, _ctx: HandlerContext): Promise<void> {
        return Promise.resolve();
      }
      @OnWatukuyEvent('orders')
      b(): void {}
      @OnWatukuyEvent('orders')
      c(_event: WatukuyEvent): number {
        return 1;
      }
    }
    class Bad {
      // @ts-expect-error the first parameter must accept a WatukuyEvent
      @OnWatukuyEvent('orders')
      wrong(_n: number): void {}
    }
    expect(Ok).toBeDefined();
    expect(Bad).toBeDefined();
  });
});

// ---- daemon lifecycle ----------------------------------------------------------------------------

describe('daemon mode lifecycle', () => {
  it('starts the engine on init and stops it on close', async () => {
    const w = world(2);
    const mod = await bootstrap({
      imports: [
        WatukuyModule.forRoot({
          ...w.base,
          pollers: [w.orders],
          stop: { drain: true, timeout: '5s' },
        }),
      ],
      providers: [OrdersHandler],
    });
    const engine = engineOf(mod);
    expect(engine.status).toBe('running');
    // Due immediately at start: the daemon loop runs one cycle right away. Item hashing uses
    // Web Crypto (real async I/O), so wait for the observable outcome rather than a microtask turn.
    await until(() => mod.get(OrdersHandler).seen.length === 2);
    expect(mod.get(OrdersHandler).seen).toHaveLength(2);
    // Bootstrapping twice is a no-op.
    await mod.get(WatukuyModule).onApplicationBootstrap();
    expect(engine.status).toBe('running');
    await mod.close();
    expect(engine.status).toBe('stopped');
    // Shutdown is idempotent too.
    await mod.get(WatukuyModule).beforeApplicationShutdown();
    expect(engine.status).toBe('stopped');
  });
});

// ---- health ---------------------------------------------------------------------------------------

describe('WatukuyHealthIndicator', () => {
  async function healthWorld(w: World, options: Partial<WatukuyModuleOptions> = {}) {
    const mod = await bootstrap({
      imports: [
        TerminusModule,
        WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders], ...options }),
      ],
      providers: [OrdersHandler, WatukuyHealthIndicator],
    });
    return { mod, engine: engineOf(mod), indicator: mod.get(WatukuyHealthIndicator) };
  }

  it('is up in manual mode with closed circuits and reports a compact payload', async () => {
    const w = world(2);
    const { mod, engine, indicator } = await healthWorld(w);
    await engine.tick();
    const result = await indicator.isHealthy();
    expect(result.watukuy.status).toBe('up');
    expect(result.watukuy.reasons).toEqual([]);
    expect(result.watukuy.engineStatus).toBe('idle');
    expect(result.watukuy.mode).toBe('manual');
    expect(result.watukuy.pollers).toEqual([
      {
        poller: 'orders',
        partition: '',
        paused: false,
        circuit: 'closed',
        lagMs: 0,
        outboxPending: 0,
        parked: 0,
        leaseOwner: null,
      },
    ]);
    // Custom key.
    const custom = await indicator.isHealthy('erp');
    expect(custom.erp.status).toBe('up');
    await mod.close();
  });

  it('plugs into terminus HealthCheckService', async () => {
    const w = world(1);
    const { mod, indicator } = await healthWorld(w);
    const terminusResult: HealthIndicatorResult = await indicator.isHealthy();
    expect(terminusResult.watukuy?.status).toBe('up');
    const check = await mod.get(HealthCheckService).check([() => indicator.isHealthy()]);
    expect(check.status).toBe('ok');
    expect(check.details.watukuy?.status).toBe('up');
    await mod.close();
  });

  it('is down when a circuit is open (unless allowOpenCircuit)', async () => {
    const w = world(1);
    const { mod, engine, indicator } = await healthWorld(w);
    await engine.tick();
    const key = { poller: 'orders', partition: '' };
    const state = await w.store.loadState(key);
    if (!state) throw new Error('state missing');
    await w.store.saveStateUnfenced(key, {
      schedule: { ...state.schedule, circuit: 'open', circuitOpenedAt: w.clock.now() },
    });
    const down = await indicator.isHealthy();
    expect(down.watukuy.status).toBe('down');
    expect(down.watukuy.reasons).toEqual(["circuit open for 'orders'"]);
    expect(down.watukuy.pollers[0]?.circuit).toBe('open');
    const tolerated = await indicator.isHealthy('watukuy', { allowOpenCircuit: true });
    expect(tolerated.watukuy.status).toBe('up');
    await mod.close();
  });

  it('opens the circuit for real after consecutive fetch failures and reports down', async () => {
    const w = world(1);
    const { mod, engine, indicator } = await healthWorld(w);
    await engine.tick();
    w.api.failNext({ kind: 'http', status: 500 }, 5);
    for (let i = 0; i < 12 && (await indicator.isHealthy()).watukuy.status === 'up'; i++) {
      await w.clock.advance(60_000); // beyond schedule.max and any backoff
      await engine.tick();
    }
    const result = await indicator.isHealthy();
    expect(result.watukuy.status).toBe('down');
    expect(result.watukuy.pollers[0]?.circuit).toBe('open');
    await mod.close();
  });

  it('is down when lag exceeds maxLagMs', async () => {
    const w = world(1);
    const { mod, engine, indicator } = await healthWorld(w);
    await engine.tick();
    await w.clock.advance(120_000);
    const fine = await indicator.isHealthy('watukuy', { maxLagMs: 300_000 });
    expect(fine.watukuy.status).toBe('up');
    const late = await indicator.isHealthy('watukuy', { maxLagMs: 60_000 });
    expect(late.watukuy.status).toBe('down');
    expect(late.watukuy.reasons[0]).toMatch(/lag 120000ms exceeds 60000ms for 'orders'/);
    await mod.close();
  });

  it('in daemon mode, is up while running and down once stopped', async () => {
    const w = world(0);
    const { mod, engine, indicator } = await healthWorld(w, { mode: 'daemon' });
    expect(engine.status).toBe('running');
    expect((await indicator.isHealthy()).watukuy.status).toBe('up');
    await mod.close();
    const after = await indicator.isHealthy();
    expect(after.watukuy.status).toBe('down');
    expect(after.watukuy.reasons).toEqual(["engine status is 'stopped'"]);
  });

  it('works without WATUKUY_OPTIONS (custom engine provider), defaulting to daemon semantics', async () => {
    const w = world(0);
    const mod = await bootstrap({
      imports: [WatukuyModule.forRoot({ ...w.base, mode: 'manual', pollers: [w.orders] })],
      providers: [
        {
          provide: 'standalone',
          useFactory: (engine: Engine<PollerMap>) => new WatukuyHealthIndicator(engine),
          inject: [WATUKUY_ENGINE],
        },
      ],
    });
    const standalone = mod.get<WatukuyHealthIndicator>('standalone');
    const result = await standalone.isHealthy();
    expect(result.watukuy.mode).toBe('daemon');
    expect(result.watukuy.status).toBe('down'); // manual engine is idle
    await mod.close();
  });
});
