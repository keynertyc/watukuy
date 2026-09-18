import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  type FactoryProvider,
  Inject,
  Module,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { isPollerDefinition } from '../core/define-poller.ts';
import { createWatukuy } from '../core/engine.ts';
import type { Engine, EngineOptions, PollerMap, StopOptions } from '../core/engine-types.ts';
import { ConfigError } from '../core/errors.ts';
import type { AnyPollerDefinition } from '../core/poller-types.ts';
import { WatukuyExplorer } from './explorer.ts';
import { WATUKUY_ENGINE, WATUKUY_OPTIONS, WATUKUY_POLLER_MAP, WATUKUY_POLLERS } from './tokens.ts';

/**
 * How the module drives the engine.
 *
 * - `'daemon'`: `engine.start()` at `onApplicationBootstrap`, `engine.stop()` at
 *   `beforeApplicationShutdown`. The default.
 * - `'manual'`: only creates the engine and attaches handlers; you call `engine.tick()` yourself
 *   (from `@nestjs/schedule`, a controller, a queue worker...).
 *
 * @example
 * const mode: WatukuyModuleMode = process.env.WATUKUY_TICK ? 'manual' : 'daemon';
 */
export type WatukuyModuleMode = 'daemon' | 'manual';

/**
 * Options for `WatukuyModule.forRoot()` and the value returned by `forRootAsync().useFactory`.
 *
 * @example
 * const options: WatukuyModuleOptions = { store: new MemoryStore(), pollers: [orders], mode: 'manual' };
 */
export interface WatukuyModuleOptions extends Omit<EngineOptions<PollerMap>, 'pollers'> {
  /**
   * Pollers to register, as an array or as a name-keyed object. Feature modules may contribute
   * more through `WatukuyModule.forFeature()`; all contributions are merged.
   */
  pollers?: AnyPollerDefinition[] | Record<string, AnyPollerDefinition> | undefined;
  /**
   * `'daemon'` calls `engine.start()` on bootstrap and `stop()` on shutdown; `'manual'` only
   * creates the engine (use `engine.tick()` yourself).
   * @default 'daemon'
   */
  mode?: WatukuyModuleMode | undefined;
  /** Passed to `engine.stop()` on shutdown. @default { drain: true, timeout: '30s' } */
  stop?: StopOptions | undefined;
  /** Run `store.migrate()` (idempotent) at bootstrap before starting. @default true */
  migrate?: boolean | undefined;
  /**
   * Call `store.close()` after the engine stopped. Off by default: the module does not close a
   * client it did not open (pools are often shared).
   * @default false
   */
  closeStore?: boolean | undefined;
}

/**
 * `WatukuyModule.forRoot()` options.
 *
 * @example
 * WatukuyModule.forRoot({ store, pollers: [orders], isGlobal: false });
 */
export interface WatukuyModuleRootOptions extends WatukuyModuleOptions {
  /** Register the module globally so `WATUKUY_ENGINE` is injectable everywhere. @default true */
  isGlobal?: boolean | undefined;
}

/**
 * `WatukuyModule.forRootAsync()` options.
 *
 * @example
 * WatukuyModule.forRootAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => build(c) });
 */
export interface WatukuyModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Builds the options, typically from an injected `ConfigService`. */
  useFactory: (...args: never[]) => Promise<WatukuyModuleOptions> | WatukuyModuleOptions;
  /** Providers injected into `useFactory`, in order. */
  inject?: FactoryProvider['inject'];
  /** @default true */
  isGlobal?: boolean | undefined;
}

