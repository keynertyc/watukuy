import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { WatukuyHealthIndicator } from 'watukuy/nestjs';

/**
 * GET /health -> Terminus payload. `WatukuyHealthIndicator` reports `down` when a circuit is
 * open, when the engine is not running, or when a timestamp poller's lag exceeds `maxLagMs`.
 * The ERP mutates every 2s, so the lag stays in the low seconds while everything is healthy.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly watukuy: WatukuyHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.watukuy.isHealthy('watukuy', { maxLagMs: 60_000 })]);
  }
}
