import { parseDuration } from '../core/duration.ts';
import { HttpError, type RateLimitInfo, serializeError } from '../core/errors.ts';
import { hashUrl } from '../core/hash.ts';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  QueryValue,
} from '../core/http-types.ts';
import type { Clock, Logger } from '../core/ports.ts';
import type { Validator } from '../core/store-types.ts';
import { parseProblemDetails } from './problem.ts';
import { parseRateLimitHeaders, parseRetryAfter } from './rate-limit.ts';
import { redactHeaders } from './redact.ts';
import { composeAbortSignal } from './signal.ts';

/** Default `User-Agent` sent when the caller does not provide one. */
export const DEFAULT_USER_AGENT = 'watukuy';

/** Error bodies are read for diagnostics up to this many bytes; the rest is discarded. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Storage for `ETag` / `Last-Modified` validators, keyed by `hashUrl(finalUrl)` where the final
 * URL includes the query string. The runner binds this to `StateStore.getValidator` /
 * `setValidator` for the current `(poller, partition)`.
 */
export interface HttpValidatorStore {
  get(urlHash: string): Promise<Validator | null>;
  set(urlHash: string, validator: Validator): Promise<void>;
}

/** Dependencies for {@link createHttpClient}. Everything is injected so tests are deterministic. */
export interface HttpClientDeps {
  fetch: typeof globalThis.fetch;
  clock: Clock;
  logger: Logger;
  /** Validators keyed by `hashUrl(final URL incl. query)`. Absent → no conditional requests. */
  validators?: HttpValidatorStore | undefined;
  /** Charge the rate budget before the request; may wait or throw `BudgetTimeoutError`. */
  charge?: ((cost: number) => Promise<void>) | undefined;
  /** Budget tokens charged when `options.cost` is not given. */
  defaultCost: number;
  /** Receives parsed rate-limit info from every response (for scheduler pacing). */
  onRateLimit?: ((info: RateLimitInfo) => void) | undefined;
  /** Parent signal (poll cycle abort). Composed with the per-request signal and the timeout. */
  signal?: AbortSignal | undefined;
  /** Extra header names to mask in logs, on top of the defaults (`authorization`, cookies...). */
  redactHeaders?: string[] | undefined;
  /** Default request timeout in milliseconds. `undefined` = no timeout. */
  defaultTimeoutMs?: number | undefined;
  /** `User-Agent` header value. @default 'watukuy' */
  userAgent?: string | undefined;
}

/** Options accepted by {@link HttpClient.request}. */
export type HttpRequestInit = HttpRequestOptions & {
  method?: string | undefined;
  body?: RequestInit['body'] | undefined;
};

/**
 * Build the final request URL: `query` entries are appended to the URL's search params.
 * `undefined` and `null` values are skipped; arrays repeat the key once per element.
 *
 * @throws {TypeError} when `url` is not an absolute URL.
 */
export function buildRequestUrl(
  url: string | URL,
  query?: Record<string, QueryValue | QueryValue[]> | undefined,
): string {
  const target = new URL(url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) appendQuery(target, key, item);
      } else {
        appendQuery(target, key, value);
      }
    }
  }
  return target.toString();
}

function appendQuery(target: URL, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  target.searchParams.append(key, String(value));
}

/**
 * Create the `ctx.http` helper (PLAN §5.11).
 *
 * Per request it: builds the URL, charges the budget, adds conditional-request headers from
 * stored validators (GET/HEAD by default), composes abort signals and timeout, calls `fetch`
 * exactly once (never retries), parses rate-limit headers, stores new validators on 2xx, and
 * turns non-2xx responses (except 304) into {@link HttpError} with `Retry-After` and RFC 9457
 * Problem Details attached. Network errors propagate unwrapped.
 */