const DEFAULT_STOP: StopOptions = Object.freeze({ drain: true, timeout: '30s' });
const MODES: ReadonlySet<string> = new Set<WatukuyModuleMode>(['daemon', 'manual']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate module-level options (`mode`, `stop`, `pollers` shape). Engine options such as
 * `store` are validated by `createWatukuy()` itself. Returns the same object.
 */
function validateModuleOptions(options: WatukuyModuleOptions): WatukuyModuleOptions {
  if (!isPlainObject(options)) {
    throw new ConfigError('WatukuyModule: options must be an object');
  }
  if (options.mode !== undefined && !MODES.has(options.mode)) {
    throw new ConfigError(
      `WatukuyModule: mode must be 'daemon' or 'manual', got ${JSON.stringify(options.mode)}`,
    );
  }
  if (options.stop !== undefined && !isPlainObject(options.stop)) {
    throw new ConfigError('WatukuyModule: stop must be an object ({ drain, timeout })');
  }
  if (
    options.pollers !== undefined &&
    !Array.isArray(options.pollers) &&
    !isPlainObject(options.pollers)
  ) {
    throw new ConfigError(
      'WatukuyModule: pollers must be an array or an object of definePoller() results',
    );
  }
  return options;
}

/** Validate a `forFeature()` / `WATUKUY_POLLERS` contribution. */
function validatePollerList(list: unknown, origin: string): AnyPollerDefinition[] {
  if (!Array.isArray(list)) {
    throw new ConfigError(`${origin}: expected an array of definePoller() results`);
  }
  return list.map((def: unknown, index) => {
    if (!isPollerDefinition(def)) {
      throw new ConfigError(`${origin}[${index}] is not a definePoller() result`);
    }
    return def;
  });
}

/** Normalize `options.pollers` (array or keyed object) into a list, validating each entry. */
function pollersFromOptions(options: WatukuyModuleOptions): AnyPollerDefinition[] {
  const source = options.pollers;
  if (source === undefined) return [];
  if (Array.isArray(source)) return validatePollerList(source, 'WatukuyModule pollers');
  return Object.entries(source).map(([key, def]) => {
    if (!isPollerDefinition(def)) {
      throw new ConfigError(`WatukuyModule pollers.${key} is not a definePoller() result`);
    }
    if (def.name !== key) {
      throw new ConfigError(
        `WatukuyModule pollers.${key} has name '${def.name}'; the object key must equal the poller name`,
      );
    }
    return def;
  });
}

/**
 * Merge root options and every `WATUKUY_POLLERS` provider found in the container into a keyed
 * map. The same definition object contributed twice counts once; two different definitions with
 * one name is an error.
 */
function collectPollers(options: WatukuyModuleOptions, discovery: DiscoveryService): PollerMap {
  const map: Record<string, AnyPollerDefinition> = {};
  const add = (def: AnyPollerDefinition, origin: string): void => {
    const existing = map[def.name];
    if (existing === def) return;
    if (existing) {
      throw new ConfigError(
        `WatukuyModule: duplicate poller name '${def.name}' (${origin}); every poller needs a unique name`,
      );
    }
    map[def.name] = def;
  };
  for (const def of pollersFromOptions(options)) add(def, 'forRoot options');
  for (const wrapper of discovery.getProviders()) {
    if (wrapper.token !== WATUKUY_POLLERS) continue;
    const list = validatePollerList(wrapper.instance, 'WatukuyModule.forFeature()');
    for (const def of list) add(def, 'forFeature()');
  }
  return map;
}

function toEngineOptions(
  options: WatukuyModuleOptions,
  pollers: PollerMap,
): EngineOptions<PollerMap> {
  const { pollers: _pollers, mode: _mode, stop: _stop, ...engineOptions } = options;
  return { ...engineOptions, pollers };
}

function coreProviders(): Provider[] {
  return [
    {
      provide: WATUKUY_POLLER_MAP,
      useFactory: (options: WatukuyModuleOptions, discovery: DiscoveryService): PollerMap =>
        collectPollers(options, discovery),
      inject: [WATUKUY_OPTIONS, DiscoveryService],
    },
    {
      provide: WATUKUY_ENGINE,
      useFactory: (options: WatukuyModuleOptions, pollers: PollerMap): Engine<PollerMap> =>
        createWatukuy(toEngineOptions(options, pollers)),
      inject: [WATUKUY_OPTIONS, WATUKUY_POLLER_MAP],
    },
    WatukuyExplorer,
  ];
}

const EXPORTS = [WATUKUY_ENGINE, WATUKUY_OPTIONS, WATUKUY_POLLER_MAP];

/**
 * Host for `WatukuyModule.forFeature()` contributions. Carries a single `WATUKUY_POLLERS`
 * provider and no lifecycle hooks; the root module discovers it.
 *
 * @example
 * // You normally never reference this class; use WatukuyModule.forFeature([...]).
 * @Module({ imports: [WatukuyModule.forFeature([orders])] })
 * class OrdersModule {}
 */
@Module({})
export class WatukuyFeatureModule {}

/**
 * NestJS integration for watukuy (see docs/nestjs.md).
 *
 * `forRoot()` / `forRootAsync()` create one engine per application, exported under
 * {@link WATUKUY_ENGINE}. At `onApplicationBootstrap` the module attaches every
 * `@OnWatukuyEvent()` method it finds on providers and controllers, then (in `'daemon'` mode)
 * calls `engine.start()`. At `beforeApplicationShutdown` it calls `engine.stop()` with the
 * configured `stop` options. Call `app.enableShutdownHooks()` so SIGTERM triggers the drain.
 *
 * @example
 * @Module({
 *   imports: [
 *     WatukuyModule.forRoot({
 *       store: new SqliteStore({ path: './watukuy.db' }),
 *       budgets: { erp: { requests: 100, per: '1m' } },
 *       pollers: [orders],
 *     }),
 *   ],
 *   providers: [OrdersHandler], // has a method decorated with @OnWatukuyEvent('orders')
 * })
 * export class AppModule {}
 */
@Module({})
export class WatukuyModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    @Inject(WATUKUY_ENGINE) private readonly engine: Engine<PollerMap>,
    @Inject(WATUKUY_OPTIONS) private readonly options: WatukuyModuleOptions,
    @Inject(WATUKUY_POLLER_MAP) private readonly pollers: PollerMap,
    @Inject(WatukuyExplorer) private readonly explorer: WatukuyExplorer,
  ) {}

  /**
   * Configure the engine synchronously. Global by default.
   *
   * @example
   * WatukuyModule.forRoot({
   *   store: new MemoryStore(),
   *   pollers: { orders },
   *   mode: 'manual', // call engine.tick() yourself
   * })
   */
  static forRoot(options: WatukuyModuleRootOptions): DynamicModule {
    const { isGlobal, ...rest } = validateModuleOptions(options) as WatukuyModuleRootOptions;
    const moduleOptions: WatukuyModuleOptions = rest;
    pollersFromOptions(moduleOptions); // fail fast on malformed inline pollers
    return {
      module: WatukuyModule,
      global: isGlobal ?? true,
      imports: [DiscoveryModule],
      providers: [{ provide: WATUKUY_OPTIONS, useValue: moduleOptions }, ...coreProviders()],
      exports: EXPORTS,
    };
  }

  /**
   * Configure the engine from injected dependencies.
   *
   * @example
   * WatukuyModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({
   *     store: new PostgresStore({ client: new Pool({ connectionString: config.get('DATABASE_URL') }) }),
   *     pollers: [orders],
   *     stop: { drain: true, timeout: '20s' },
   *   }),
   * })
   */
  static forRootAsync(options: WatukuyModuleAsyncOptions): DynamicModule {
    if (!isPlainObject(options) || typeof options.useFactory !== 'function') {
      throw new ConfigError('WatukuyModule.forRootAsync(options) requires a useFactory function');
    }
    const optionsProvider: FactoryProvider<WatukuyModuleOptions> = {
      provide: WATUKUY_OPTIONS,
      useFactory: async (...args: unknown[]): Promise<WatukuyModuleOptions> =>
        validateModuleOptions(await options.useFactory(...(args as never[]))),
      inject: options.inject ?? [],
    };
    return {
      module: WatukuyModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [optionsProvider, ...coreProviders()],
      exports: EXPORTS,
    };
  }

  /**
   * Contribute pollers from a feature module. Contributions are merged with `forRoot` pollers
   * when the engine is created; names must be unique across the application.
   *
   * @example
   * @Module({
   *   imports: [WatukuyModule.forFeature([invoices])],
   *   providers: [InvoicesHandler],
   * })
   * export class BillingModule {}
   */
  static forFeature(pollers: AnyPollerDefinition[]): DynamicModule {
    const list = Object.freeze([
      ...validatePollerList(pollers, 'WatukuyModule.forFeature(pollers)'),
    ]);
    return {
      module: WatukuyFeatureModule,
      providers: [{ provide: WATUKUY_POLLERS, useValue: list }],
    };
  }

  /** Attach `@OnWatukuyEvent` handlers, then start the engine in `'daemon'` mode. Idempotent. */
  onApplicationBootstrap(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.bootstrap();
    return this.startPromise;
  }

  /** Stop the engine with the configured `stop` options. Idempotent. */
  beforeApplicationShutdown(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    await this.engine.stop(this.options.stop ?? DEFAULT_STOP);
    if (this.options.closeStore === true) await this.options.store.close();
  }

  private async bootstrap(): Promise<void> {
    if (this.options.migrate !== false) await this.engine.migrate();
    this.explorer.attach(this.engine, Object.keys(this.pollers));
    if ((this.options.mode ?? 'daemon') === 'daemon') await this.engine.start();
  }
}
