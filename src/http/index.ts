/**
 * HTTP helper (`ctx.http`, see docs/http-helper.md): conditional requests, rate-limit header parsing,
 * `Retry-After`, RFC 9457 Problem Details, header redaction. Never retries.
 * @module
 */

export {
  buildRequestUrl,
  createHttpClient,
  DEFAULT_USER_AGENT,
  type HttpClientDeps,
  type HttpRequestInit,
  type HttpValidatorStore,
  MAX_ERROR_BODY_BYTES,
} from './client.ts';
export { parseProblemDetails } from './problem.ts';
export { parseRateLimitHeaders, parseRetryAfter } from './rate-limit.ts';
export { DEFAULT_REDACTED_HEADERS, REDACTED_VALUE, redactHeaders } from './redact.ts';
export {
  type ComposeAbortSignalOptions,
  type ComposedAbortSignal,
  composeAbortSignal,
  createTimeoutError,
} from './signal.ts';
