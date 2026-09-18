import { ConfigError, HttpError } from '../core/errors.ts';
import type { EventHandler } from '../core/event.ts';
import type { Clock } from '../core/ports.ts';
import { parseRetryAfter } from '../http/rate-limit.ts';
import { composeAbortSignal } from '../http/signal.ts';
import { type SinkFormat, serializeEvent } from './serialize.ts';

/**
 * Prefix of a base64-encoded Standard Webhooks secret (`whsec_...`).
 *
 * @example
 * const secret = `${WEBHOOK_SECRET_PREFIX}${base64Key}`;
 */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Default per-request timeout of {@link webhookSink}, in milliseconds.
 *
 * @example
 * webhookSink({ url, secret, timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS * 2 });
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Default timestamp tolerance of {@link verifyWebhookSignature}, in seconds (five minutes, the
 * value recommended by the Standard Webhooks spec).
 *
 * @example
 * verifyWebhookSignature({ ...input, toleranceSec: DEFAULT_WEBHOOK_TOLERANCE_SEC });
 */
export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Error bodies from the receiver are kept up to this many characters on
 * {@link WebhookDeliveryError.bodyText}; the rest is discarded.
 *
 * @example
 * if (err.bodyText?.length === MAX_WEBHOOK_ERROR_BODY_CHARS + 1) console.log('truncated');
 */
export const MAX_WEBHOOK_ERROR_BODY_CHARS = 4096;

const MESSAGE_SNIPPET_CHARS = 200;
const SIGNATURE_VERSION = 'v1';
const encoder = new TextEncoder();

type HmacKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

/**
 * Options for {@link webhookSink}.
 *
 * @example
 * const options: WebhookSinkOptions = {
 *   url: 'https://example.com/hooks/orders',
 *   secret: process.env.WEBHOOK_SECRET!,
 *   headers: { authorization: `Bearer ${token}` },
 * };
 */
export interface WebhookSinkOptions {
  url: string | URL;
  /** Standard Webhooks secret. Accepts the `whsec_` prefixed base64 form or a raw string. */
  secret: string;
  /** Extra request headers. Merged under the `content-type` and `webhook-*` headers, which win. */
  headers?: Record<string, string> | undefined;
  /** @default globalThis.fetch */
  fetch?: typeof globalThis.fetch | undefined;
  /** Time source for `webhook-timestamp`. @default Date.now-based */
  clock?: Pick<Clock, 'now'> | undefined;
  /**
   * `'cloudevents'` (default) posts `toCloudEvent(event)` as `application/cloudevents+json`;
   * `'raw'` posts the `WatukuyEvent` as `application/json`.
   */
  format?: SinkFormat | undefined;
  /** Per-request timeout in milliseconds. @default 10000 */
  timeoutMs?: number | undefined;
  /** Treat these statuses as success. @default 2xx */
  successStatuses?: ((status: number) => boolean) | undefined;
}

/**
 * The receiver answered with a non-success status. Carries `status`, the request `url`, a
 * truncated `bodyText` and `retryAfterMs` (from `Retry-After`) so the dispatcher can log, retry
 * and eventually park with diagnostics attached.
 *
 * @example
 * try {
 *   await sink(event, ctx);
 * } catch (err) {
 *   if (err instanceof WebhookDeliveryError) console.error(err.status, err.bodyText);
 * }
 */
export class WebhookDeliveryError extends HttpError {
  constructor(init: {
    status: number;
    url: string;
    bodyText?: string | undefined;
    retryAfterMs?: number | undefined;
  }) {
    super({
      status: init.status,
      url: init.url,
      method: 'POST',
      bodyText: init.bodyText,
      retryAfterMs: init.retryAfterMs,
    });
    this.name = 'WebhookDeliveryError';
    const snippet = init.bodyText?.replace(/\s+/g, ' ').trim();
    if (snippet) {
      this.message += `: ${
        snippet.length > MESSAGE_SNIPPET_CHARS
          ? `${snippet.slice(0, MESSAGE_SNIPPET_CHARS)}…`
          : snippet
      }`;
    }
  }
}

/**
 * Turn a Standard Webhooks secret into key bytes. `whsec_`-prefixed secrets are base64-decoded
 * after stripping the prefix; anything else is treated as a raw string and UTF-8 encoded.
 *
 * @example
 * decodeWebhookSecret('whsec_aGVsbG8='); // Uint8Array of "hello"
 * decodeWebhookSecret('hello');          // the same bytes
 */
export function decodeWebhookSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    try {
      return base64Decode(secret.slice(WEBHOOK_SECRET_PREFIX.length));
    } catch {
      throw new ConfigError(
        `webhook secret: text after '${WEBHOOK_SECRET_PREFIX}' is not valid base64`,
      );
    }
  }
  return encoder.encode(secret);
}

/**
 * Produce the `webhook-signature` header value for a message, per the Standard Webhooks spec:
 * `v1,<base64(HMAC-SHA256(secret, "${id}.${timestamp}.${body}"))>`.
 *
 * @example
 * const signature = await signWebhook({ secret, id: event.id, timestamp: 1700000000, body });
 * headers['webhook-signature'] = signature;
 */
export async function signWebhook(input: {
  secret: string;
  id: string;
  timestamp: string | number;
  body: string;
}): Promise<string> {
  const key = await importHmacKey(decodeWebhookSecret(input.secret));
  return signWithKey(key, signedContent(input.id, String(input.timestamp), input.body));
}

