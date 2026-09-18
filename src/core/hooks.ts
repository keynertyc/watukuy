import type { Hooks, Logger } from './ports.ts';

type HookName = keyof Hooks;

const HOOK_NAMES: HookName[] = [
  'onPollStart',
  'onPollEnd',
  'onFetch',
  'onCommit',
  'onEvent',
  'onDelivered',
  'onRetry',
  'onParked',
  'onInvalid',
  'onError',
  'onLeaseAcquired',
  'onLeaseLost',
  'onCircuitOpen',
  'onCircuitClose',
  'onBudgetWait',
  'onScheduleChange',
];

type AnyHook = (ctx: never) => void | Promise<void>;

/**
 * Merge several hook sets into one. Every hook is awaited and errors are caught and logged so a
 * misbehaving observer can never affect the engine (see docs/observability.md).
 */
export function composeHooks(sets: Hooks[], logger: Logger): Required<Hooks> {
  const out: Partial<Record<HookName, (ctx: never) => Promise<void>>> = {};
  for (const name of HOOK_NAMES) {
    const fns = sets
      .map((s) => s[name] as AnyHook | undefined)
      .filter((f): f is AnyHook => typeof f === 'function');
    out[name] = async (ctx: never) => {
      for (const fn of fns) {
        try {
          await fn(ctx);
        } catch (err) {
          logger.warn(`hook ${name} threw`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
  }
  return out as Required<Hooks>;
}
