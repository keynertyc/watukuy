/**
 * watukuy/nestjs — NestJS adapter (see docs/nestjs.md).
 *
 * Requires `@nestjs/common`, `@nestjs/core` and `reflect-metadata` (optional peers).
 * {@link WatukuyHealthIndicator} targets `@nestjs/terminus` but does not import it, so this
 * entry point loads without terminus installed.
 *
 * @example
 * import { Module } from '@nestjs/common';
 * import { MemoryStore } from 'watukuy';
 * import { WatukuyModule, OnWatukuyEvent } from 'watukuy/nestjs';
 *
 * @Injectable()
 * class OrdersHandler {
 *   @OnWatukuyEvent('orders')
 *   onOrder(event: WatukuyEvent<Order>) { console.log(event.type, event.subject); }
 * }
 *
 * @Module({
 *   imports: [WatukuyModule.forRoot({ store: new MemoryStore(), pollers: [orders] })],
 *   providers: [OrdersHandler],
 * })
 * class AppModule {}
 * @packageDocumentation
 */

export {
  InjectWatukuy,
  OnWatukuyEvent,
  type OnWatukuyEventDecorator,
  type OnWatukuyEventMetadata,
  type WatukuyEventMethod,
} from './decorators.ts';
export { type DiscoveredEventHandler, WatukuyExplorer } from './explorer.ts';
export {
  type WatukuyHealthData,
  WatukuyHealthIndicator,
  type WatukuyHealthIndicatorResult,
  type WatukuyHealthOptions,
  type WatukuyPollerHealth,
} from './health.ts';
export {
  WatukuyFeatureModule,
  WatukuyModule,
  type WatukuyModuleAsyncOptions,
  type WatukuyModuleMode,
  type WatukuyModuleOptions,
  type WatukuyModuleRootOptions,
} from './module.ts';
export {
  WATUKUY_ENGINE,
  WATUKUY_EVENT_METADATA,
  WATUKUY_OPTIONS,
  WATUKUY_POLLER_MAP,
  WATUKUY_POLLERS,
} from './tokens.ts';
