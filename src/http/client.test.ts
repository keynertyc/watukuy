import { describe, expect, it, type Mock, vi } from 'vitest';
import { BudgetTimeoutError, HttpError, type RateLimitInfo } from '../core/errors.ts';
import { hashUrl } from '../core/hash.ts';
import type { Clock, Logger } from '../core/ports.ts';
import type { Validator } from '../core/store-types.ts';
import {
  buildRequestUrl,
  createHttpClient,
  type HttpClientDeps,
  MAX_ERROR_BODY_BYTES,
} from './client.ts';

const START = 1_700_000_000_000;
const BASE = 'https://api.example.com/items';

interface FakeClock extends Clock {
  advance(ms: number): void;
  pending(): number;
}

function createFakeClock(start = START): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function createLogger(): Logger & { debug: Mock<Logger['debug']>; warn: Mock<Logger['warn']> } {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Headers;
}

type Handler = (call: FetchCall) => Response | Promise<Response>;

/**
 * Deterministic `fetch` double. Records calls, honours `init.signal` (rejects with its reason,
 * like the real thing) and resolves `nextCall()` once the client has actually invoked fetch.
 */
function createFakeFetch(handler: Handler) {
  const calls: FetchCall[] = [];
  let waiters: Array<{ count: number; resolve: () => void }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestInit = init ?? {};
    const call: FetchCall = { url, init: requestInit, headers: new Headers(requestInit.headers) };
    calls.push(call);
    waiters = waiters.filter((waiter) => {
      if (calls.length < waiter.count) return true;
      waiter.resolve();
      return false;
    });
    const signal = requestInit.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    return await new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => handler(call))
        .then(
          (response) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(response);
          },
          (error: unknown) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
    });
  });
  return {
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    calls,
    mock: fetchImpl,
    /** Resolves once fetch has been invoked `count` times (immediately if it already has). */
    nextCall: (count = 1) =>
      calls.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function createMemoryValidators() {
  const map = new Map<string, Validator>();
  return {
    map,
    get: vi.fn(async (hash: string) => map.get(hash) ?? null),
    set: vi.fn(async (hash: string, v: Validator) => {
      map.set(hash, v);
    }),
  };
}

function setup(handler: Handler, overrides: Partial<HttpClientDeps> = {}) {
  const clock = createFakeClock();
  const logger = createLogger();
  const fetch = createFakeFetch(handler);
  const deps: HttpClientDeps = { fetch: fetch.fetch, clock, logger, defaultCost: 1, ...overrides };
  return { client: createHttpClient(deps), clock, logger, fetch, deps };
}

describe('buildRequestUrl', () => {
  it('appends query entries, repeats arrays and skips undefined/null', () => {
    const url = buildRequestUrl(BASE, {
      a: 1,
      b: ['x', 'y', undefined, null],
      c: undefined,
      d: null,
      e: true,
      f: 'sp ace',
    });
    expect(url).toBe(`${BASE}?a=1&b=x&b=y&e=true&f=sp+ace`);
  });

  it('preserves an existing query string and accepts URL instances', () => {
    expect(buildRequestUrl(new URL(`${BASE}?page=2`), { limit: 10 })).toBe(
      `${BASE}?page=2&limit=10`,
    );
    expect(buildRequestUrl(BASE)).toBe(BASE);
  });

  it('rejects relative URLs', () => {
    expect(() => buildRequestUrl('/relative')).toThrow(TypeError);
  });
});

describe('createHttpClient', () => {
  describe('request building', () => {
    it('builds the final URL with query and sends default user-agent and accept', async () => {
      const { client, fetch } = setup(() => json({ ok: true }));
      const res = await client.get(BASE, { query: { page: 2, tags: ['a', 'b'], skip: undefined } });
      expect(fetch.calls).toHaveLength(1);
      const call = fetch.calls[0]!;
      expect(call.url).toBe(`${BASE}?page=2&tags=a&tags=b`);
      expect(res.url).toBe(`${BASE}?page=2&tags=a&tags=b`);
      expect(call.init.method).toBe('GET');
      expect(call.headers.get('user-agent')).toBe('watukuy');
      expect(call.headers.get('accept')).toBe('application/json');
    });

    it('lets the caller override user-agent and accept and set a custom default UA', async () => {
      const { client, fetch } = setup(() => json({}), { userAgent: 'my-app/1.0' });
      await client.get(BASE);
      expect(fetch.calls[0]!.headers.get('user-agent')).toBe('my-app/1.0');
      await client.get(BASE, { headers: { 'User-Agent': 'custom', Accept: 'text/csv' } });
      expect(fetch.calls[1]!.headers.get('user-agent')).toBe('custom');
      expect(fetch.calls[1]!.headers.get('accept')).toBe('text/csv');
    });

    it('request() forwards method and body, upper-casing the method', async () => {
      const { client, fetch } = setup(() => json({ id: 1 }, { status: 201 }));
      const res = await client.request(BASE, {
        method: 'post',
        body: '{"name":"x"}',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(201);
      expect(fetch.calls[0]!.init.method).toBe('POST');
      expect(fetch.calls[0]!.init.body).toBe('{"name":"x"}');
    });
  });

  describe('budget charging', () => {
    it('charges the default cost before calling fetch', async () => {
      const order: string[] = [];
      const charge = vi.fn(async (cost: number) => {
        order.push(`charge:${cost}`);
      });
      const { client } = setup(
        () => {
          order.push('fetch');
          return json({});
        },
        { charge, defaultCost: 2 },
      );
      await client.get(BASE);
      expect(order).toEqual(['charge:2', 'fetch']);
    });

    it('uses the explicit cost and skips charging when cost is 0', async () => {
      const charge = vi.fn(async () => {});
      const { client } = setup(() => json({}), { charge });
      await client.get(BASE, { cost: 5 });
      expect(charge).toHaveBeenCalledWith(5);
      charge.mockClear();
      await client.get(BASE, { cost: 0 });
      expect(charge).not.toHaveBeenCalled();
    });

    it('propagates BudgetTimeoutError without calling fetch', async () => {
      const charge = vi.fn(async () => {
        throw new BudgetTimeoutError('api', 1000);
      });
      const { client, fetch } = setup(() => json({}), { charge });
      await expect(client.get(BASE)).rejects.toBeInstanceOf(BudgetTimeoutError);
      expect(fetch.mock).not.toHaveBeenCalled();
    });
  });

  describe('validators', () => {
    it('sends If-None-Match / If-Modified-Since from the store and stores new ones on 2xx', async () => {
      const validators = createMemoryValidators();
      const url = `${BASE}?page=1`;
      const hash = await hashUrl(url);
      validators.map.set(hash, {
        etag: '"v1"',
        lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        storedAt: 1,
      });
      const { client, fetch, clock } = setup(() => json([], { headers: { ETag: '"v2"' } }), {
        validators,
      });
      const res = await client.get(BASE, { query: { page: 1 } });
      expect(res.ok).toBe(true);
      expect(validators.get).toHaveBeenCalledWith(hash);
      const headers = fetch.calls[0]!.headers;
      expect(headers.get('if-none-match')).toBe('"v1"');
      expect(headers.get('if-modified-since')).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
      expect(validators.set).toHaveBeenCalledWith(hash, {
        etag: '"v2"',
        lastModified: null,
        storedAt: clock.now(),
      });
    });

    it('does not override caller-provided conditional headers', async () => {
      const validators = createMemoryValidators();
      validators.map.set(await hashUrl(BASE), {
        etag: '"stored"',
        lastModified: null,
        storedAt: 1,
      });
      const { client, fetch } = setup(() => json([]), { validators });
      await client.get(BASE, { headers: { 'If-None-Match': '"mine"' } });
      expect(fetch.calls[0]!.headers.get('if-none-match')).toBe('"mine"');
    });

    it('does not store validators when the response has none', async () => {
      const validators = createMemoryValidators();
      const { client } = setup(() => json([]), { validators });
      await client.get(BASE);
      expect(validators.set).not.toHaveBeenCalled();
    });

    it('skips validators for non-GET methods by default and honours validators: false/true', async () => {
      const validators = createMemoryValidators();
      const { client } = setup(() => json([], { headers: { ETag: '"x"' } }), { validators });
      await client.request(BASE, { method: 'POST' });
      expect(validators.get).not.toHaveBeenCalled();
      await client.get(BASE, { validators: false });
      expect(validators.get).not.toHaveBeenCalled();
      await client.request(BASE, { method: 'POST', validators: true });
      expect(validators.get).toHaveBeenCalledTimes(1);
      await client.request(BASE, { method: 'HEAD' });
      expect(validators.get).toHaveBeenCalledTimes(2);
    });

    it('treats store failures as best-effort and logs a warning', async () => {
      const validators = {
        get: vi.fn(async () => {
          throw new Error('db down');
        }),
        set: vi.fn(async () => {
          throw new Error('db down');
        }),
      };
      const { client, logger } = setup(() => json([], { headers: { ETag: '"x"' } }), {
        validators,
      });
      const res = await client.get(BASE);
      expect(res.ok).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('304 Not Modified', () => {
    it('returns notModified with ok=true and rejects body access', async () => {
      const validators = createMemoryValidators();
      const { client } = setup(
        () => new Response(null, { status: 304, headers: { ETag: '"a"' } }),
        {
          validators,
        },
      );
      const res = await client.get(BASE);
      expect(res.status).toBe(304);
      expect(res.ok).toBe(true);
      expect(res.notModified).toBe(true);
      await expect(res.json()).rejects.toThrow(/no body on 304/);
      await expect(res.text()).rejects.toThrow(/no body on 304/);
      await expect(res.arrayBuffer()).rejects.toThrow(/no body on 304/);
      expect(validators.set).not.toHaveBeenCalled();
    });
  });

  describe('non-2xx responses', () => {
    const NOW = START;

    it('throws HttpError with status, url, method, retryAfterMs, rateLimit, problem and bodyText', async () => {
      const body = JSON.stringify({ title: 'Too Many Requests', status: 429, detail: 'slow down' });
      const { client } = setup(
        () =>
          new Response(body, {
            status: 429,
            headers: {
              'content-type': 'application/problem+json',
              'Retry-After': '120',
              RateLimit: '"default";r=0;t=120',
              'RateLimit-Policy': '"default";q=100;w=60',
            },
          }),
      );
      const err = await client.get(BASE, { query: { q: 'x' } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      const httpError = err as HttpError;
      expect(httpError.status).toBe(429);
      expect(httpError.url).toBe(`${BASE}?q=x`);
      expect(httpError.method).toBe('GET');
      expect(httpError.retryAfterMs).toBe(120_000);
      expect(httpError.rateLimit).toEqual({
        source: 'ietf',
        limit: 100,
        remaining: 0,
        resetAt: NOW + 120_000,
        policy: '"default";q=100;w=60',
      });
      expect(httpError.problem).toEqual({
        title: 'Too Many Requests',
        status: 429,
        detail: 'slow down',
      });
      expect(httpError.bodyText).toBe(body);
      expect(httpError.isThrottle).toBe(true);
      expect(httpError.message).toContain('Too Many Requests');
    });

    it('parses an HTTP-date Retry-After relative to the injected clock', async () => {
      const { client, clock } = setup(
        () =>
          new Response('busy', {
            status: 503,
            headers: { 'Retry-After': new Date(clock.now() + 30_000).toUTCString() },
          }),
      );
      const err = (await client.get(BASE).catch((e: unknown) => e)) as HttpError;
      expect(err.retryAfterMs).toBe(30_000);
      expect(err.isThrottle).toBe(true);
    });

    it('returns the response when throwOnError is false', async () => {
      const { client } = setup(
        () => new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } }),
      );
      const res = await client.get(BASE, { throwOnError: false });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
      expect(res.notModified).toBe(false);
      await expect(res.text()).resolves.toBe('nope');
      const buffer = await res.arrayBuffer();
      expect(new TextDecoder().decode(buffer)).toBe('nope');
    });

    it('caps the captured error body at 64 KiB', async () => {
      const huge = 'x'.repeat(MAX_ERROR_BODY_BYTES + 10_000);
      const { client } = setup(() => new Response(huge, { status: 500 }));
      const err = (await client.get(BASE).catch((e: unknown) => e)) as HttpError;
      expect(err.bodyText).toHaveLength(MAX_ERROR_BODY_BYTES);
    });

    it('handles error responses without a body', async () => {
      const { client } = setup(() => new Response(null, { status: 404 }));
      const err = (await client.get(BASE).catch((e: unknown) => e)) as HttpError;
      expect(err.status).toBe(404);
      expect(err.bodyText).toBe('');
      expect(err.problem).toBeUndefined();
      expect(err.retryAfterMs).toBeUndefined();
    });
  });

  describe('rate-limit reporting', () => {
    it('invokes onRateLimit with parsed info and exposes it on the response', async () => {
      const onRateLimit = vi.fn<(info: RateLimitInfo) => void>();
      const { client, clock } = setup(
        () =>
          json([], {
            headers: {
              'X-RateLimit-Limit': '60',
              'X-RateLimit-Remaining': '59',
              'X-RateLimit-Reset': '30',
            },
          }),
        { onRateLimit },
      );
      const res = await client.get(BASE);
      const expected: RateLimitInfo = {
        source: 'vendor',
        limit: 60,
        remaining: 59,
        resetAt: clock.now() + 30_000,
      };
      expect(res.rateLimit).toEqual(expected);
      expect(onRateLimit).toHaveBeenCalledWith(expected);
    });

    it('does not invoke onRateLimit when no headers are present', async () => {
      const onRateLimit = vi.fn();
      const { client } = setup(() => json([]), { onRateLimit });
      const res = await client.get(BASE);
      expect(res.rateLimit).toBeNull();
      expect(onRateLimit).not.toHaveBeenCalled();
    });

    it('reports rate-limit info from error responses too', async () => {
      const onRateLimit = vi.fn();
      const { client } = setup(
        () => new Response('', { status: 429, headers: { 'X-RateLimit-Remaining': '0' } }),
        { onRateLimit },
      );
      await expect(client.get(BASE)).rejects.toBeInstanceOf(HttpError);
      expect(onRateLimit).toHaveBeenCalledWith({ source: 'vendor', remaining: 0 });
    });
  });

  describe('signals and timeouts', () => {
    it('aborts with a TimeoutError driven by the injected clock and clears the timer', async () => {
      const { client, fetch, clock } = setup(() => new Promise<Response>(() => {}));
      const pending = client.get(BASE, { timeout: '5s' });
      await fetch.nextCall();
      expect(clock.pending()).toBe(1);
      clock.advance(5_000);
      const err = (await pending.catch((e: unknown) => e)) as Error;
      expect(err.name).toBe('TimeoutError');
      expect(err.message).toBe('watukuy: request timed out after 5000ms');
      expect(clock.pending()).toBe(0);
    });

    it('applies defaultTimeoutMs when no per-request timeout is given', async () => {
      const { client, fetch, clock } = setup(() => new Promise<Response>(() => {}), {
        defaultTimeoutMs: 250,
      });
      const pending = client.get(BASE);
      await fetch.nextCall();
      clock.advance(250);
      await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('clears the timeout timer after a successful response', async () => {
      const { client, clock } = setup(() => json([]), { defaultTimeoutMs: 1000 });
      await client.get(BASE);
      expect(clock.pending()).toBe(0);
    });

    it('does not create a timer when no timeout is configured', async () => {
      const { client, clock } = setup(() => json([]));
      await client.get(BASE);
      expect(clock.pending()).toBe(0);
    });

    it('propagates a parent (poll cycle) abort with its reason', async () => {
      const parent = new AbortController();
      const { client, fetch } = setup(() => new Promise<Response>(() => {}), {
        signal: parent.signal,
      });
      const pending = client.get(BASE, { timeout: 60_000 });
      await fetch.nextCall();
      const reason = new Error('cycle aborted');
      parent.abort(reason);
      await expect(pending).rejects.toBe(reason);
    });

    it('propagates a per-request signal abort', async () => {
      const controller = new AbortController();
      const { client, fetch } = setup(() => new Promise<Response>(() => {}));
      const pending = client.get(BASE, { signal: controller.signal });
      await fetch.nextCall();
      controller.abort('stop');
      await expect(pending).rejects.toBe('stop');
    });

    it('fails fast before charging when the parent signal is already aborted', async () => {
      const parent = new AbortController();
      parent.abort(new Error('already'));
      const charge = vi.fn(async () => {});
      const { client, fetch } = setup(() => json([]), { signal: parent.signal, charge });
      await expect(client.get(BASE)).rejects.toThrow('already');
      expect(charge).not.toHaveBeenCalled();
      expect(fetch.mock).not.toHaveBeenCalled();
    });
  });

  describe('network errors and logging', () => {
    it('propagates fetch errors unwrapped and logs at debug with redacted headers', async () => {
      const failure = new TypeError('fetch failed');
      const { client, logger } = setup(() => {
        throw failure;
      });
      await expect(
        client.get(BASE, { headers: { Authorization: 'Bearer secret', 'X-Trace': 't1' } }),
      ).rejects.toBe(failure);
      expect(logger.debug).toHaveBeenCalledTimes(1);
      const meta = logger.debug.mock.calls[0]![1] as Record<string, unknown>;
      expect(meta).toMatchObject({ method: 'GET', url: BASE, durationMs: 0 });
      expect(meta.headers).toMatchObject({ authorization: '***', 'x-trace': 't1' });
    });

    it('logs method, url, status and duration on success and redacts configured headers', async () => {
      const { client, logger } = setup(
        () => {
          return json([]);
        },
        { redactHeaders: ['x-secret'] },
      );
      await client.get(BASE, { query: { a: 1 }, headers: { 'X-Secret': 's', 'X-Public': 'p' } });
      const [message, meta] = logger.debug.mock.calls[0]! as [string, Record<string, unknown>];
      expect(message).toBe('watukuy: http response');
      expect(meta).toMatchObject({
        method: 'GET',
        url: `${BASE}?a=1`,
        status: 200,
        notModified: false,
      });
      expect(typeof meta.durationMs).toBe('number');
      expect(meta.headers).toMatchObject({ 'x-secret': '***', 'x-public': 'p' });
    });

    it('measures duration with the injected clock', async () => {
      const clock = createFakeClock();
      const logger = createLogger();
      const fetch = createFakeFetch(() => {
        clock.advance(42);
        return json([]);
      });
      const client = createHttpClient({ fetch: fetch.fetch, clock, logger, defaultCost: 1 });
      await client.get(BASE);
      const meta = logger.debug.mock.calls[0]![1] as Record<string, unknown>;
      expect(meta.durationMs).toBe(42);
    });
  });

  describe('response body', () => {
    it('json() parses once and caches; text() shares the cache', async () => {
      const { client } = setup(() => json({ a: 1 }));
      const res = await client.get(BASE);
      const first = await res.json<{ a: number }>();
      const second = await res.json<{ a: number }>();
      expect(first).toEqual({ a: 1 });
      expect(second).toEqual({ a: 1 });
      expect(res.raw.bodyUsed).toBe(true);
      await expect(res.text()).resolves.toBe('{"a":1}');
      const buffer = await res.arrayBuffer();
      expect(new TextDecoder().decode(buffer)).toBe('{"a":1}');
    });

    it('arrayBuffer() reads the raw body when nothing was read before', async () => {
      const { client } = setup(() => new Response('bytes', { status: 200 }));
      const res = await client.get(BASE);
      expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('bytes');
    });

    it('exposes headers and the raw Response', async () => {
      const { client } = setup(() => json([], { headers: { 'X-Custom': 'yes' } }));
      const res = await client.get(BASE);
      expect(res.headers.get('x-custom')).toBe('yes');
      expect(res.raw).toBeInstanceOf(Response);
    });
  });
});
