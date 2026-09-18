import { Controller, Get, Inject, Post } from '@nestjs/common';
import type { Engine, PollerMap } from 'watukuy';
import { WATUKUY_ENGINE } from 'watukuy/nestjs';

/**
 * Operations endpoints. The engine is an ordinary provider (token `WATUKUY_ENGINE`), so any
 * controller can expose `inspect()`, `trigger()`, `pause()`, `parked.retry()`... behind your
 * own auth.
 */
@Controller()
export class InspectController {
  constructor(@Inject(WATUKUY_ENGINE) private readonly engine: Engine<PollerMap>) {}

  /** GET /inspect -> per (poller, partition): cursor, schedule, circuit, lag, outbox, parked. */
  @Get('inspect')
  inspect() {
    return this.engine.inspect();
  }

  /** POST /orders/trigger -> poll now instead of waiting for the adaptive interval. */
  @Post('orders/trigger')
  async trigger() {
    await this.engine.trigger('orders');
    return { triggered: 'orders' };
  }
}
