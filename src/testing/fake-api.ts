import { HttpError, type ProblemDetails } from '../core/errors.ts';
import { cyrb53 } from '../core/hash.ts';
import type { Clock } from '../core/ports.ts';

export interface FakeApiOptions<Item extends object> {
  /** Time source for `timestampField` bumps, latency, and the `at` field of {@link FakeApi.log}. */
  clock: Clock;
  /** Stable id of an item. Also the tie-breaker and default sort key of every listing. */
  identity: (item: Item) => string;
  /**
   * Field set to the clock's ISO time on {@link FakeApi.add} / {@link FakeApi.update}. Required by
   * {@link FakeApi.listSince}. Items given to the constructor or {@link FakeApi.seed} keep the
   * value they already have; only missing values are filled.
   */
  timestampField?: string | undefined;
  /** Initial dataset (same semantics as {@link FakeApi.seed}). */
  items?: Item[] | undefined;
  /** Default page size for listing endpoints. @default 100 */
  pageSize?: number | undefined;
  /** Base URL served by {@link FakeApi.fetchImpl}. @default 'https://fake.api' */
  baseUrl?: string | undefined;
}

/**
 * A failure injected with {@link FakeApi.failNext}.
 *
 * - `http`: a non-2xx response (`fetchImpl`) or an {@link HttpError} (direct methods), with an
 *   optional `Retry-After` and body.
 * - `network`: `fetchImpl` rejects with a `TypeError` like a real `fetch`; direct methods throw it.
 * - `timeout`: `fetchImpl` stays pending until the request signal aborts, then rejects with the
 *   signal's reason; direct methods throw an `Error` named `'TimeoutError'`.
 * - `malformed`: `fetchImpl` answers `200` with a non-JSON body; direct methods throw a
 *   `SyntaxError` as `res.json()` would.
 */
export type FakeFault =
  | { kind: 'http'; status: number; retryAfterMs?: number | undefined; body?: unknown }
  | { kind: 'network'; message?: string | undefined }
  | { kind: 'timeout' }
  | { kind: 'malformed' };

/** Header family emitted by {@link FakeApi.setRateLimit}. */
export type FakeRateLimitStyle = 'ietf' | 'legacy' | 'vendor';

export interface FakeRateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Requests left in the current window. */
  remaining: number;
  /** Milliseconds until the window resets, relative to the clock at response time. */
  resetInMs: number;
  /**
   * - `ietf` (default): `RateLimit: "default";r=<remaining>;t=<seconds>` plus
   *   `RateLimit-Policy: "default";q=<limit>;w=<windowSeconds>` (draft-ietf-httpapi-ratelimit-headers).
   * - `legacy`: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (delta seconds).
   * - `vendor`: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch seconds).
   */
  style?: FakeRateLimitStyle | undefined;
  /** Window length advertised in `RateLimit-Policy` (`ietf` only). @default 60_000 */
  windowMs?: number | undefined;
}

/** One request seen by the fake, direct or through `fetchImpl`. */
export interface FakeApiLogEntry {
  /** Clock time when the request was served. */
  at: number;
  /** `'since' | 'page' | 'token' | 'all' | 'item'`, or the raw pathname for unmatched routes. */
  route: string;
  params: Record<string, unknown>;
  /** HTTP status; `0` for network and timeout faults. */
  status: number;
}

export interface FakeSinceResult<Item> {
  items: Item[];
  hasMore: boolean;
}

export interface FakePageResult<Item> {
  items: Item[];
  hasMore: boolean;
  /** Total number of pages at the requested size (at least 1). */
  pages: number;
}

export interface FakeTokenResult<Item> {
  items: Item[];
  /** Opaque cursor for the next page, `null` when exhausted. */
  next: string | null;
}

interface TsRow<Item> {
  id: string;
  ts: number;
  item: Item;
}

interface RouteResult {
  status: number;
  body: unknown;
  problem?: boolean;
  allow?: string;
}

