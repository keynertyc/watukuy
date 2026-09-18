import { describe, expect, it, type Mock, vi } from 'vitest';
import { toCloudEvent } from '../core/cloudevents.ts';
import { ConfigError, HttpError } from '../core/errors.ts';
import type { HandlerContext, WatukuyEvent } from '../core/event.ts';
import type { Logger } from '../core/ports.ts';
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  decodeWebhookSecret,
  MAX_WEBHOOK_ERROR_BODY_CHARS,
  signWebhook,
  verifyWebhookSignature,
  WebhookDeliveryError,
  webhookSink,
} from './webhook.ts';

interface Order {
  id: string;
  total: number;
}

const NOW_MS = 1_758_196_800_000; // 2025-09-18T12:00:00Z
const NOW_SEC = String(Math.floor(NOW_MS / 1000));
const URL_ = 'https://receiver.example.com/hooks/orders';
const RAW_SECRET = 'correct horse battery staple';
// whsec_ + base64 of 24 random-looking bytes.
const PREFIXED_SECRET = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD';

function makeEvent(overrides: Partial<WatukuyEvent<Order>> = {}): WatukuyEvent<Order> {
  return {
    id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    type: 'updated',
    source: 'urn:watukuy:orders',
    subject: 'ord_1',
    time: '2025-09-18T11:59:59.000Z',
    poller: 'orders',
    partition: '',
    lane: 'live',
    sequence: 7,
    cursor: { value: '2025-09-18T11:59:00Z' },
    data: { id: 'ord_1', total: 42 },
    attempt: 1,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(
  signal = new AbortController().signal,
): HandlerContext & { ack: Mock<() => void> } {
  return {
    signal,
    logger: makeLogger(),
    partition: { key: '', data: undefined },
    attempt: 1,
    ack: vi.fn(),
  };
}

/** Await a handler result (sync or async) and return what it rejected with, if anything. */
async function rejection(run: void | Promise<void>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error;
  }
}

interface Captured {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: string;
}

function createFetch(
  respond: (call: Captured) => Response | Promise<Response> = () =>
    new Response(null, { status: 200 }),
): { calls: Captured[]; fetch: typeof globalThis.fetch } {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Captured = {
      url: String(input),
      init: init ?? {},
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, fetch: fetchImpl as unknown as typeof globalThis.fetch };
}

const clock = { now: () => NOW_MS };

/** Independent HMAC-SHA256 → base64, computed straight from Web Crypto to cross-check the sink. */
async function expectedSignature(
  secretBytes: Uint8Array<ArrayBuffer>,
  content: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content)),
  );
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('webhookSink', () => {
  it('posts a CloudEvents body with Standard Webhooks headers and a cross-checked signature', async () => {
    const { calls, fetch } = createFetch();
    const sink = webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock });
    const event = makeEvent();
    const ctx = makeCtx();

    await sink(event, ctx);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/cloudevents+json');
    expect(JSON.parse(call.body)).toEqual(toCloudEvent(event));
    expect(call.headers['webhook-id']).toBe(event.id);
    expect(call.headers['webhook-timestamp']).toBe(NOW_SEC);
    expect(call.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);

    const expected = await expectedSignature(
      new TextEncoder().encode(RAW_SECRET),
      `${event.id}.${NOW_SEC}.${call.body}`,
    );
    expect(call.headers['webhook-signature']).toBe(expected);
    expect(ctx.ack).toHaveBeenCalledTimes(1);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('produces a signature that verifyWebhookSignature accepts and tampering rejects', async () => {
    const { calls, fetch } = createFetch();
    await webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock })(
      makeEvent(),
      makeCtx(),
    );
    const { headers, body } = calls[0]!;
    const base = {
      secret: RAW_SECRET,
      id: headers['webhook-id']!,
      timestamp: headers['webhook-timestamp']!,
      body,
      signatureHeader: headers['webhook-signature']!,
      now: NOW_MS,
    };

    await expect(verifyWebhookSignature(base)).resolves.toBe(true);
    await expect(verifyWebhookSignature({ ...base, body: `${body} ` })).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({ ...base, timestamp: String(Number(base.timestamp) + 1) }),
    ).resolves.toBe(false);
    await expect(verifyWebhookSignature({ ...base, secret: 'wrong secret' })).resolves.toBe(false);
    await expect(verifyWebhookSignature({ ...base, id: 'other-id' })).resolves.toBe(false);
  });

  it('accepts whsec_ prefixed secrets and raw secrets, decoding each correctly', async () => {
    const prefixed = createFetch();
    await webhookSink<Order>({ url: URL_, secret: PREFIXED_SECRET, fetch: prefixed.fetch, clock })(
      makeEvent(),
      makeCtx(),
    );
    const pCall = prefixed.calls[0]!;
    const decoded = decodeWebhookSecret(PREFIXED_SECRET);
    expect(decoded).toHaveLength(24);
    expect(pCall.headers['webhook-signature']).toBe(
      await expectedSignature(decoded, `${pCall.headers['webhook-id']}.${NOW_SEC}.${pCall.body}`),
    );
    await expect(
      verifyWebhookSignature({
        secret: PREFIXED_SECRET,
        id: pCall.headers['webhook-id']!,
        timestamp: NOW_SEC,
        body: pCall.body,
        signatureHeader: pCall.headers['webhook-signature']!,
        now: NOW_MS,
      }),
    ).resolves.toBe(true);

    // A raw secret and its whsec_ base64 form are the same key bytes → identical signatures.
    const rawBytes = new TextEncoder().encode(RAW_SECRET);
    const asPrefixed = `whsec_${base64(rawBytes)}`;
    expect(decodeWebhookSecret(RAW_SECRET)).toEqual(rawBytes);
    expect(decodeWebhookSecret(asPrefixed)).toEqual(rawBytes);
    const sigRaw = await signWebhook({ secret: RAW_SECRET, id: 'id', timestamp: 1, body: '{}' });
    const sigPrefixed = await signWebhook({
      secret: asPrefixed,
      id: 'id',
      timestamp: 1,
      body: '{}',
    });
    expect(sigRaw).toBe(sigPrefixed);

    expect(decodeWebhookSecret('whsec_aGVsbG8=')).toEqual(new TextEncoder().encode('hello'));
    expect(() => decodeWebhookSecret('whsec_%%%')).toThrow(ConfigError);
  });

  it('matches the Standard Webhooks reference vector', async () => {
    const signature = await signWebhook({
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: 1614265330,
      body: '{"test": 2432232314}',
    });
    expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('throws WebhookDeliveryError with status, truncated body and Retry-After on non-2xx', async () => {
    const { fetch } = createFetch(
      () => new Response('upstream exploded', { status: 503, headers: { 'retry-after': '2' } }),
    );
    const ctx = makeCtx();
    const sink = webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock });

    const err = await rejection(sink(makeEvent(), ctx));
    expect(err).toBeInstanceOf(WebhookDeliveryError);
    expect(err).toBeInstanceOf(HttpError);
    const delivery = err as WebhookDeliveryError;
    expect(delivery.status).toBe(503);
    expect(delivery.url).toBe(URL_);
    expect(delivery.method).toBe('POST');
    expect(delivery.bodyText).toBe('upstream exploded');
    expect(delivery.message).toContain('503');
    expect(delivery.message).toContain('upstream exploded');
    expect(delivery.retryAfterMs).toBe(2000);
    expect(delivery.code).toBe('HTTP');
    expect(ctx.ack).not.toHaveBeenCalled();
  });

  it('truncates long error bodies', async () => {
    const huge = 'x'.repeat(MAX_WEBHOOK_ERROR_BODY_CHARS * 4);
    const { fetch } = createFetch(() => new Response(huge, { status: 500 }));
    const err = (await rejection(
      webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock })(makeEvent(), makeCtx()),
    )) as WebhookDeliveryError;
    expect(err.bodyText?.length).toBeLessThanOrEqual(MAX_WEBHOOK_ERROR_BODY_CHARS + 1);
    expect(err.bodyText?.endsWith('…')).toBe(true);
    expect(err.message.length).toBeLessThan(400);
  });

  it('handles a non-2xx response without a body', async () => {
    const { fetch } = createFetch(() => new Response(null, { status: 404 }));
    const err = (await rejection(
      webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock })(makeEvent(), makeCtx()),
    )) as WebhookDeliveryError;
    expect(err.status).toBe(404);
    expect(err.bodyText).toBeUndefined();
  });

  it('propagates network errors unchanged and never retries itself', async () => {
    const failure = new TypeError('fetch failed');
    const { calls, fetch } = createFetch(() => Promise.reject(failure));
    const ctx = makeCtx();
    await expect(
      webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock })(makeEvent(), ctx),
    ).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
    expect(ctx.ack).not.toHaveBeenCalled();
  });

  it('merges custom headers (lowercased) but never lets them override webhook-* headers', async () => {
    const { calls, fetch } = createFetch();
    await webhookSink<Order>({
      url: URL_,
      secret: RAW_SECRET,
      fetch,
      clock,
      headers: { Authorization: 'Bearer t0k3n', 'X-Tenant': 'acme', 'Webhook-Id': 'spoofed' },
    })(makeEvent(), makeCtx());
    const { headers } = calls[0]!;
    expect(headers.authorization).toBe('Bearer t0k3n');
    expect(headers['x-tenant']).toBe('acme');
    expect(headers['webhook-id']).toBe(makeEvent().id);
    expect(headers['content-type']).toBe('application/cloudevents+json');
  });

  it("posts the raw WatukuyEvent as application/json with format 'raw'", async () => {
    const { calls, fetch } = createFetch();
    const event = makeEvent();
    await webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock, format: 'raw' })(
      event,
      makeCtx(),
    );
    const call = calls[0]!;
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body)).toEqual(event);
    await expect(
      verifyWebhookSignature({
        secret: RAW_SECRET,
        id: event.id,
        timestamp: NOW_SEC,
        body: call.body,
        signatureHeader: call.headers['webhook-signature']!,
        now: NOW_MS,
      }),
    ).resolves.toBe(true);
  });

  it('honours successStatuses', async () => {
    const { fetch } = createFetch(() => new Response('gone', { status: 410 }));
    const sink = webhookSink<Order>({
      url: URL_,
      secret: RAW_SECRET,
      fetch,
      clock,
      successStatuses: (s) => s === 410,
    });
    await expect(sink(makeEvent(), makeCtx())).resolves.toBeUndefined();
  });

  it('accepts a URL instance and preserves the given string form', async () => {
    const { calls, fetch } = createFetch();
    await webhookSink<Order>({ url: new URL(URL_), secret: RAW_SECRET, fetch, clock })(
      makeEvent(),
      makeCtx(),
    );
    expect(calls[0]!.url).toBe(URL_);
  });

  it('rejects invalid configuration eagerly', () => {
    expect(() => webhookSink({ url: 'not a url', secret: RAW_SECRET })).toThrow(ConfigError);
    expect(() => webhookSink({ url: URL_, secret: '' })).toThrow(ConfigError);
    expect(() => webhookSink({ url: URL_, secret: RAW_SECRET, timeoutMs: 0 })).toThrow(ConfigError);
    expect(() => webhookSink({ url: URL_, secret: RAW_SECRET, timeoutMs: Number.NaN })).toThrow(
      ConfigError,
    );
    expect(() => webhookSink({ url: URL_, secret: 'whsec_***' })).toThrow(ConfigError);
    expect(DEFAULT_WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  it('aborts the request when the timeout elapses', async () => {
    const { fetch } = createFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason));
        }),
    );
    const err = (await rejection(
      webhookSink<Order>({
        url: URL_,
        secret: RAW_SECRET,
        fetch,
        clock,
        timeoutMs: 5,
      })(makeEvent(), makeCtx()),
    )) as Error;
    expect(err.name).toBe('TimeoutError');
  });

  it('aborts the request when the handler context signal aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('engine stopping');
    const { fetch } = createFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason));
          controller.abort(reason);
        }),
    );
    await expect(
      webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch, clock })(
        makeEvent(),
        makeCtx(controller.signal),
      ),
    ).rejects.toBe(reason);
  });

  it('uses Date.now when no clock is given', async () => {
    const { calls, fetch } = createFetch();
    const before = Math.floor(Date.now() / 1000);
    await webhookSink<Order>({ url: URL_, secret: RAW_SECRET, fetch })(makeEvent(), makeCtx());
    const ts = Number(calls[0]!.headers['webhook-timestamp']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});

describe('verifyWebhookSignature', () => {
  const id = 'msg_1';
  const body = '{"hello":"world"}';

  async function signed(timestamp: string, secret = RAW_SECRET): Promise<string> {
    return signWebhook({ secret, id, timestamp, body });
  }

  it('rejects stale and future timestamps beyond the tolerance, default 300s', async () => {
    const ts = NOW_SEC;
    const signatureHeader = await signed(ts);
    const input = { secret: RAW_SECRET, id, timestamp: ts, body, signatureHeader };

    await expect(verifyWebhookSignature({ ...input, now: NOW_MS })).resolves.toBe(true);
    await expect(verifyWebhookSignature({ ...input, now: NOW_MS + 300_000 })).resolves.toBe(true);
    await expect(verifyWebhookSignature({ ...input, now: NOW_MS + 301_000 })).resolves.toBe(false);
    await expect(verifyWebhookSignature({ ...input, now: NOW_MS - 301_000 })).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({ ...input, now: NOW_MS + 301_000, toleranceSec: 600 }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ ...input, now: NOW_MS + 30_000, toleranceSec: 10 }),
    ).resolves.toBe(false);
  });

  it('rejects malformed timestamps', async () => {
    const signatureHeader = await signed('nope');
    await expect(
      verifyWebhookSignature({
        secret: RAW_SECRET,
        id,
        timestamp: 'nope',
        body,
        signatureHeader,
        now: NOW_MS,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({
        secret: RAW_SECRET,
        id,
        timestamp: '',
        body,
        signatureHeader,
        now: NOW_MS,
      }),
    ).resolves.toBe(false);
  });

  it('accepts a space-separated list when any v1 signature matches, ignoring other versions', async () => {
    const good = await signed(NOW_SEC);
    const otherKey = await signed(NOW_SEC, 'rotated-out-secret');
    const base = { secret: RAW_SECRET, id, timestamp: NOW_SEC, body, now: NOW_MS };

    await expect(
      verifyWebhookSignature({ ...base, signatureHeader: `${otherKey} ${good}` }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ ...base, signatureHeader: `${good} ${otherKey}` }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ ...base, signatureHeader: `v1,not-base64!! ${good}` }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({
        ...base,
        signatureHeader: `v1a,${good.slice(3)} v2,${good.slice(3)}`,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({ ...base, signatureHeader: `${otherKey} v1,AAAA` }),
    ).resolves.toBe(false);
    await expect(verifyWebhookSignature({ ...base, signatureHeader: '' })).resolves.toBe(false);
  });

  it('uses Date.now when now is omitted', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signatureHeader = await signed(ts);
    await expect(
      verifyWebhookSignature({ secret: RAW_SECRET, id, timestamp: ts, body, signatureHeader }),
    ).resolves.toBe(true);
  });
});