/**
 * Verify a Standard Webhooks signature on the receiving side (for tests and for users building
 * receivers). Every `v1,` entry of the space-separated header is checked with a constant-time
 * HMAC comparison (`crypto.subtle.verify`); any match wins. The timestamp must be an integer
 * within `toleranceSec` (default 300) of `now` in either direction.
 *
 * `now` is epoch milliseconds (like `Clock.now()`), defaulting to `Date.now()`; the timestamp
 * header is unix seconds as defined by the spec.
 *
 * @example
 * const ok = await verifyWebhookSignature({
 *   secret: process.env.WEBHOOK_SECRET!,
 *   id: req.headers.get('webhook-id')!,
 *   timestamp: req.headers.get('webhook-timestamp')!,
 *   signatureHeader: req.headers.get('webhook-signature')!,
 *   body: await req.text(),
 * });
 * if (!ok) return new Response('invalid signature', { status: 401 });
 */
export async function verifyWebhookSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
  now?: number | undefined;
  toleranceSec?: number | undefined;
}): Promise<boolean> {
  const timestampSec = parseTimestamp(input.timestamp);
  if (timestampSec === undefined) return false;
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const toleranceSec = input.toleranceSec ?? DEFAULT_WEBHOOK_TOLERANCE_SEC;
  if (Math.abs(nowSec - timestampSec) > toleranceSec) return false;

  const key = await importHmacKey(decodeWebhookSecret(input.secret));
  const data = encoder.encode(signedContent(input.id, input.timestamp, input.body));
  for (const entry of input.signatureHeader.split(/\s+/)) {
    if (!entry.startsWith(`${SIGNATURE_VERSION},`)) continue;
    let candidate: Uint8Array<ArrayBuffer>;
    try {
      candidate = base64Decode(entry.slice(SIGNATURE_VERSION.length + 1));
    } catch {
      continue;
    }
    if (await globalThis.crypto.subtle.verify('HMAC', key, candidate, data)) return true;
  }
  return false;
}

/**
 * Re-emit each event as an outgoing webhook signed per the Standard Webhooks spec
 * (https://www.standardwebhooks.com): headers `webhook-id` (= `event.id`), `webhook-timestamp`
 * (unix seconds) and `webhook-signature` (`v1,<base64 HMAC-SHA256>` over
 * `${id}.${timestamp}.${body}`). The body is `toCloudEvent(event)` by default (see docs/recipes.md).
 *
 * Throws a {@link WebhookDeliveryError} on a non-success status and lets network errors and
 * aborts propagate, so the dispatcher retries with backoff and eventually parks the event. The
 * sink never retries on its own. Calls `ctx.ack()` after a successful delivery (a no-op outside
 * `ackMode: 'manual'`).
 *
 * The timeout uses real timers; `clock` only feeds the `webhook-timestamp` header.
 *
 * @example
 * const engine = createWatukuy({ store, pollers: { orders } });
 * engine.on('orders', webhookSink({
 *   url: 'https://example.com/hooks/orders',
 *   secret: process.env.WEBHOOK_SECRET!,
 * }));
 */
export function webhookSink<Item>(options: WebhookSinkOptions): EventHandler<Item> {
  const url = typeof options.url === 'string' ? options.url : options.url.toString();
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`webhookSink: invalid url '${url}'`);
  }
  if (!options.secret) throw new ConfigError('webhookSink: secret is required');
  const secretBytes = decodeWebhookSecret(options.secret);

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('webhookSink: no global fetch available; pass options.fetch');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new ConfigError(`webhookSink: timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  const format = options.format ?? 'cloudevents';
  const isSuccess = options.successStatuses ?? ((status: number) => status >= 200 && status < 300);
  const clock = options.clock;
  const now = clock ? () => clock.now() : () => Date.now();
  const extraHeaders = lowercaseKeys(options.headers ?? {});
  const timerClock: Clock = {
    now,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };

  let keyPromise: Promise<HmacKey> | undefined;
  const getKey = (): Promise<HmacKey> => {
    keyPromise ??= importHmacKey(secretBytes);
    return keyPromise;
  };

  return async (event, ctx) => {
    const { body, contentType } = serializeEvent(event, format);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = await signWithKey(await getKey(), signedContent(event.id, timestamp, body));
    const headers: Record<string, string> = {
      'content-type': contentType,
      ...extraHeaders,
      'webhook-id': event.id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
    };

    const composed = composeAbortSignal({ signals: [ctx.signal], timeoutMs, clock: timerClock });
    const init: RequestInit = { method: 'POST', headers, body };
    if (composed) init.signal = composed.signal;
    try {
      const response = await fetchImpl(url, init);
      if (!isSuccess(response.status)) {
        const bodyText = await readBodyTruncated(response, MAX_WEBHOOK_ERROR_BODY_CHARS);
        throw new WebhookDeliveryError({
          status: response.status,
          url,
          bodyText,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
        });
      }
      await discardBody(response);
      ctx.ack();
    } finally {
      composed?.dispose();
    }
  };
}

function signedContent(id: string, timestamp: string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

function parseTimestamp(value: string): number | undefined {
  return /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

function importHmacKey(secret: Uint8Array<ArrayBuffer>): Promise<HmacKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signWithKey(key: HmacKey, content: string): Promise<string> {
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(content));
  return `${SIGNATURE_VERSION},${base64Encode(new Uint8Array(mac))}`;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

async function readBodyTruncated(
  response: Response,
  maxChars: number,
): Promise<string | undefined> {
  const stream = response.body;
  if (!stream) return undefined;
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (text.length <= maxChars) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(noop);
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return undefined;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is diagnostic only; a failure to drain it must not fail the delivery.
  }
}

function noop(): void {}
