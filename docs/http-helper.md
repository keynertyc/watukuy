# The HTTP helper (`ctx.http`)

`fetch` receives `http`, a small client that does the boring parts of talking to a rate-limited third-party API correctly: conditional requests, rate-limit header parsing, `Retry-After`, RFC 9457 Problem Details, budget charging, and header redaction. It is optional. If you would rather call `fetch` (or an SDK) yourself, do; you lose the 304 shortcut, proactive pacing, and budget accounting, and you take on error handling.

It **never retries**. The scheduler owns retries and backoff; two retry layers cause storms and double budget charges.

## API

```ts
interface HttpClient {
  get(url: string | URL, options?: HttpRequestOptions): Promise<HttpResponse>;
  request(url: string | URL, options?: HttpRequestOptions & { method?: string; body?: BodyInit }): Promise<HttpResponse>;
}

interface HttpRequestOptions {
  query?: Record<string, QueryValue | QueryValue[]>;   // string | number | boolean | null | undefined
  headers?: Record<string, string>;
  signal?: AbortSignal;
  cost?: number;              // budget tokens; default poller.budgetCost (1)
  validators?: boolean;       // send/store ETag & Last-Modified; default true for GET and HEAD
  timeout?: Duration;
  throwOnError?: boolean;     // default true: non-2xx (except 304) throws HttpError
}

interface HttpResponse {
  status: number;
  ok: boolean;                // true for 2xx and for 304
  notModified: boolean;       // true for 304
  headers: Headers;
  url: string;                // final URL including the query string
  rateLimit: RateLimitInfo | null;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  raw: Response;
}
```

```ts
fetch: async ({ cursor, http, signal }) => {
  const res = await http.get('https://erp.example.com/orders', {
    query: { updated_since: cursor.value, after_id: cursor.tieBreak, limit: 500 },
    headers: { authorization: `Bearer ${process.env.ERP_TOKEN}` },
    signal,
  });
  if (res.notModified) return { items: [] };
  const body = await res.json<{ data: unknown[]; has_more: boolean }>();
  return { items: body.data, hasMore: body.has_more };
}
```

## Query building

`query` entries are appended to the URL's search params. `null` and `undefined` values are skipped, so `{ updated_since: cursor.value }` sends nothing on the first poll when `cursor.value` is `null`. Arrays repeat the key once per element (`{ status: ['open', 'paid'] }` → `status=open&status=paid`). The URL must be absolute.

Default headers: `user-agent: watukuy` and `accept: application/json`, both overridable.

## Conditional requests (ETag / Last-Modified / 304)

For `GET` and `HEAD` (or when `validators: true`), the helper loads the stored validator for this `(poller, partition, URL)` and sends `If-None-Match` / `If-Modified-Since`. On a `2xx` with `ETag` or `Last-Modified`, it stores them. The URL key includes the query string, hashed, so `?page=1` and `?page=2` are different resources.

A `304 Not Modified` response has `notModified: true`, `ok: true`, and no body: `json()`, `text()`, and `arrayBuffer()` reject. Return `{ items: [] }` and the runner:

- treats the cycle as **idle** for the scheduler (interval grows, like an empty page);
- for `snapshotDiff` and reconcile, does **not** treat it as an empty listing: no `deleted` events are emitted, the snapshot is left as is.

Pass `validators: false` for URLs whose response must always be diffed, or whose URL changes every cycle (a timestamp in the query) so the validator table does not accumulate one row per cycle.

## Rate-limit headers and proactive pacing

Every response is parsed into `res.rateLimit` and handed to the scheduler, trying three header families in order and using the first that yields something:

1. **IETF structured fields** (draft-ietf-httpapi-ratelimit-headers): `RateLimit: "default";r=50;t=30` (remaining, seconds to reset) and `RateLimit-Policy: "default";q=100;w=60` (quota, window). Lenient: unknown keys ignored, quoted policy name optional, the policy named by `RateLimit` wins when several are advertised, and the older dictionary form (`limit=100, remaining=50, reset=30`) is accepted.
2. **Legacy triple**: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (delta seconds).
3. **Vendor variants**: `X-RateLimit-*` and `X-Rate-Limit-*`. `Reset` may be a delta in seconds or an epoch (seconds at 10+ digits, milliseconds at 13+). `X-RateLimit-Reset-After` is preferred when present.

