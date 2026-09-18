import { ConfigError } from './errors.ts';

/**
 * A duration expressed either as milliseconds or as a compact string such as
 * `'250ms'`, `'5s'`, `'2m'`, `'6h'`, `'1d'`. Decimal values are accepted (`'1.5s'`).
 */
export type Duration =
  | number
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/;

/**
 * Parse a {@link Duration} into milliseconds.
 *
 * @example
 * parseDuration('5s')   // 5000
 * parseDuration(250)    // 250
 * @throws {ConfigError} when the value is negative, non-finite, or has an unknown unit.
 */
export function parseDuration(value: Duration | string, label = 'duration'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(
        `${label} must be a non-negative finite number of milliseconds, got ${value}`,
      );
    }
    return value;
  }
  const match = DURATION_RE.exec(value);
  if (!match) {
    throw new ConfigError(
      `${label} must look like '250ms', '5s', '2m', '6h' or '1d', got ${JSON.stringify(value)}`,
    );
  }
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2] as string] as number;
  return Math.round(amount * unit);
}

/** Format milliseconds as the most compact readable string (`5000` → `'5s'`). Used in logs. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms % 86_400_000 === 0 && ms !== 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0 && ms !== 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms !== 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
