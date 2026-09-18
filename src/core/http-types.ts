import type { Duration } from './duration.ts';
import type { RateLimitInfo } from './errors.ts';

/** A query-string value accepted by the HTTP helper; `null`/`undefined` entries are skipped. */
export type QueryValue = string | number | boolean | null | undefined;

/** Per-request options for `ctx.http.get()` / `ctx.http.request()` (PLAN §5.11). */
export interface HttpRequestOptions {
  query?: Record<string, QueryValue | QueryValue[]> | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** Budget tokens charged for this request. @default poller.budgetCost */
  cost?: number | undefined;
  /** Send and store ETag / Last-Modified validators. @default true for GET */
  validators?: boolean | undefined;
  timeout?: Duration | undefined;
  /**
   * Throw `HttpError` on non-2xx responses (304 excluded). Set to `false` to receive the
   * `HttpResponse` instead. @default true
   */
  throwOnError?: boolean | undefined;
}

/** Response wrapper returned by the HTTP helper. Body reads are cached, so `json()` and `text()` may both be called. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  /** `true` for 304 Not Modified: skip diffing, counts as idle for the scheduler. */
  notModified: boolean;
  headers: Headers;
  url: string;
  rateLimit: RateLimitInfo | null;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  raw: Response;
}

/** The `ctx.http` helper (PLAN §5.11). Never retries: the scheduler owns retries. */
export interface HttpClient {
  get(url: string | URL, options?: HttpRequestOptions): Promise<HttpResponse>;
  request(
    url: string | URL,
    options?: HttpRequestOptions & {
      method?: string | undefined;
      body?: RequestInit['body'] | undefined;
    },
  ): Promise<HttpResponse>;
}
