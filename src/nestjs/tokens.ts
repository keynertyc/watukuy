/**
 * Injection tokens and metadata keys used by the NestJS adapter.
 *
 * `Symbol.for()` is used so that duplicated copies of the package (dual installs, monorepo
 * hoisting quirks) still resolve to the same token.
 * @module
 */

/**
 * Injection token for the running {@link Engine}. Provided and exported by
 * `WatukuyModule.forRoot()` / `forRootAsync()`.
 *
 * The engine is typed as `Engine<PollerMap>`; narrow it to your own poller map when you want
 * `engine.on('orders', ...)` fully typed.
 *
 * @example
 * import { Inject, Injectable } from '@nestjs/common';
 * import type { Engine } from 'watukuy';
 * import { WATUKUY_ENGINE } from 'watukuy/nestjs';
 *
 * @Injectable()
 * class OpsService {
 *   constructor(@Inject(WATUKUY_ENGINE) private readonly engine: Engine<{ orders: typeof orders }>) {}
 *   poke() { return this.engine.trigger('orders'); }
 * }
 */
export const WATUKUY_ENGINE: unique symbol = Symbol.for('watukuy:engine');

/**
 * Injection token for the validated {@link WatukuyModuleOptions} the module was configured with.
 *
 * @example
 * constructor(@Inject(WATUKUY_OPTIONS) private readonly options: WatukuyModuleOptions) {}
 */
export const WATUKUY_OPTIONS: unique symbol = Symbol.for('watukuy:options');

/**
 * Multi-provider token carrying an array of `definePoller()` results contributed by a feature
 * module. `WatukuyModule.forFeature([...])` registers one provider under this token per call;
 * the root module discovers every contribution and merges them into {@link WATUKUY_POLLER_MAP}.
 *
 * Inject {@link WATUKUY_POLLER_MAP} (not this token) when you need the complete set.
 *
 * @example
 * // Equivalent to WatukuyModule.forFeature([orders]):
 * @Module({ providers: [{ provide: WATUKUY_POLLERS, useValue: [orders] }] })
 * class OrdersModule {}
 */
export const WATUKUY_POLLERS: unique symbol = Symbol.for('watukuy:pollers');

/**
 * Injection token for the merged, keyed poller map (`Record<name, PollerDefinition>`) the engine
 * was created with: `forRoot({ pollers })` plus every `forFeature()` contribution.
 *
 * @example
 * constructor(@Inject(WATUKUY_POLLER_MAP) private readonly pollers: PollerMap) {}
 * names() { return Object.keys(this.pollers); }
 */
export const WATUKUY_POLLER_MAP: unique symbol = Symbol.for('watukuy:poller-map');

/**
 * Metadata key under which `@OnWatukuyEvent()` stores `{ poller }` on the decorated method.
 * Read it with Nest's `Reflector` when building custom tooling on top of the explorer.
 *
 * @example
 * const meta = reflector.get<{ poller: string } | undefined>(WATUKUY_EVENT_METADATA, instance.onOrder);
 */
export const WATUKUY_EVENT_METADATA = 'watukuy:on-event' as const;
