import type { Logger } from '../core/ports.ts';

/** Log level recorded by the test logger. */
export type TestLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One recorded log call. `meta` is present only when the caller passed it. */
export interface TestLogEntry {
  level: TestLogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

/** A {@link Logger} that records instead of printing. */
export interface TestLogger extends Logger {
  /** Every call so far, in order. */
  readonly entries: TestLogEntry[];
  /** Entries at one level. */
  at(level: TestLogLevel): TestLogEntry[];
  /** Forget everything recorded so far. */
  clear(): void;
}

/**
 * Create a {@link Logger} that records every call into `entries` so tests can assert on what the
 * engine logged without capturing `console`.
 *
 * @example
 * const logger = createTestLogger();
 * logger.warn('lease lost', { epoch: 3 });
 * logger.entries; // [{ level: 'warn', message: 'lease lost', meta: { epoch: 3 } }]
 * logger.at('error').length; // 0
 */
export function createTestLogger(): TestLogger {
  const entries: TestLogEntry[] = [];
  const record = (level: TestLogLevel, message: string, meta?: Record<string, unknown>): void => {
    const entry: TestLogEntry = { level, message };
    if (meta !== undefined) entry.meta = meta;
    entries.push(entry);
  };
  return {
    entries,
    debug: (message, meta) => record('debug', message, meta),
    info: (message, meta) => record('info', message, meta),
    warn: (message, meta) => record('warn', message, meta),
    error: (message, meta) => record('error', message, meta),
    at: (level) => entries.filter((e) => e.level === level),
    clear: () => {
      entries.length = 0;
    },
  };
}
