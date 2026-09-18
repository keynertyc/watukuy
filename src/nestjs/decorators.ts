import { Inject, SetMetadata } from '@nestjs/common';
import { ConfigError } from '../core/errors.ts';
import type { HandlerContext, WatukuyEvent } from '../core/event.ts';
import { WATUKUY_ENGINE, WATUKUY_EVENT_METADATA } from './tokens.ts';

/**
 * Metadata stored by {@link OnWatukuyEvent} under {@link WATUKUY_EVENT_METADATA}.
 *
 * @example
 * const meta = reflector.get<OnWatukuyEventMetadata | undefined, string>(WATUKUY_EVENT_METADATA, fn);
 * meta?.poller; // 'orders'
 */
export interface OnWatukuyEventMetadata {
  readonly poller: string;
}

/**
 * Shape a method must have to be decorated with {@link OnWatukuyEvent}: it receives the event and
 * the handler context, and may return anything (usually `void` or `Promise<void>`). Declaring the
 * event parameter as `WatukuyEvent<YourItem>` is allowed and encouraged.
 *
 * @example
 * const ok: WatukuyEventMethod = (event: WatukuyEvent<Order>) => console.log(event.subject);
 */
export type WatukuyEventMethod = (event: WatukuyEvent<never>, ctx: HandlerContext) => unknown;

/**
 * Method decorator produced by {@link OnWatukuyEvent}. Applying it to a method whose parameters
 * cannot accept `(event, ctx)` is a compile-time error.
 *
 * @example
 * const onOrders: OnWatukuyEventDecorator = OnWatukuyEvent('orders');
 */
export type OnWatukuyEventDecorator = <T extends WatukuyEventMethod>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => void;

/**
 * Mark a method on a provider or controller as the consumer for `pollerName`. At
 * `onApplicationBootstrap` the module's explorer finds every decorated method and registers it
 * with `engine.on(pollerName, method.bind(instance))`. One handler per poller: two decorated
 * methods targeting the same poller, or a name that no registered poller has, fail the bootstrap
 * with a `ConfigError`.
 *
 * The host class must be a singleton provider (the default scope); request- and transient-scoped
 * classes are rejected because they have no instance to bind at bootstrap.
 *
 * @example
 * @Injectable()
 * export class OrdersHandler {
 *   constructor(private readonly queue: Queue) {}
 *
 *   @OnWatukuyEvent('orders')
 *   async onOrder(event: WatukuyEvent<Order>, ctx: HandlerContext): Promise<void> {
 *     ctx.logger.info('order changed', { type: event.type, id: event.subject });
 *     await this.queue.add('order-sync', event, { jobId: event.id });
 *   }
 * }
 */
export function OnWatukuyEvent(pollerName: string): OnWatukuyEventDecorator {
  if (typeof pollerName !== 'string' || pollerName.length === 0) {
    throw new ConfigError(
      `@OnWatukuyEvent(pollerName) requires a non-empty poller name, got ${JSON.stringify(pollerName)}`,
    );
  }
  const metadata: OnWatukuyEventMetadata = Object.freeze({ poller: pollerName });
  const setMetadata = SetMetadata(WATUKUY_EVENT_METADATA, metadata);
  return (target, propertyKey, descriptor) => {
    setMetadata(target, propertyKey, descriptor);
  };
}

/**
 * Shorthand for `@Inject(WATUKUY_ENGINE)`.
 *
 * @example
 * @Injectable()
 * export class OpsService {
 *   constructor(@InjectWatukuy() private readonly engine: Engine<PollerMap>) {}
 *   status() { return this.engine.inspect(); }
 * }
 */
export function InjectWatukuy(): PropertyDecorator & ParameterDecorator {
  return Inject(WATUKUY_ENGINE);
}