```ts
interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAt?: number;          // epoch ms
  policy?: string;           // raw RateLimit-Policy
  source: 'ietf' | 'legacy' | 'vendor';
}
```

With `remaining` and `resetAt` known, the scheduler paces: the next wait becomes at least `(resetAt - now) / max(remaining, 1)`, and with `remaining === 0` it waits for the reset. This happens **before** any `429`. `onScheduleChange` reports `reason: 'paced'` when pacing stretched the wait.

## Retry-After and throttling

A `429`, or a `503` carrying `Retry-After`, throws an `HttpError` with `isThrottle === true` and `retryAfterMs` parsed from the header (a number of seconds, possibly fractional, or an HTTP-date, converted to a wait relative to now and floored at 0). The scheduler sleeps exactly that long, records `throttledUntil`, charges nothing extra, and does **not** count a failure, so a throttled poller cannot trip its circuit.

## Errors

Non-2xx responses other than 304 throw `HttpError`:

```ts
class HttpError extends WatukuyError {
  code: 'HTTP';
  status: number;
  url: string;
  method: string;
  retryAfterMs: number | undefined;
  rateLimit: RateLimitInfo | undefined;
  problem: ProblemDetails | undefined;    // RFC 9457 body, when the API sent one
  bodyText: string | undefined;           // first 64 KiB of the error body
  get isThrottle(): boolean;              // 429, or 503 with Retry-After
}
```

**Problem Details** are parsed when the content type is `application/problem+json`, or when it is any JSON type and the object has at least one of `type`, `title`, `status`, `detail`. Standard members are kept only when well-typed; extension members are preserved. The error message includes `title` (or `detail`) so logs read `GET https://... responded 422: Invalid cursor`.

`throwOnError: false` returns the `HttpResponse` for non-2xx instead, with `ok: false` and the body available through `text()` / `json()`; use it for APIs that put meaningful data in 4xx bodies.

Network failures (`TypeError` from `fetch`), timeouts (an `AbortError`-shaped error from the composed signal), and aborts propagate unwrapped. All of them are fetch failures to the scheduler: exponential backoff, then the circuit.

## Budget charging

If the poller declares `budget`, the helper acquires `cost` tokens (default `poller.budgetCost`, 1) **before** sending. The wait respects lane priority and fairness and is bounded by the budget's `maxWait` (default: the poller's `schedule.max`); past that, `BudgetTimeoutError` is thrown and the cycle is deferred. `onBudgetWait` fires for every request that had to wait. `cost: 0` skips the budget entirely, for endpoints the vendor does not count.

## Timeouts and signals

`signal` (per request), the cycle's abort signal (lease lost, `stop({ drain: false })`, `tick()` deadline is not one of them: pages are never interrupted), and `timeout` are composed into one `AbortSignal` passed to `fetch`. `timeout` is a `Duration` (`'10s'`). When no timeout is set the request waits as long as the runtime's `fetch` does.

## Redaction

Headers are logged at `debug` with `authorization`, `cookie`, `set-cookie`, `x-api-key`, and `proxy-authorization` replaced by `***`. Matching is case-insensitive. The same redaction applies to anything the OTel hooks record. Tokens in the URL query string are **not** redacted; put credentials in headers.

## Using an SDK instead

```ts
fetch: async ({ cursor, signal }) => {
  const page = await stripe.events.list({ starting_after: cursor.value ?? undefined, limit: 100 }, { signal });
  return { items: page.data, cursor: page.has_more ? page.data.at(-1)!.id : null };
}
```

Nothing stops you. Budget charging then has to be manual (`budgetCost` still applies to `ctx.http` calls only), rate-limit pacing is lost, and errors should be rethrown so the scheduler backs off. If the SDK exposes response headers, consider making the request through `ctx.http.request()` and handing the parsed body to the SDK's types.

Related: [how-it-works.md](./how-it-works.md#poller-state-machine), [cursors.md](./cursors.md), [observability.md](./observability.md).
