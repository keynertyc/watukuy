import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../stores/memory/index.ts';
import { VirtualClock } from '../testing/virtual-clock.ts';
import { toCloudEvent } from './cloudevents.ts';
import { definePoller } from './define-poller.ts';
import { formatDuration, parseDuration } from './duration.ts';
import { createWatukuy } from './engine.ts';
import {
  BudgetTimeoutError,
  ConfigError,
  HandlerError,
  HttpError,
  LeaseLostError,
  ReplayUnavailableError,
  StoreError,
  serializeError,
  ValidationError,
  WatukuyError,
} from './errors.ts';
import type { WatukuyEvent } from './event.ts';
import { composeHooks } from './hooks.ts';
import { LeaseKeeper } from './lease-keeper.ts';
import { childLogger, defaultLogger, silentLogger } from './logger.ts';
import type { Logger } from './ports.ts';

function recorder(): Logger & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = [];
  const mk = (level: string) => (message: string, meta?: Record<string, unknown>) =>
    void calls.push([level, message, meta]);
  return { calls, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

describe('duration', () => {
  it('parses numbers and unit strings, rejects garbage', () => {
    expect(parseDuration(250)).toBe(250);
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('3h')).toBe(10_800_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration(' 10 ms ')).toBe(10);
    expect(() => parseDuration(-1)).toThrow(ConfigError);
    expect(() => parseDuration(Number.NaN)).toThrow(ConfigError);
    expect(() => parseDuration('5x')).toThrow(/must look like/);
    expect(() => parseDuration('', 'schedule.min')).toThrow(/schedule.min/);
  });

  it('formats milliseconds compactly', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(90_000)).toBe('90s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('logger', () => {
  it('default logger only prints warn and error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = defaultLogger();
    log.debug('d');
    log.info('i');
    log.warn('w', { a: 1 });
    log.error('e');
    expect(warn).toHaveBeenCalledWith('[watukuy] w', { a: 1 });
    expect(error).toHaveBeenCalledWith('[watukuy] e', '');
    warn.mockRestore();
    error.mockRestore();
    expect(() => silentLogger.warn('x')).not.toThrow();
  });

  it('childLogger prefixes and merges metadata', () => {
    const base = recorder();
    const child = childLogger(base, '[orders]', { poller: 'orders' });
    child.warn('slow', { ms: 5 });
    child.debug('plain');
    expect(base.calls[0]).toEqual(['warn', '[orders] slow', { poller: 'orders', ms: 5 }]);
    expect(base.calls[1]).toEqual(['debug', '[orders] plain', { poller: 'orders' }]);
  });
});

describe('composeHooks', () => {
  it('runs every hook set and isolates throwing hooks', async () => {
    const log = recorder();
    const seen: string[] = [];
    const hooks = composeHooks(
      [
        { onPollStart: () => void seen.push('a') },
        {
          onPollStart: () => {
            throw new Error('bad hook');
          },
        },
        { onPollStart: async () => void seen.push('c') },
      ],
      log,
    );
    await hooks.onPollStart({
      poller: 'p',
      partition: '',
      lane: 'live',
      instanceId: 'i',
      startedAt: 0,
    });
    expect(seen).toEqual(['a', 'c']);
    expect(log.calls[0]?.[0]).toBe('warn');
    expect(log.calls[0]?.[1]).toMatch(/onPollStart threw/);
    await expect(
      hooks.onCircuitClose({ poller: 'p', partition: '', lane: 'live', instanceId: 'i' }),
    ).resolves.toBeUndefined();
  });
});

