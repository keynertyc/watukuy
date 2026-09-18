import { parseDuration } from '../core/duration.ts';
import type { BudgetConfig } from '../core/engine-types.ts';
import { ConfigError } from '../core/errors.ts';
import type { BudgetPolicy } from '../core/store-types.ts';

/** A {@link BudgetPolicy} with the manager-level knobs resolved (PLAN §5.7). */
export interface ResolvedBudgetPolicy extends BudgetPolicy {
  /** How waiters sharing the budget are ordered once lane priority ties. */
  fairness: 'round-robin' | 'weighted';
  /**
   * Longest wait for tokens before `acquire` rejects with `BudgetTimeoutError`. `null` when the
   * config did not set `maxWait`; the engine then substitutes the poller's `schedule.max`.
   */
  maxWaitMs: number | null;
}

/**
 * Convert a user {@link BudgetConfig} (durations as strings) into a millisecond policy, applying
 * defaults (`burst = requests`, `fairness = 'round-robin'`) and validating eagerly.
 *
 * @example
 * resolveBudgetPolicy('erp', { requests: 100, per: '1m' });
 * // { requests: 100, perMs: 60_000, burst: 100, fairness: 'round-robin', maxWaitMs: null }
 * @throws {ConfigError} when `requests < 1`, `per <= 0`, `burst < 1`, or `fairness` is unknown.
 */
export function resolveBudgetPolicy(name: string, config: BudgetConfig): ResolvedBudgetPolicy {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError('budget name must be a non-empty string');
  }
  if (!config || typeof config !== 'object') {
    throw new ConfigError(`budget '${name}': config must be an object`);
  }
  const { requests } = config;
  if (typeof requests !== 'number' || !Number.isFinite(requests) || requests < 1) {
    throw new ConfigError(`budget '${name}': requests must be a finite number >= 1`);
  }
  const perMs = parseDuration(config.per, `budget '${name}' per`);
  if (perMs <= 0) throw new ConfigError(`budget '${name}': per must be > 0`);

  const burst = config.burst ?? requests;
  if (typeof burst !== 'number' || !Number.isFinite(burst) || burst < 1) {
    throw new ConfigError(`budget '${name}': burst must be a finite number >= 1`);
  }

  const fairness = config.fairness ?? 'round-robin';
  if (fairness !== 'round-robin' && fairness !== 'weighted') {
    throw new ConfigError(
      `budget '${name}': fairness must be 'round-robin' or 'weighted', got ${JSON.stringify(fairness)}`,
    );
  }

  const maxWaitMs =
    config.maxWait === undefined ? null : parseDuration(config.maxWait, `budget '${name}' maxWait`);

  return { requests, perMs, burst, fairness, maxWaitMs };
}