export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;

  async function request(url: string | URL, options: HttpRequestInit = {}): Promise<HttpResponse> {
    const method = (options.method ?? 'GET').toUpperCase();
    const finalUrl = buildRequestUrl(url, options.query);
    const timeoutMs =
      options.timeout !== undefined
        ? parseDuration(options.timeout, 'http timeout')
        : deps.defaultTimeoutMs;
    deps.signal?.throwIfAborted();
    options.signal?.throwIfAborted();

    const cost = options.cost ?? deps.defaultCost;
    if (cost > 0 && deps.charge) await deps.charge(cost);

    const headers = new Headers(options.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
    if (!headers.has('accept')) headers.set('accept', 'application/json');

    const useValidators = options.validators ?? (method === 'GET' || method === 'HEAD');
    const validators = useValidators ? deps.validators : undefined;
    let urlHash: string | undefined;
    if (validators) {
      urlHash = await hashUrl(finalUrl);
      try {
        const stored = await validators.get(urlHash);
        if (stored?.etag && !headers.has('if-none-match')) {
          headers.set('if-none-match', stored.etag);
        }
        if (stored?.lastModified && !headers.has('if-modified-since')) {
          headers.set('if-modified-since', stored.lastModified);
        }
      } catch (err) {
        deps.logger.warn('watukuy: failed to load validators', {
          url: finalUrl,
          error: serializeError(err),
        });
      }
    }

    const loggedHeaders = redactHeaders(headers, deps.redactHeaders);
    const composed = composeAbortSignal({
      signals: [deps.signal, options.signal],
      timeoutMs,
      clock: deps.clock,
    });
    const init: RequestInit = { method, headers };
    if (composed) init.signal = composed.signal;
    if (options.body !== undefined) init.body = options.body;

    const startedAt = deps.clock.now();
    try {
      let raw: Response;
      try {
        raw = await deps.fetch(finalUrl, init);
      } catch (err) {
        deps.logger.debug('watukuy: http request failed', {
          method,
          url: finalUrl,
          durationMs: deps.clock.now() - startedAt,
          headers: loggedHeaders,
          error: serializeError(err),
        });
        throw err;
      }
      const receivedAt = deps.clock.now();
      const rateLimit = parseRateLimitHeaders(raw.headers, receivedAt);
      if (rateLimit) deps.onRateLimit?.(rateLimit);
      const notModified = raw.status === 304;
      deps.logger.debug('watukuy: http response', {
        method,
        url: finalUrl,
        status: raw.status,
        durationMs: receivedAt - startedAt,
        notModified,
        headers: loggedHeaders,
      });

      if (notModified) {
        return createHttpResponse({ raw, url: finalUrl, rateLimit, notModified: true });
      }
      if (raw.ok) {
        if (validators && urlHash !== undefined) {
          await storeValidators(deps, validators, urlHash, raw, finalUrl);
        }
        return createHttpResponse({ raw, url: finalUrl, rateLimit, notModified: false });
      }

      const bodyText = await readBodyText(raw, MAX_ERROR_BODY_BYTES);
      const problem = parseProblemDetails(raw.headers.get('content-type'), bodyText);
      const retryAfterMs = parseRetryAfter(raw.headers.get('retry-after'), deps.clock.now());
      if (options.throwOnError !== false) {
        throw new HttpError({
          status: raw.status,
          url: finalUrl,
          method,
          retryAfterMs,
          rateLimit: rateLimit ?? undefined,
          problem,
          bodyText,
        });
      }
      return createHttpResponse({ raw, url: finalUrl, rateLimit, notModified: false, bodyText });
    } finally {
      composed?.dispose();
    }
  }

  return {
    get: (url, options) => request(url, { ...options, method: 'GET' }),
    request,
  };
}

async function storeValidators(
  deps: HttpClientDeps,
  validators: HttpValidatorStore,
  urlHash: string,
  raw: Response,
  url: string,
): Promise<void> {
  const etag = raw.headers.get('etag');
  const lastModified = raw.headers.get('last-modified');
  if (etag === null && lastModified === null) return;
  try {
    await validators.set(urlHash, { etag, lastModified, storedAt: deps.clock.now() });
  } catch (err) {
    deps.logger.warn('watukuy: failed to store validators', { url, error: serializeError(err) });
  }
}

/**
 * Wrap a `Response` as an {@link HttpResponse}. The body is read once: `text()` and `json()`
 * share a cached string, and `arrayBuffer()` re-encodes that string when it was already read.
 * On 304 every body accessor rejects, since there is no body.
 */
function createHttpResponse(input: {
  raw: Response;
  url: string;
  rateLimit: RateLimitInfo | null;
  notModified: boolean;
  bodyText?: string | undefined;
}): HttpResponse {
  const { raw, notModified } = input;
  let textPromise: Promise<string> | undefined =
    input.bodyText !== undefined ? Promise.resolve(input.bodyText) : undefined;

  const noBody = <T>(): Promise<T> =>
    Promise.reject(new Error('watukuy: no body on 304 Not Modified response'));

  const text = (): Promise<string> => {
    if (notModified) return noBody();
    textPromise ??= raw.text();
    return textPromise;
  };

  return {
    status: raw.status,
    ok: raw.ok || notModified,
    notModified,
    headers: raw.headers,
    url: input.url,
    rateLimit: input.rateLimit,
    text,
    async json<T = unknown>(): Promise<T> {
      return JSON.parse(await text()) as T;
    },
    arrayBuffer(): Promise<ArrayBuffer> {
      if (notModified) return noBody();
      if (textPromise) {
        return textPromise.then((value) => {
          const bytes = new TextEncoder().encode(value);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        });
      }
      return raw.arrayBuffer();
    },
    raw,
  };
}

/** Best-effort body read capped at `maxBytes`; `undefined` when the body cannot be read. */
async function readBodyText(res: Response, maxBytes: number): Promise<string | undefined> {
  try {
    const stream = res.body;
    if (stream === null) return '';
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    while (!done && total < maxBytes) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        chunks.push(result.value);
        total += result.value.byteLength;
      }
    }
    if (!done) await reader.cancel().catch(() => undefined);
    return new TextDecoder().decode(concatBytes(chunks, Math.min(total, maxBytes)));
  } catch {
    return undefined;
  }
}

function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, length - offset));
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}
