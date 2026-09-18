import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Engine, PollerMap } from '../core/engine-types.ts';
import { ConfigError } from '../core/errors.ts';
import type { EventHandler } from '../core/event.ts';
import type { OnWatukuyEventMetadata } from './decorators.ts';
import { WATUKUY_EVENT_METADATA } from './tokens.ts';

type InstanceWrapper = ReturnType<DiscoveryService['getProviders']>[number];

/**
 * A method found by {@link WatukuyExplorer.discover}.
 *
 * @example
 * const [first] = explorer.discover();
 * first?.location; // 'OrdersHandler#onOrder'
 */
export interface DiscoveredEventHandler {
  /** Poller name passed to `@OnWatukuyEvent()`. */
  poller: string;
  /** `ClassName#methodName`, for error messages and logs. */
  location: string;
  /** The singleton instance hosting the method. */
  instance: object;
  methodName: string;
  /** The method, already bound to `instance`. */
  handler: EventHandler<unknown>;
}

interface DecoratedMethod {
  methodName: string;
  poller: string;
}

function classNameOf(target: object | null | undefined): string {
  const ctor = (target as { constructor?: { name?: unknown } } | null | undefined)?.constructor;
  return typeof ctor?.name === 'string' && ctor.name.length > 0 ? ctor.name : 'Object';
}

/**
 * Finds every provider and controller method decorated with `@OnWatukuyEvent()` and attaches it
 * to the engine. Registered by `WatukuyModule`; you rarely need it directly, but it is exported
 * so custom bootstrapping code can reuse the discovery logic.
 *
 * @example
 * const explorer = app.get(WatukuyExplorer);
 * for (const h of explorer.discover()) console.log(h.location, '->', h.poller);
 */
@Injectable()
export class WatukuyExplorer {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  /**
   * Scan all providers and controllers for `@OnWatukuyEvent()` methods. Does not touch the
   * engine. Throws a `ConfigError` when a decorated method lives on a request- or
   * transient-scoped class.
   *
   * @example
   * const handlers = explorer.discover();
   * expect(handlers.map((h) => h.poller)).toEqual(['orders']);
   */
  discover(): DiscoveredEventHandler[] {
    const wrappers: InstanceWrapper[] = [
      ...this.discovery.getProviders(),
      ...this.discovery.getControllers(),
    ];
    const found: DiscoveredEventHandler[] = [];
    const seen = new Set<object>();
    for (const wrapper of wrappers) {
      if (wrapper.isAlias) continue;
      if (!wrapper.isDependencyTreeStatic()) {
        this.rejectNonStatic(wrapper);
        continue;
      }
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object' || seen.has(instance)) continue;
      seen.add(instance);
      const prototype: object | null = Object.getPrototypeOf(instance);
      if (!prototype || prototype === Object.prototype) continue;
      const className = classNameOf(instance);
      for (const { methodName, poller } of this.decoratedMethods(prototype)) {
        const method = (instance as Record<string, unknown>)[methodName];
        if (typeof method !== 'function') continue;
        found.push({
          poller,
          location: `${className}#${methodName}`,
          instance,
          methodName,
          handler: (method as (...args: unknown[]) => unknown).bind(
            instance,
          ) as EventHandler<unknown>,
        });
      }
    }
    return found;
  }

  /**
   * {@link discover} and then `engine.on(poller, handler)` for each result. Validates before
   * attaching anything: every poller name must be in `knownPollers` and each poller may have at
   * most one decorated method. Returns the attached handlers.
   *
   * @example
   * explorer.attach(engine, Object.keys(pollers));
   */
  attach(engine: Engine<PollerMap>, knownPollers: Iterable<string>): DiscoveredEventHandler[] {
    const known = new Set(knownPollers);
    const byPoller = new Map<string, DiscoveredEventHandler>();
    for (const handler of this.discover()) {
      if (!known.has(handler.poller)) {
        const registered = known.size > 0 ? [...known].sort().join(', ') : '(none)';
        throw new ConfigError(
          `@OnWatukuyEvent('${handler.poller}') on ${handler.location} references an unknown poller; registered pollers: ${registered}`,
        );
      }
      const previous = byPoller.get(handler.poller);
      if (previous) {
        throw new ConfigError(
          `poller '${handler.poller}' has two @OnWatukuyEvent handlers (${previous.location} and ${handler.location}); one consumer per poller`,
        );
      }
      byPoller.set(handler.poller, handler);
    }
    for (const handler of byPoller.values()) engine.on(handler.poller, handler.handler);
    return [...byPoller.values()];
  }

  private decoratedMethods(prototype: object): DecoratedMethod[] {
    const out: DecoratedMethod[] = [];
    for (const methodName of this.scanner.getAllMethodNames(prototype)) {
      const method = (prototype as Record<string, unknown>)[methodName];
      if (typeof method !== 'function') continue;
      const metadata = this.reflector.get<OnWatukuyEventMetadata | undefined, string>(
        WATUKUY_EVENT_METADATA,
        method as (...args: unknown[]) => unknown,
      );
      if (metadata && typeof metadata.poller === 'string') {
        out.push({ methodName, poller: metadata.poller });
      }
    }
    return out;
  }

  private rejectNonStatic(wrapper: InstanceWrapper): void {
    const metatype: unknown = wrapper.metatype;
    if (typeof metatype !== 'function') return;
    const prototype: unknown = (metatype as { prototype?: unknown }).prototype;
    if (!prototype || typeof prototype !== 'object') return;
    const decorated = this.decoratedMethods(prototype);
    const first = decorated[0];
    if (!first) return;
    throw new ConfigError(
      `@OnWatukuyEvent('${first.poller}') on ${metatype.name || 'Object'}#${first.methodName}: handlers must live on singleton providers (request- and transient-scoped classes have no instance to bind at bootstrap)`,
    );
  }
}
