import type { SerializedError } from './errors.ts';
import type { WatukuyEvent } from './event.ts';
import type { Lane, PollSummary } from './poller-types.ts';
import type { Lease, ParkedRow, PKey } from './store-types.ts';

/** Time source. Injectable so the whole engine is deterministic under test (PLAN G8). */
export interface Clock {
  /** Current epoch milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Randomness source in `[0, 1)`. Injectable for deterministic jitter under test. */
export interface Random {
  next(): number;
}

/** Minimal logger port. Defaults to `console` at `warn`/`error` only. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface HookContext extends PKey {
  lane: Lane;
  instanceId: string;
}

/**
 * Lifecycle hooks (PLAN §5.13). All optional, may be sync or async; errors thrown by hooks are
 * logged and never affect the engine. Multiple hook sets compose (`hooks: [otelHooks(), mine]`).
 */
export interface Hooks {
  onPollStart?(ctx: HookContext & { startedAt: number }): void | Promise<void>;
  onPollEnd?(ctx: HookContext & { summary: PollSummary }): void | Promise<void>;
  onFetch?(
    ctx: HookContext & { page: number; durationMs: number; items: number; notModified: boolean },
  ): void | Promise<void>;
  onCommit?(
    ctx: HookContext & { events: number; upserts: number; deletes: number; durationMs: number },
  ): void | Promise<void>;
  onEvent?(ctx: HookContext & { event: WatukuyEvent<unknown> }): void | Promise<void>;
  onDelivered?(
    ctx: HookContext & { event: WatukuyEvent<unknown>; attempt: number; durationMs: number },
  ): void | Promise<void>;
  onRetry?(
    ctx: HookContext & {
      event: WatukuyEvent<unknown>;
      attempt: number;
      error: SerializedError;
      delayMs: number;
    },
  ): void | Promise<void>;
  onParked?(ctx: HookContext & { row: ParkedRow }): void | Promise<void>;
  onInvalid?(
    ctx: HookContext & { item: unknown; issues: ReadonlyArray<{ message: string }> },
  ): void | Promise<void>;
  onError?(
    ctx: HookContext & {
      error: SerializedError;
      phase: 'fetch' | 'commit' | 'dispatch' | 'lease' | 'schedule';
    },
  ): void | Promise<void>;
  onLeaseAcquired?(ctx: HookContext & { lease: Lease }): void | Promise<void>;
  onLeaseLost?(ctx: HookContext & { epoch: number }): void | Promise<void>;
  onCircuitOpen?(ctx: HookContext & { failures: number; probeAt: number }): void | Promise<void>;
  onCircuitClose?(ctx: HookContext): void | Promise<void>;
  onBudgetWait?(ctx: HookContext & { budget: string; waitMs: number }): void | Promise<void>;
  onScheduleChange?(
    ctx: HookContext & { intervalMs: number; nextDueAt: number; reason: string },
  ): void | Promise<void>;
}
