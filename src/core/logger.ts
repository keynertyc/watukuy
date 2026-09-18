import type { Logger } from './ports.ts';

/** Default logger: `warn` and `error` to the console, `debug`/`info` dropped. */
export function defaultLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn(message, meta) {
      console.warn(`[watukuy] ${message}`, meta ?? '');
    },
    error(message, meta) {
      console.error(`[watukuy] ${message}`, meta ?? '');
    },
  };
}

/** A logger that drops everything. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Prefix every message and merge base metadata. */
export function childLogger(base: Logger, prefix: string, meta: Record<string, unknown>): Logger {
  const wrap =
    (fn: Logger['debug']) =>
    (message: string, extra?: Record<string, unknown>): void =>
      fn.call(base, `${prefix} ${message}`, extra ? { ...meta, ...extra } : meta);
  return {
    debug: wrap(base.debug),
    info: wrap(base.info),
    warn: wrap(base.warn),
    error: wrap(base.error),
  };
}