interface RouteMatch {
  route: string;
  params: Record<string, unknown>;
  run: () => RouteResult;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BASE_URL = 'https://fake.api';
const DEFAULT_WINDOW_MS = 60_000;
const JSON_TYPE = 'application/json';
const PROBLEM_JSON_TYPE = 'application/problem+json';
const MALFORMED_BODY = 'not json';

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function weakEtag(text: string): string {
  return `W/"${cyrb53(text).toString(16)}"`;
}

/** Weak comparison (RFC 9110 §8.8.3.2): `W/` prefixes are ignored, `*` matches anything. */
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const want = etag.replace(/^W\//, '');
  return ifNoneMatch.split(',').some((part) => {
    const candidate = part.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === want;
  });
}

function faultStatus(fault: FakeFault): number {
  switch (fault.kind) {
    case 'http':
      return fault.status;
    case 'malformed':
      return 200;
    default:
      return 0;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeToken(offset: number): string {
  return btoa(String(offset));
}

function decodeToken(token: string): number {
  let decoded: string;
  try {
    decoded = atob(token);
  } catch {
    throw new RangeError(`invalid token ${JSON.stringify(token)}`);
  }
  const offset = Number(decoded);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`invalid token ${JSON.stringify(token)}`);
  }
  return offset;
}

function parseIntParam(value: string | null, name: string): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new RangeError(`query parameter '${name}' must be an integer`);
  return n;
}

function problem(status: number, title: string, detail?: string): RouteResult {
  const body: ProblemDetails = { title, status };
  if (detail !== undefined) body.detail = detail;
  return { status, body, problem: true };
}

/**
 * Scriptable in-memory third-party API for integration, chaos and example tests. Holds a dataset
 * keyed by `identity`, serves it through keyset (`since`), page-number and opaque-token listings,
 * and lets you inject faults, rate-limit headers, ETags and latency. Fully deterministic when
 * driven by a {@link VirtualClock}.
 *
 * Use the direct methods (`listSince`, `listPage`, `listToken`, `listAll`) from a poller's `fetch`
 * to skip HTTP entirely, or hand {@link FakeApi.fetchImpl} to code that expects a `fetch`.
 *
 * @example
 * const clock = new VirtualClock();
 * const api = new FakeApi({
 *   clock,
 *   identity: (o) => o.id,
 *   timestampField: 'updatedAt',
 *   items: fakeItems(3),
 * });
 * api.add({ id: 'o-4', name: 'new', value: 4, updatedAt: '' }); // updatedAt := clock.iso()
 * api.failNext({ kind: 'http', status: 429, retryAfterMs: 5_000 });
 * const res = await api.fetchImpl()('https://fake.api/since?since=2026-01-01T00:00:00Z');
 * res.status;                       // 429
 * res.headers.get('retry-after');   // '5'
 */
export class FakeApi<Item extends object> {
  /** Base URL served by {@link fetchImpl}, without trailing slash. */
  readonly baseUrl: string;
  /** Every request served so far. Cleared by {@link resetStats}. */
  readonly log: FakeApiLogEntry[] = [];

  readonly #clock: Clock;
  readonly #identity: (item: Item) => string;
  readonly #tsField: string | undefined;
  readonly #pageSize: number;
  readonly #origin: string;
  readonly #basePath: string;
  readonly #items = new Map<string, Item>();
  #byId: Item[] | null = null;
  #byTs: TsRow<Item>[] | null = null;
  #faults: FakeFault[] = [];
  #rateLimit: FakeRateLimit | null = null;
  #etags = true;
  #latencyMs = 0;
  #calls = 0;