describe('errors', () => {
  it('serializeError handles Errors, watukuy codes, causes, and non-errors', () => {
    const inner = new Error('root');
    const wrapped = new HandlerError('e1', 2, inner);
    const s = serializeError(wrapped);
    expect(s).toMatchObject({
      name: 'HandlerError',
      code: 'HANDLER',
      cause: { name: 'Error', message: 'root' },
    });
    expect(s.stack).toBeDefined();
    expect(serializeError('boom')).toEqual({ name: 'NonError', message: 'boom' });
    expect(serializeError({ a: 1 })).toEqual({ name: 'NonError', message: '{"a":1}' });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(serializeError(cyc).message).toBe('[object Object]');
    // depth cap: 4 nested causes serialize at most 3 deep
    let e: Error = new Error('0');
    for (let i = 1; i < 6; i++) e = new Error(String(i), { cause: e });
    let depth = 0;
    for (let c = serializeError(e); c.cause; c = c.cause) depth++;
    expect(depth).toBe(3);
  });

  it('HttpError exposes throttle semantics and status', () => {
    const e429 = new HttpError({ status: 429, url: 'u', method: 'GET', retryAfterMs: 1000 });
    expect(e429.isThrottle).toBe(true);
    expect(serializeError(e429).status).toBe(429);
    expect(
      new HttpError({ status: 503, url: 'u', method: 'GET', retryAfterMs: 5 }).isThrottle,
    ).toBe(true);
    expect(new HttpError({ status: 503, url: 'u', method: 'GET' }).isThrottle).toBe(false);
    expect(
      new HttpError({ status: 500, url: 'u', method: 'GET', problem: { title: 'Down' } }).message,
    ).toMatch(/500: Down/);
  });

  it('error classes carry codes and fields', () => {
    expect(new LeaseLostError('p', 'x', 3)).toMatchObject({
      code: 'LEASE_LOST',
      poller: 'p',
      partition: 'x',
      epoch: 3,
    });
    expect(new ValidationError([{ message: 'a' }, { message: 'b' }]).message).toBe(
      'item failed schema validation: a; b',
    );
    expect(new ReplayUnavailableError('orders').message).toMatch(/log: \{ retention: '7d' \}/);
    expect(new BudgetTimeoutError('erp', 10)).toMatchObject({
      code: 'BUDGET_TIMEOUT',
      budget: 'erp',
    });
    expect(new StoreError('x', { cause: 1 }).cause).toBe(1);
    expect(new WatukuyError('UNSUPPORTED', 'm')).toBeInstanceOf(Error);
  });
});

describe('toCloudEvent', () => {
  it('maps the envelope and carries watukuy extensions', () => {
    const event: WatukuyEvent<{ id: string }> = {
      id: 'abc',
      type: 'updated',
      source: 'urn:watukuy:orders',
      subject: 'o1',
      time: '2026-01-01T00:00:00.000Z',
      poller: 'orders',
      partition: 't1',
      lane: 'live',
      sequence: 7,
      cursor: null,
      data: { id: 'o1' },
      previous: { id: 'o0' },
      attempt: 1,
    };
    expect(toCloudEvent(event)).toEqual({
      specversion: '1.0',
      id: 'abc',
      source: 'urn:watukuy:orders',
      type: 'orders.updated',
      subject: 'o1',
      time: '2026-01-01T00:00:00.000Z',
      datacontenttype: 'application/json',
      data: { id: 'o1' },
      watukuypartition: 't1',
      watukuylane: 'live',
      watukuysequence: 7,
      watukuypoller: 'orders',
      watukuyprevious: { id: 'o0' },
    });
    const { previous: _p, ...noPrev } = event;
    expect('watukuyprevious' in toCloudEvent(noPrev)).toBe(false);
  });
});

describe('LeaseKeeper', () => {
  function setup(renew: () => Promise<boolean>) {
    const clock = new VirtualClock();
    const store = new MemoryStore();
    vi.spyOn(store, 'renewLease').mockImplementation(renew);
    const abort = new AbortController();
    const logger = recorder();
    const lease = { owner: 'me', epoch: 1, expiresAt: clock.now() + 30_000 };
    const keeper = new LeaseKeeper({
      store,
      clock,
      logger,
      key: { poller: 'p', partition: '' },
      lease,
      ttlMs: 30_000,
      renewEveryMs: 10_000,
      abort,
    });
    return { clock, keeper, abort, logger, lease, store };
  }

  it('renews on the heartbeat and extends expiresAt', async () => {
    const s = setup(async () => true);
    s.keeper.start();
    expect(s.clock.pendingTimers()).toBe(1);
    await s.clock.advance(10_000);
    expect(s.lease.expiresAt).toBe(s.clock.now() + 30_000);
    expect(s.clock.pendingTimers()).toBe(1); // rescheduled
    s.keeper.stop();
    expect(s.clock.pendingTimers()).toBe(0);
    expect(await s.keeper.renewNow()).toBe(true); // stopped keeper reports not lost
  });

  it('aborts the cycle when a renewal fails', async () => {
    const s = setup(async () => false);
    s.keeper.start();
    await s.clock.advance(10_000);
    expect(s.keeper.lost).toBe(true);
    expect(s.abort.signal.aborted).toBe(true);
    expect(s.clock.pendingTimers()).toBe(0);
    expect(s.logger.calls.some(([, m]) => m.includes('lease renewal failed'))).toBe(true);
  });

  it('logs and keeps beating when the store throws; renewNow reports loss', async () => {
    let calls = 0;
    const s = setup(async () => {
      calls++;
      if (calls === 1) throw new Error('store down');
      return false;
    });
    s.keeper.start();
    await s.clock.advance(10_000);
    expect(s.logger.calls.some(([, m]) => m.includes('lease renewal threw'))).toBe(true);
    expect(s.clock.pendingTimers()).toBe(1);
    expect(await s.keeper.renewNow()).toBe(false);
    expect(s.keeper.lost).toBe(true);
    expect(s.abort.signal.aborted).toBe(true);
  });
});

