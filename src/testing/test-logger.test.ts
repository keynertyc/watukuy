import { describe, expect, it } from 'vitest';
import type { Logger } from '../core/ports.ts';
import { createTestLogger } from './test-logger.ts';

describe('createTestLogger', () => {
  it('records every level in order with message and meta', () => {
    const logger = createTestLogger();
    logger.debug('d', { a: 1 });
    logger.info('i', { b: 2 });
    logger.warn('w', { c: 3 });
    logger.error('e', { d: 4 });
    expect(logger.entries).toEqual([
      { level: 'debug', message: 'd', meta: { a: 1 } },
      { level: 'info', message: 'i', meta: { b: 2 } },
      { level: 'warn', message: 'w', meta: { c: 3 } },
      { level: 'error', message: 'e', meta: { d: 4 } },
    ]);
  });

  it('omits the meta key entirely when none was passed', () => {
    const logger = createTestLogger();
    logger.info('plain');
    expect(logger.entries).toEqual([{ level: 'info', message: 'plain' }]);
    expect('meta' in (logger.entries[0] as object)).toBe(false);
  });

  it('filters by level with at()', () => {
    const logger = createTestLogger();
    logger.warn('one');
    logger.error('two');
    logger.warn('three');
    expect(logger.at('warn').map((e) => e.message)).toEqual(['one', 'three']);
    expect(logger.at('debug')).toEqual([]);
  });

  it('clear() empties entries in place', () => {
    const logger = createTestLogger();
    const ref = logger.entries;
    logger.error('x');
    logger.clear();
    expect(logger.entries).toHaveLength(0);
    expect(ref).toBe(logger.entries);
  });

  it('satisfies the Logger port and never prints', () => {
    const logger: Logger = createTestLogger();
    const original = console.warn;
    let printed = 0;
    console.warn = () => {
      printed++;
    };
    try {
      logger.warn('silent');
    } finally {
      console.warn = original;
    }
    expect(printed).toBe(0);
  });
});
