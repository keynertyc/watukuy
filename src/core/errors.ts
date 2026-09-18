/** Machine-readable error codes. Stable across minor versions. */
export type WatukuyErrorCode =
  | 'CONFIG'
  | 'LEASE_LOST'
  | 'HTTP'
  | 'STORE'
  | 'VALIDATION'
  | 'HANDLER'
  | 'REPLAY_UNAVAILABLE'
  | 'BUDGET_TIMEOUT'
  | 'CIRCUIT_OPEN'
  | 'NOT_RUNNING'
  | 'UNKNOWN_POLLER'
  | 'UNSUPPORTED';

/** Base class for every error thrown by watukuy. */
export class WatukuyError extends Error {
  readonly code: WatukuyErrorCode;
  constructor(code: WatukuyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WatukuyError';
    this.code = code;
  }
}

/** Invalid poller or engine configuration. Thrown eagerly at definition time. */
export class ConfigError extends WatukuyError {
  constructor(message: string) {
    super('CONFIG', message);
    this.name = 'ConfigError';
  }
}

/**
 * The lease for a `(poller, partition)` was stolen or expired while this instance was working.
 * The runner aborts the cycle and discards in-memory work (see docs/how-it-works.md).
 */
export class LeaseLostError extends WatukuyError {
  readonly poller: string;
  readonly partition: string;
  readonly epoch: number;
  constructor(poller: string, partition: string, epoch: number) {
    super(
      'LEASE_LOST',
      `lease lost for ${poller}/${partition || '-'} (epoch ${epoch}); another instance owns it now`,
    );
    this.name = 'LeaseLostError';
    this.poller = poller;
    this.partition = partition;
    this.epoch = epoch;
  }
}

/** RFC 9457 Problem Details body, when the API returned one. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/** Parsed rate-limit information from response headers (see docs/http-helper.md). */
export interface RateLimitInfo {
  /** Requests allowed in the current window, when advertised. */
  limit?: number;
  /** Requests remaining in the current window. */
  remaining?: number;
  /** Epoch milliseconds when the window resets. */
  resetAt?: number;
  /** Raw policy string (`RateLimit-Policy`) when present. */
  policy?: string;
  /** Which header family produced this info. */
  source: 'ietf' | 'legacy' | 'vendor';
}

/** Non-2xx HTTP response from the third-party API (304 is not an error). */
export class HttpError extends WatukuyError {
  readonly status: number;
  readonly url: string;
  readonly method: string;
  /** Milliseconds to wait, from `Retry-After` (seconds or HTTP-date), when present. */
  readonly retryAfterMs: number | undefined;
  readonly rateLimit: RateLimitInfo | undefined;
  readonly problem: ProblemDetails | undefined;
  readonly bodyText: string | undefined;
  constructor(init: {
    status: number;
    url: string;
    method: string;
    retryAfterMs?: number | undefined;
    rateLimit?: RateLimitInfo | undefined;
    problem?: ProblemDetails | undefined;
    bodyText?: string | undefined;
  }) {
    const detail = init.problem?.title ?? init.problem?.detail;
    super(
      'HTTP',
      `${init.method} ${init.url} responded ${init.status}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'HttpError';
    this.status = init.status;
    this.url = init.url;
    this.method = init.method;
    this.retryAfterMs = init.retryAfterMs;
    this.rateLimit = init.rateLimit;
    this.problem = init.problem;
    this.bodyText = init.bodyText;
  }
  /** `true` for 429 and 503 with Retry-After, the responses the scheduler treats as throttling. */
  get isThrottle(): boolean {
    return this.status === 429 || (this.status === 503 && this.retryAfterMs !== undefined);
  }
}

/** A store adapter failed. Wraps the underlying driver error in `cause`. */
export class StoreError extends WatukuyError {
  constructor(message: string, options?: ErrorOptions) {
    super('STORE', message, options);
    this.name = 'StoreError';
  }
}

/** An item failed Standard Schema validation. */
export class ValidationError extends WatukuyError {
  readonly issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>;
  constructor(issues: ValidationError['issues']) {
    super(
      'VALIDATION',
      `item failed schema validation: ${issues.map((i) => i.message).join('; ')}`,
    );
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** A user handler threw. The original error is in `cause`. */
export class HandlerError extends WatukuyError {
  readonly eventId: string;
  readonly attempt: number;
  constructor(eventId: string, attempt: number, cause: unknown) {
    super('HANDLER', `handler failed for event ${eventId} (attempt ${attempt})`, { cause });
    this.name = 'HandlerError';
    this.eventId = eventId;
    this.attempt = attempt;
  }
}

/** `replay()` was called but the poller has no event log configured. */
export class ReplayUnavailableError extends WatukuyError {
  constructor(poller: string) {
    super(
      'REPLAY_UNAVAILABLE',
      `replay is unavailable for poller '${poller}': enable it with log: { retention: '7d' } in definePoller`,
    );
    this.name = 'ReplayUnavailableError';
  }
}

/** Waiting for rate-budget tokens exceeded `maxWait`. */
export class BudgetTimeoutError extends WatukuyError {
  readonly budget: string;
  constructor(budget: string, waitedMs: number) {
    super('BUDGET_TIMEOUT', `budget '${budget}' had no tokens after waiting ${waitedMs}ms`);
    this.name = 'BudgetTimeoutError';
    this.budget = budget;
  }
}

/** Convert any thrown value into a JSON-friendly shape for storage and logs. */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  status?: number;
  cause?: SerializedError;
}

/** Convert any thrown value into a JSON-friendly `SerializedError` (stack, code, HTTP status, nested causes up to depth 3). */
export function serializeError(err: unknown, depth = 0): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    if (err instanceof WatukuyError) out.code = err.code;
    if (err instanceof HttpError) out.status = err.status;
    if (err.cause !== undefined && depth < 3) out.cause = serializeError(err.cause, depth + 1);
    return out;
  }
  return { name: 'NonError', message: typeof err === 'string' ? err : safeStringify(err) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