describe('createWatukuy configuration', () => {
  const orders = definePoller({
    name: 'orders',
    identity: (o: { id: string }) => o.id,
    cursor: { strategy: 'page' },
    fetch: async () => ({ items: [] as { id: string }[] }),
  });

  it('validates options eagerly', () => {
    expect(() => createWatukuy(undefined as never)).toThrow(ConfigError);
    expect(() => createWatukuy({ pollers: { orders } } as never)).toThrow(/store is required/);
    expect(() => createWatukuy({ store: new MemoryStore(), pollers: 'x' as never })).toThrow(
      /pollers must be/,
    );
    expect(() => createWatukuy({ store: new MemoryStore(), pollers: { foo: orders } })).toThrow(
      /object key must equal/,
    );
    expect(() =>
      createWatukuy({ store: new MemoryStore(), pollers: { orders: {} as never } }),
    ).toThrow(/not a definePoller/);
    const budgeted = definePoller({
      name: 'b',
      budget: 'nope',
      cursor: { strategy: 'page' },
      fetch: async () => ({ items: [] as { id: string }[] }),
      identity: (o: { id: string }) => o.id,
    });
    expect(() => createWatukuy({ store: new MemoryStore(), pollers: { b: budgeted } })).toThrow(
      /unknown budget 'nope'/,
    );
    expect(() =>
      createWatukuy({
        store: new MemoryStore(),
        pollers: { orders },
        lease: { ttl: '10s', renewEvery: '10s' },
      }),
    ).toThrow(/renewEvery/);
  });

  it('enforces one consumer per poller and known names', async () => {
    const engine = createWatukuy({
      store: new MemoryStore(),
      pollers: { orders },
      hooks: {},
      instanceId: 'x',
    });
    expect(engine.instanceId).toBe('x');
    expect(engine.status).toBe('idle');
    const off = engine.on('orders', () => {});
    expect(() => engine.on('orders', () => {})).toThrow(/already has a handler/);
    expect(() => engine.subscribe('orders')).toThrow(/already has a consumer/);
    off();
    expect(() => engine.on('orders', 'x' as never)).toThrow(/must be a function/);
    engine.subscribe('orders');
    expect(() => engine.on('orders', () => {})).toThrow(/subscribe\(\) iterator/);
    expect(() => engine.on('nope' as never, () => {})).toThrow(/unknown poller/);
    await engine.stop();
    expect(engine.status).toBe('stopped');
  });

  it('applies sourcePrefix, generates instance ids, and start() is idempotent', async () => {
    const p = definePoller({
      name: 'p',
      identity: (o: { id: string }) => o.id,
      cursor: { strategy: 'page' },
      fetch: async () => ({ items: [] as { id: string }[] }),
    });
    const clock = new VirtualClock();
    const engine = createWatukuy({
      store: new MemoryStore(),
      pollers: { p },
      sourcePrefix: 'urn:acme:',
      clock,
    });
    expect(p.resolved.source).toBe('urn:acme:p');
    expect(engine.instanceId).toMatch(/^watukuy-[a-z0-9]{10}$/);
    await engine.start();
    await engine.start();
    expect(engine.status).toBe('running');
    await engine.stop({ drain: false });
    expect(engine.status).toBe('stopped');
    expect(clock.pendingTimers()).toBe(0);
  });
});
