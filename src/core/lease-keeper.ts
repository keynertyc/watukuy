import type { Clock, Logger } from './ports.ts';
import type { Lease, PKey, StateStore } from './store-types.ts';

/**
 * Renews a lease on a heartbeat while a cycle runs (PLAN §5.5). When a renewal fails the keeper
 * aborts the cycle's signal so in-memory work is discarded.
 */
export class LeaseKeeper {
  private handle: unknown = null;
  private stopped = false;
  lost = false;

  constructor(
    private readonly deps: {
      store: StateStore;
      clock: Clock;
      logger: Logger;
      key: PKey;
      lease: Lease;
      ttlMs: number;
      renewEveryMs: number;
      abort: AbortController;
    },
  ) {}

  start(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.handle = this.deps.clock.setTimeout(() => void this.beat(), this.deps.renewEveryMs);
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    try {
      const ok = await this.deps.store.renewLease(
        this.deps.key,
        this.deps.lease,
        this.deps.ttlMs,
        this.deps.clock.now(),
      );
      if (!ok) {
        this.lost = true;
        this.deps.logger.warn('lease renewal failed; aborting cycle', {
          poller: this.deps.key.poller,
          partition: this.deps.key.partition,
          epoch: this.deps.lease.epoch,
        });
        this.deps.abort.abort(new Error('watukuy: lease lost'));
        this.stop();
        return;
      }
      this.deps.lease.expiresAt = this.deps.clock.now() + this.deps.ttlMs;
    } catch (err) {
      this.deps.logger.warn('lease renewal threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.schedule();
  }

  /** Renew immediately (between pages). Returns false when the lease is gone. */
  async renewNow(): Promise<boolean> {
    if (this.stopped) return !this.lost;
    const ok = await this.deps.store.renewLease(
      this.deps.key,
      this.deps.lease,
      this.deps.ttlMs,
      this.deps.clock.now(),
    );
    if (!ok) {
      this.lost = true;
      this.deps.abort.abort(new Error('watukuy: lease lost'));
      this.stop();
    }
    return ok;
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) {
      this.deps.clock.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}
