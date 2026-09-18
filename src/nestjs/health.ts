import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Engine, EngineStatus, PollerMap } from '../core/engine-types.ts';
import type { CircuitState } from '../core/store-types.ts';
import type { WatukuyModuleOptions } from './module.ts';
import { WATUKUY_ENGINE, WATUKUY_OPTIONS } from './tokens.ts';

/**
 * Thresholds for {@link WatukuyHealthIndicator.isHealthy}.
 *
 * @example
 * const opts: WatukuyHealthOptions = { maxLagMs: 5 * 60_000, allowOpenCircuit: false };
 */
export interface WatukuyHealthOptions {
  /** Report `down` when any timestamp poller's `lagMs` exceeds this many milliseconds. */
  maxLagMs?: number | undefined;
  /** Keep reporting `up` while circuits are open (they are still listed in `data`). @default false */
  allowOpenCircuit?: boolean | undefined;
}

/**
 * One `(poller, partition)` row in the health payload.
 *
 * @example
 * // { poller: 'orders', partition: '', paused: false, circuit: 'closed', lagMs: 1200,
 * //   outboxPending: 0, parked: 0, leaseOwner: 'api-1' }
 */
export interface WatukuyPollerHealth {
  poller: string;
  partition: string;
  paused: boolean;
  circuit: CircuitState;
  /** `now - cursor` for timestamp pollers, else `null`. */
  lagMs: number | null;
  outboxPending: number;
  parked: number;
  /** Instance currently holding the lease, or `null`. */
  leaseOwner: string | null;
}

/**
 * Extra data attached to the health result. Never contains a `status` key (reserved by terminus).
 *
 * @example
 * const { reasons, pollers } = (await indicator.isHealthy()).watukuy;
 */
export interface WatukuyHealthData {
  engineStatus: EngineStatus;
  instanceId: string;
  mode: 'daemon' | 'manual';
  pollers: WatukuyPollerHealth[];
  /** Human-readable causes when the indicator is `down`; empty when `up`. */
  reasons: string[];
}

/**
 * Result shape of {@link WatukuyHealthIndicator.isHealthy}. Structurally identical to
 * `@nestjs/terminus`'s `HealthIndicatorResult`, so it plugs straight into
 * `HealthCheckService.check([...])` without importing terminus here.
 *
 * @example
 * const result: WatukuyHealthIndicatorResult<'watukuy'> = await indicator.isHealthy();
 * result.watukuy.status; // 'up' | 'down'
 */
export type WatukuyHealthIndicatorResult<Key extends string = string> = Record<
  Key,
  { status: 'up' | 'down' } & WatukuyHealthData
>;

/**
 * Health indicator for `@nestjs/terminus` built on `engine.inspect()`.
 *
 * Reports `down` when any poller's circuit is `'open'` (unless `allowOpenCircuit`), when a
 * poller's `lagMs` exceeds `maxLagMs` (when given), or when the module runs in `'daemon'` mode
 * and the engine status is not `'running'`. The payload lists every `(poller, partition)` with
 * its circuit, lag, outbox backlog, parked count and lease owner.
 *
 * `WatukuyModule` does not register this class (terminus is an optional peer): add it to the
 * providers of the module that hosts your health controller. It has no runtime dependency on
 * `@nestjs/terminus`; the returned object is exactly what `HealthIndicatorService.check(key).up()`
 * / `.down()` would produce.
 *
 * @example
 * @Controller('health')
 * class HealthController {
 *   constructor(
 *     private readonly health: HealthCheckService,
 *     private readonly watukuy: WatukuyHealthIndicator,
 *   ) {}
 *
 *   @Get()
 *   @HealthCheck()
 *   check() {
 *     return this.health.check([() => this.watukuy.isHealthy('watukuy', { maxLagMs: 300_000 })]);
 *   }
 * }
 */
@Injectable()
export class WatukuyHealthIndicator {
  private readonly mode: 'daemon' | 'manual';

  constructor(
    @Inject(WATUKUY_ENGINE) private readonly engine: Engine<PollerMap>,
    @Optional() @Inject(WATUKUY_OPTIONS) options?: WatukuyModuleOptions,
  ) {
    this.mode = options?.mode ?? 'daemon';
  }

  /**
   * Run the check. `key` is the property name in the terminus result (default `'watukuy'`).
   *
   * @example
   * const result = await indicator.isHealthy();
   * // { watukuy: { status: 'up', engineStatus: 'running', pollers: [...], reasons: [] } }
   */
  async isHealthy<const Key extends string = 'watukuy'>(
    key: Key = 'watukuy' as Key,
    options: WatukuyHealthOptions = {},
  ): Promise<WatukuyHealthIndicatorResult<Key>> {
    const report = await this.engine.inspect();
    const reasons: string[] = [];
    if (this.mode === 'daemon' && report.status !== 'running') {
      reasons.push(`engine status is '${report.status}'`);
    }
    const pollers: WatukuyPollerHealth[] = report.pollers.map((p) => {
      const label =
        p.partition === '' ? `'${p.poller}'` : `'${p.poller}' partition '${p.partition}'`;
      if (p.schedule.circuit === 'open' && !options.allowOpenCircuit) {
        reasons.push(`circuit open for ${label}`);
      }
      if (options.maxLagMs !== undefined && p.lagMs !== null && p.lagMs > options.maxLagMs) {
        reasons.push(`lag ${p.lagMs}ms exceeds ${options.maxLagMs}ms for ${label}`);
      }
      return {
        poller: p.poller,
        partition: p.partition,
        paused: p.paused,
        circuit: p.schedule.circuit,
        lagMs: p.lagMs,
        outboxPending: p.outboxPending,
        parked: p.parked,
        leaseOwner: p.lease?.owner ?? null,
      };
    });
    const data: WatukuyHealthData = {
      engineStatus: report.status,
      instanceId: report.instanceId,
      mode: this.mode,
      pollers,
      reasons,
    };
    const entry = { status: reasons.length === 0 ? ('up' as const) : ('down' as const), ...data };
    return { [key]: entry } as WatukuyHealthIndicatorResult<Key>;
  }
}
