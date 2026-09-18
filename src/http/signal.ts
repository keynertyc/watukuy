import type { Clock } from '../core/ports.ts';

/** A composed abort signal plus the cleanup that releases its listeners and timer. */
export interface ComposedAbortSignal {
  signal: AbortSignal;
  /** Clear the timeout timer and detach listeners from the parent signals. Idempotent. */
  dispose(): void;
}

/** Inputs for {@link composeAbortSignal}. */
export interface ComposeAbortSignalOptions {
  /** Parent signals; `undefined` entries are skipped. */
  signals?: ReadonlyArray<AbortSignal | undefined> | undefined;
  /** Timeout in milliseconds driven by `clock.setTimeout`. `undefined` disables the timeout. */
  timeoutMs?: number | undefined;
  /** Clock used for the timeout so tests can drive it deterministically. */
  clock: Clock;
  /** Force (`true`) or bypass (`false`) `AbortSignal.any`. Defaults to feature detection. */
  useAny?: boolean | undefined;
}

/**
 * Build the error used as abort reason when a request exceeds its timeout.
 * The error is named `'TimeoutError'` so callers can distinguish it from user aborts.
 */
export function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`watukuy: request timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Compose zero or more parent signals and an optional clock-driven timeout into a single
 * `AbortSignal`. Uses `AbortSignal.any` when available, otherwise manual listeners.
 *
 * Returns `undefined` when there is nothing to compose (no parents, no timeout). A single parent
 * without timeout is returned as-is. The abort `reason` is always the reason of whichever source
 * aborted first; on timeout it is a {@link createTimeoutError}.
 */
export function composeAbortSignal(
  options: ComposeAbortSignalOptions,
): ComposedAbortSignal | undefined {
  const sources = (options.signals ?? []).filter((s): s is AbortSignal => s !== undefined);
  const { timeoutMs, clock } = options;

  if (timeoutMs === undefined) {
    const only = sources[0];
    if (only === undefined) return undefined;
    if (sources.length === 1) return { signal: only, dispose: noop };
  }

  let clearTimer: () => void = noop;
  if (timeoutMs !== undefined) {
    const timeoutController = new AbortController();
    sources.push(timeoutController.signal);
    const handle = clock.setTimeout(
      () => timeoutController.abort(createTimeoutError(timeoutMs)),
      timeoutMs,
    );
    clearTimer = () => clock.clearTimeout(handle);
  }

  const useAny = options.useAny ?? typeof AbortSignal.any === 'function';
  let signal: AbortSignal;
  let detach: () => void = noop;
  if (useAny) {
    signal = AbortSignal.any(sources);
  } else {
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    for (const source of sources) {
      if (source.aborted) {
        controller.abort(source.reason);
        break;
      }
      const onAbort = () => controller.abort(source.reason);
      source.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => source.removeEventListener('abort', onAbort));
    }
    signal = controller.signal;
    detach = () => {
      for (const cleanup of cleanups) cleanup();
    };
  }

  let disposed = false;
  return {
    signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      detach();
    },
  };
}

function noop(): void {}
