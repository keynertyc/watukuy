import { Injectable } from '@nestjs/common';
import type { HandlerContext, WatukuyEvent } from 'watukuy';
import { OnWatukuyEvent } from 'watukuy/nestjs';
import type { Order } from './orders.poller.ts';

/**
 * A regular provider. `@OnWatukuyEvent('orders')` marks the method as the consumer for the
 * `orders` poller; `WatukuyModule` wires it with `engine.on()` at application bootstrap.
 * One handler per poller. Inject anything you like (queues, repositories, mailers...).
 */
@Injectable()
export class OrdersHandler {
  @OnWatukuyEvent('orders')
  onOrder(event: WatukuyEvent<Order>, ctx: HandlerContext): void {
    const o = event.data;
    const change =
      event.type === 'updated' && event.previous && o
        ? `status ${event.previous.status} -> ${o.status}`
        : `${o?.customer ?? ''} ${o?.status ?? ''} $${o?.total?.toFixed(2) ?? ''}`;
    // ctx.logger is the engine's logger scoped to this poller; console keeps the demo readable.
    console.log(`[orders] #${event.sequence} ${event.type.padEnd(7)} ${event.subject} ${change}`);
    if (ctx.attempt > 1) console.log(`[orders]   (redelivery, attempt ${ctx.attempt})`);
  }
}