  constructor(opts: FakeApiOptions<Item>) {
    this.#clock = opts.clock;
    this.#identity = opts.identity;
    this.#tsField = opts.timestampField;
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    this.#pageSize = pageSize;
    const base = new URL(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.#origin = base.origin;
    this.#basePath = base.pathname.replace(/\/+$/, '');
    this.baseUrl = `${this.#origin}${this.#basePath}`;
    if (opts.items) this.seed(opts.items);
  }

  // ---------------------------------------------------------------- dataset

  /** Number of items in the dataset. */
  get size(): number {
    return this.#items.size;
  }

  /**
   * Insert a new item, stamping `timestampField` with the clock's ISO time when configured.
   * Returns a copy of what was stored.
   *
   * @throws {Error} when an item with the same identity already exists (use {@link update}).
   * @example
   * const stored = api.add({ id: 'o-1', name: 'first', value: 1, updatedAt: '' });
   * stored.updatedAt === clock.iso(); // true
   */
  add(item: Item): Item {
    const id = this.#identity(item);
    if (this.#items.has(id)) {
      throw new Error(`FakeApi.add: item '${id}' already exists; use update() to change it`);
    }
    const stored = this.#stamp({ ...item });
    this.#items.set(id, stored);
    this.#invalidate();
    return { ...stored };
  }

  /**
   * Merge `patch` into an existing item and bump `timestampField`. Returns a copy of the result.
   *
   * @throws {Error} when no item has that identity, or the patch changes the identity.
   * @example
   * api.update('o-1', { value: 2 }); // updatedAt := clock.iso()
   */
  update(id: string, patch: Partial<Item>): Item {
    const current = this.#items.get(id);
    if (!current) throw new Error(`FakeApi.update: no item '${id}'`);
    const merged = { ...current, ...patch } as Item;
    const nextId = this.#identity(merged);
    if (nextId !== id) {
      throw new Error(`FakeApi.update: patch would change identity of '${id}' to '${nextId}'`);
    }
    const stored = this.#stamp(merged);
    this.#items.set(id, stored);
    this.#invalidate();
    return { ...stored };
  }

  /** Delete an item. Returns `false` when it did not exist. */
  remove(id: string): boolean {
    const removed = this.#items.delete(id);
    if (removed) this.#invalidate();
    return removed;
  }

  /** A copy of one item, or `undefined`. Not counted as a request. */
  get(id: string): Item | undefined {
    const item = this.#items.get(id);
    return item ? { ...item } : undefined;
  }

  /** Copies of every item ordered by identity. Not counted as a request. */
  all(): Item[] {
    return this.#sortedById().map((item) => ({ ...item }));
  }

  /**
   * Replace the whole dataset. Existing `timestampField` values are kept; missing ones are filled
   * with the clock's ISO time. Faster than repeated {@link add} for large fixtures.
   *
   * @example
   * api.seed(fakeItems(100_000));
   */
  seed(items: Item[]): void {
    this.#items.clear();
    const iso = this.#iso();
    for (const item of items) {
      const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      if (this.#tsField !== undefined && copy[this.#tsField] === undefined) {
        copy[this.#tsField] = iso;
      }
      this.#items.set(this.#identity(copy as Item), copy as Item);
    }
    this.#invalidate();
  }

  // ---------------------------------------------------------------- faults and behaviour

  /**
   * Queue a fault for the next `times` requests (direct or via `fetchImpl`). Faults are consumed
   * in FIFO order, one per request, before any real handling.
   *
   * @param times How many consecutive requests fail. @default 1
   * @example
   * api.failNext({ kind: 'http', status: 503, retryAfterMs: 2_000 }, 3); // three 503s, then normal
   * api.failNext({ kind: 'network' });                                    // then one TypeError
   */
  failNext(fault: FakeFault, times = 1): void {
    if (!Number.isInteger(times) || times < 1) {
      throw new RangeError(`failNext() times must be a positive integer, got ${times}`);
    }
    for (let i = 0; i < times; i++) this.#faults.push(fault);
  }

  /** Faults queued but not yet consumed. */
  pendingFaults(): number {
    return this.#faults.length;
  }

  /** Drop every queued fault. */
  clearFaults(): void {
    this.#faults = [];
  }

  /**
   * Attach rate-limit headers to every `fetchImpl` response (including faults and 304s), or stop
   * with `null`. Values are static: call again to simulate a decreasing `remaining`.
   *
   * @example
   * api.setRateLimit({ limit: 100, remaining: 3, resetInMs: 30_000 });                  // IETF
   * api.setRateLimit({ limit: 100, remaining: 3, resetInMs: 30_000, style: 'vendor' }); // X-RateLimit-*
   * api.setRateLimit(null);
   */
  setRateLimit(info: FakeRateLimit | null): void {
    this.#rateLimit = info ? { ...info } : null;
  }

  /**
   * Toggle ETag support for `fetchImpl` (on by default). When enabled, every `200` JSON response
   * carries a weak `ETag` derived from its body and a matching `If-None-Match` yields `304`.
   */
  setEtags(enabled: boolean): void {
    this.#etags = enabled;
  }

  /**
   * Delay every `fetchImpl` response by `ms` of clock time (`clock.setTimeout`). With a
   * {@link VirtualClock} the promise stays pending until you `advance(ms)`. Aborting the request
   * signal during the wait rejects with the signal's reason.
   *
   * @example
   * api.setLatency(250);
   * const pending = fetch('https://fake.api/all');
   * await clock.advance(250); // now `pending` resolves
   */
  setLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`setLatency() requires a non-negative number of ms, got ${ms}`);
    }
    this.#latencyMs = ms;
  }

  // ---------------------------------------------------------------- direct listing endpoints

  /**
   * Keyset listing by `timestampField`: items with timestamp `>= since` ordered by
   * `(timestamp, identity)`. With `afterId`, items whose timestamp equals `since` and whose
   * identity is `<= afterId` are skipped, so ties across a page boundary are never repeated.
   * `since: null` starts from the beginning.
   *
   * Counts as a request: consumes faults and is logged.
   *
   * @throws {Error} when `timestampField` is not configured.
   * @throws {RangeError} when `since` is not a parseable date or `limit` is not a positive integer.
   * @example
   * const first = api.listSince({ since: null, limit: 50 });
   * const last = first.items.at(-1)!;
   * const next = api.listSince({ since: last.updatedAt, afterId: last.id, limit: 50 });
   */
  listSince(params: {
    since: string | null;
    afterId?: string | null | undefined;
    limit?: number | undefined;
  }): FakeSinceResult<Item> {
    return this.#request('since', { ...params }, () => this.#listSince(params));
  }

  /**
   * Page-number listing (1-based) ordered by identity. Pages past the end are empty.
   *
   * @throws {RangeError} when `page` or `limit` is not a positive integer.
   * @example
   * const { items, hasMore, pages } = api.listPage({ page: 1, limit: 25 });
   */
  listPage(params: { page: number; limit?: number | undefined }): FakePageResult<Item> {
    return this.#request('page', { ...params }, () => this.#listPage(params));
  }

  /**
   * Opaque-token listing ordered by identity. Pass `next` back as `token` until it is `null`.
   *
   * @throws {RangeError} when the token is not one this fake issued.
   * @example
   * let token: string | null = null;
   * do {
   *   const page = api.listToken({ token, limit: 10 });
   *   token = page.next;
   * } while (token);
   */
  listToken(params: { token: string | null; limit?: number | undefined }): FakeTokenResult<Item> {
    return this.#request('token', { ...params }, () => this.#listToken(params));
  }

  /** Every item ordered by identity, as one request (snapshot-style endpoint). */
  listAll(): Item[] {
    return this.#request('all', {}, () => this.#listAll());
  }

  // ---------------------------------------------------------------- stats

  /** Requests served so far (direct and via `fetchImpl`), including faulted ones. */
  get calls(): number {
    return this.#calls;
  }

  /** Reset {@link calls} and empty {@link log} in place. Faults and settings are untouched. */
  resetStats(): void {
    this.#calls = 0;
    this.log.length = 0;
  }

  // ---------------------------------------------------------------- fetch

  /**
   * A `fetch`-compatible function serving, relative to `baseUrl`:
   *
   * | Route | Body |
   * |---|---|
   * | `GET /since?since=&after_id=&limit=` | `{ data, has_more }` |
   * | `GET /page?page=&limit=` | `{ data, has_more, pages }` |
   * | `GET /token?token=&limit=` | `{ data, next }` |
   * | `GET /all` | `{ data }` |
   * | `GET /items/:id` | the item, or `404` |
   *
   * Anything else is `404`; non-GET methods are `405`. Bad parameters are `400` with an
   * `application/problem+json` body. Queued faults, rate-limit headers, ETag/`304` and latency
   * all apply. `init.signal` is honoured: an aborted signal rejects with its reason.
   *
   * @example
   * const fetch = api.fetchImpl();
   * const res = await fetch('https://fake.api/page?page=2&limit=10');
   * const { data, has_more, pages } = await res.json();
   */
  fetchImpl(): typeof globalThis.fetch {
    return (input, init) => this.#fetch(input, init);
  }

  // ---------------------------------------------------------------- internals: dataset

  #iso(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  #stamp(item: Item): Item {
    if (this.#tsField === undefined) return item;
    const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    copy[this.#tsField] = this.#iso();
    return copy as Item;
  }

  #invalidate(): void {
    this.#byId = null;
    this.#byTs = null;
  }

  #sortedById(): Item[] {
    if (!this.#byId) {
      this.#byId = [...this.#items.entries()]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([, item]) => item);
    }
    return this.#byId;
  }

  #sortedByTs(): TsRow<Item>[] {
    if (!this.#byTs) {
      const field = this.#tsField as string;
      this.#byTs = [...this.#items.entries()]
        .map(([id, item]): TsRow<Item> => {
          const raw = (item as Record<string, unknown>)[field];
          const ts =
            typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
          return { id, ts: Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts, item };
        })
        .sort((a, b) => (a.ts === b.ts ? compareStrings(a.id, b.id) : a.ts < b.ts ? -1 : 1));
    }
    return this.#byTs;
  }

  #limit(limit: number | undefined): number {
    if (limit === undefined) return this.#pageSize;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive integer, got ${limit}`);
    }
    return limit;
  }

  #listSince(params: {
    since: string | null;
    afterId?: string | null | undefined;
    limit?: number | undefined;
  }): FakeSinceResult<Item> {
    if (this.#tsField === undefined) {
      throw new Error('FakeApi.listSince requires the timestampField option');
    }
    const size = this.#limit(params.limit);
    let sinceMs = Number.NEGATIVE_INFINITY;
    if (params.since !== null && params.since !== '') {
      sinceMs = Date.parse(params.since);
      if (Number.isNaN(sinceMs)) {
        throw new RangeError(`since must be a parseable date, got ${JSON.stringify(params.since)}`);
      }
    }
    const afterId = params.afterId ?? null;
    const items: Item[] = [];
    let hasMore = false;
    for (const row of this.#sortedByTs()) {
      if (row.ts < sinceMs) continue;
      if (afterId !== null && row.ts === sinceMs && compareStrings(row.id, afterId) <= 0) continue;
      if (items.length === size) {
        hasMore = true;
        break;
      }
      items.push({ ...row.item });
    }
    return { items, hasMore };
  }

  #listPage(params: { page: number; limit?: number | undefined }): FakePageResult<Item> {
    const size = this.#limit(params.limit);
    if (!Number.isInteger(params.page) || params.page < 1) {
      throw new RangeError(`page must be a positive integer, got ${params.page}`);
    }
    const rows = this.#sortedById();
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const start = (params.page - 1) * size;
    const items = rows.slice(start, start + size).map((item) => ({ ...item }));
    return { items, hasMore: params.page < pages, pages };
  }

  #listToken(params: { token: string | null; limit?: number | undefined }): FakeTokenResult<Item> {
    const size = this.#limit(params.limit);
    const offset = params.token === null || params.token === '' ? 0 : decodeToken(params.token);
    const rows = this.#sortedById();
    const items = rows.slice(offset, offset + size).map((item) => ({ ...item }));
    const nextOffset = offset + size;
    return { items, next: nextOffset < rows.length ? encodeToken(nextOffset) : null };
  }

  #listAll(): Item[] {
    return this.#sortedById().map((item) => ({ ...item }));
  }

  // ---------------------------------------------------------------- internals: requests

  #record(route: string, params: Record<string, unknown>, status: number): void {
    this.log.push({ at: this.#clock.now(), route, params, status });
  }

  #request<T>(route: string, params: Record<string, unknown>, run: () => T): T {
    this.#calls++;
    const fault = this.#faults.shift();
    if (fault) {
      this.#record(route, params, faultStatus(fault));
      throw this.#faultError(fault, route);
    }
    try {
      const result = run();
      this.#record(route, params, 200);
      return result;
    } catch (err) {
      this.#record(route, params, err instanceof RangeError ? 400 : 500);
      throw err;
    }
  }

  #faultError(fault: FakeFault, route: string): Error {
    switch (fault.kind) {
      case 'http': {
        const body =
          fault.body === undefined ? { title: 'Fault', status: fault.status } : fault.body;
        return new HttpError({
          status: fault.status,
          url: `${this.baseUrl}/${route}`,
          method: 'GET',
          retryAfterMs: fault.retryAfterMs,
          problem: isPlainObject(body) ? (body as ProblemDetails) : undefined,
          bodyText: JSON.stringify(body),
        });
      }
      case 'network':
        return new TypeError(fault.message ?? 'fetch failed');
      case 'timeout': {
        const err = new Error('The operation timed out.');
        err.name = 'TimeoutError';
        return err;
      }
      case 'malformed':
        return new SyntaxError(`Unexpected token 'n', "${MALFORMED_BODY}" is not valid JSON`);
    }
  }

  // ---------------------------------------------------------------- internals: fetch

  async #fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input instanceof URL ? input.href : String(input));
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const requestHeaders = new Headers(init?.headers ?? request?.headers);
    const signal = init?.signal ?? request?.signal ?? null;

    if (signal?.aborted) throw signal.reason;
    if (this.#latencyMs > 0) await this.#sleep(this.#latencyMs, signal);

    const match = this.#match(url, method);
    this.#calls++;
    const fault = this.#faults.shift();
    if (fault) {
      this.#record(match.route, match.params, faultStatus(fault));
      return this.#faultResponse(fault, signal);
    }
    const response = this.#respond(this.#safeRun(match.run), requestHeaders);
    this.#record(match.route, match.params, response.status);
    return response;
  }

  #match(url: URL, method: string): RouteMatch {
    const params = Object.fromEntries(url.searchParams);
    const inBase =
      url.origin === this.#origin &&
      (url.pathname === this.#basePath || url.pathname.startsWith(`${this.#basePath}/`));
    if (!inBase) {
      return { route: url.pathname, params, run: () => problem(404, 'Not Found') };
    }
    const rest = url.pathname.slice(this.#basePath.length);
    const q = url.searchParams;
    let route: string;
    let run: () => RouteResult;

    if (rest === '/since') {
      route = 'since';
      run = () => {
        const page = this.#listSince({
          since: q.get('since'),
          afterId: q.get('after_id'),
          limit: parseIntParam(q.get('limit'), 'limit'),
        });
        return { status: 200, body: { data: page.items, has_more: page.hasMore } };
      };
    } else if (rest === '/page') {
      route = 'page';
      run = () => {
        const page = this.#listPage({
          page: parseIntParam(q.get('page'), 'page') ?? 1,
          limit: parseIntParam(q.get('limit'), 'limit'),
        });
        return {
          status: 200,
          body: { data: page.items, has_more: page.hasMore, pages: page.pages },
        };
      };
    } else if (rest === '/token') {
      route = 'token';
      run = () => {
        const page = this.#listToken({
          token: q.get('token'),
          limit: parseIntParam(q.get('limit'), 'limit'),
        });
        return { status: 200, body: { data: page.items, next: page.next } };
      };
    } else if (rest === '/all') {
      route = 'all';
      run = () => ({ status: 200, body: { data: this.#listAll() } });
    } else if (rest.startsWith('/items/') && rest.length > '/items/'.length) {
      route = 'item';
      const id = decodeURIComponent(rest.slice('/items/'.length));
      params.id = id;
      run = () => {
        const item = this.#items.get(id);
        return item ? { status: 200, body: item } : problem(404, 'Not Found', `no item '${id}'`);
      };
    } else {
      return { route: url.pathname, params, run: () => problem(404, 'Not Found') };
    }

    if (method !== 'GET') {
      return {
        route,
        params,
        run: () => ({ ...problem(405, 'Method Not Allowed'), allow: 'GET' }),
      };
    }
    return { route, params, run };
  }

  #safeRun(run: () => RouteResult): RouteResult {
    try {
      return run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return err instanceof RangeError
        ? problem(400, 'Bad Request', message)
        : problem(500, 'Internal Server Error', message);
    }
  }

  #respond(result: RouteResult, requestHeaders: Headers): Response {
    const headers = new Headers();
    this.#applyRateLimit(headers);
    if (result.allow) headers.set('Allow', result.allow);
    const text = JSON.stringify(result.body);
    if (result.status === 200 && this.#etags) {
      const etag = weakEtag(text);
      headers.set('ETag', etag);
      if (etagMatches(requestHeaders.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
      }
    }
    headers.set('content-type', result.problem ? PROBLEM_JSON_TYPE : JSON_TYPE);
    return new Response(text, { status: result.status, headers });
  }

  #faultResponse(fault: FakeFault, signal: AbortSignal | null): Promise<Response> {
    switch (fault.kind) {
      case 'http': {
        const headers = new Headers({ 'content-type': PROBLEM_JSON_TYPE });
        this.#applyRateLimit(headers);
        if (fault.retryAfterMs !== undefined) {
          headers.set('Retry-After', String(Math.max(0, Math.ceil(fault.retryAfterMs / 1000))));
        }
        const body =
          fault.body === undefined ? { title: 'Fault', status: fault.status } : fault.body;
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: fault.status, headers }),
        );
      }
      case 'network':
        return Promise.reject(new TypeError(fault.message ?? 'fetch failed'));
      case 'timeout':
        return this.#untilAbort(signal);
      case 'malformed': {
        const headers = new Headers({ 'content-type': JSON_TYPE });
        this.#applyRateLimit(headers);
        return Promise.resolve(new Response(MALFORMED_BODY, { status: 200, headers }));
      }
    }
  }

  #applyRateLimit(headers: Headers): void {
    const rl = this.#rateLimit;
    if (!rl) return;
    const resetSeconds = Math.max(0, Math.ceil(rl.resetInMs / 1000));
    switch (rl.style ?? 'ietf') {
      case 'ietf': {
        const windowSeconds = Math.max(1, Math.ceil((rl.windowMs ?? DEFAULT_WINDOW_MS) / 1000));
        headers.set('RateLimit-Policy', `"default";q=${rl.limit};w=${windowSeconds}`);
        headers.set('RateLimit', `"default";r=${rl.remaining};t=${resetSeconds}`);
        break;
      }
      case 'legacy':
        headers.set('RateLimit-Limit', String(rl.limit));
        headers.set('RateLimit-Remaining', String(rl.remaining));
        headers.set('RateLimit-Reset', String(resetSeconds));
        break;
      case 'vendor':
        headers.set('X-RateLimit-Limit', String(rl.limit));
        headers.set('X-RateLimit-Remaining', String(rl.remaining));
        headers.set(
          'X-RateLimit-Reset',
          String(Math.ceil((this.#clock.now() + rl.resetInMs) / 1000)),
        );
        break;
    }
  }

  /** Resolve after `ms` of clock time; reject with the signal's reason if it aborts first. */
  #sleep(ms: number, signal: AbortSignal | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.#clock.clearTimeout(handle);
        reject(signal?.reason);
      };
      const handle = this.#clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Never resolves; rejects with the signal's reason once it aborts. Pending forever without a signal. */
  #untilAbort(signal: AbortSignal | null): Promise<never> {
    return new Promise<never>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

/** Shape produced by {@link fakeItems}. A type alias (not an interface) so it satisfies `Record<string, unknown>`. */
export type FakeItem = {
  id: string;
  updatedAt: string;
  name: string;
  value: number;
};

const FAKE_ITEMS_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/**
 * Generate `n` deterministic items: zero-padded ids (`item-001`), names, sequential values and
 * `updatedAt` timestamps one second apart from `2026-01-01T00:00:00Z`. Use `factory` to override
 * or extend fields per index.
 *
 * @example
 * fakeItems(2);
 * // [{ id: 'item-001', name: 'Item 1', value: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
 * //  { id: 'item-002', name: 'Item 2', value: 2, updatedAt: '2026-01-01T00:00:01.000Z' }]
 * fakeItems(3, (i) => ({ tenant: i % 2 ? 'a' : 'b' })); // FakeItem & { tenant: string }
 */
export function fakeItems<Extra extends Record<string, unknown> = Record<never, never>>(
  n: number,
  factory?: (i: number) => Extra,
): Array<FakeItem & Extra> {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`fakeItems() count must be a non-negative integer, got ${n}`);
  }
  const width = Math.max(3, String(n).length);
  const out: Array<FakeItem & Extra> = [];
  for (let i = 0; i < n; i++) {
    const base: FakeItem = {
      id: `item-${String(i + 1).padStart(width, '0')}`,
      name: `Item ${i + 1}`,
      value: i + 1,
      updatedAt: new Date(FAKE_ITEMS_EPOCH + i * 1_000).toISOString(),
    };
    out.push({ ...base, ...(factory ? factory(i) : ({} as Extra)) });
  }
  return out;
}
