/**
 * A tiny "legacy ERP" over `node:http`. No webhooks, only a polling endpoint:
 *
 *   GET /orders?updated_since=<iso>&after_id=<id>&limit=<n>
 *     -> { data: Order[], has_more: boolean }
 *
 * Rows are ordered by (updatedAt, id): the keyset that watukuy's timestamp cursor walks when
 * `tieBreak: 'id'` is set. The server also does two things real vendors do that break naive
 * pollers: it answers `304 Not Modified` to a matching `If-None-Match`, and every ~15th request
 * it answers `429` with `Retry-After: 2`. A timer mutates the dataset every 2 seconds so there
 * is always something to observe. Deletes are soft (`status: 'cancelled'`), like most ERPs.
 *
 * Shared by `examples/legacy-orders` and `examples/nestjs-app`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type OrderStatus = 'open' | 'paid' | 'shipped' | 'cancelled';

export interface ErpOrder {
  id: string;
  customer: string;
  status: OrderStatus;
  total: number;
  updatedAt: string;
}

export interface FakeErpOptions {
  /** Orders to seed; their `updatedAt` values are spread one minute apart in the past. @default 120 */
  seed?: number | undefined;
  /** How often the ERP changes its own data. `0` disables the timer. @default 2000 */
  mutateEveryMs?: number | undefined;
  /** Every Nth request answers 429. `0` disables. @default 15 */
  throttleEvery?: number | undefined;
  /** Receives one line per request. Silent by default. */
  log?: ((line: string) => void) | undefined;
  /**
   * JSON file holding the dataset. When present, the ERP restores it instead of seeding, so a
   * restart of the *consumer* does not reset the *vendor* (a real ERP keeps running). Unset =
   * in-memory only.
   */
  statePath?: string | undefined;
  /** Mutations applied right after a restore, simulating changes made while you were away. @default 3 */
  catchUp?: number | undefined;
}

export interface FakeErp {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  stats: { requests: number; notModified: number; throttled: number };
  /** Number of orders in the dataset right now. */
  readonly size: number;
  /** `true` when the dataset came from `statePath` rather than a fresh seed. */
  restored: boolean;
  close(): Promise<void>;
}

const CUSTOMERS = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay'];
const NEXT_STATUS: Record<OrderStatus, OrderStatus | null> = {
  open: 'paid',
  paid: 'shipped',
  shipped: null,
  cancelled: null,
};

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

export async function startFakeErp(opts: FakeErpOptions = {}): Promise<FakeErp> {
  const orders = new Map<string, ErpOrder>();
  const stats = { requests: 0, notModified: 0, throttled: 0 };
  const log = opts.log ?? (() => {});
  const throttleEvery = opts.throttleEvery ?? 15;
  let nextId = 1;

  const create = (updatedAt: string): void => {
    const id = `ord_${String(nextId++).padStart(4, '0')}`;
    const total = Math.round(1_000 + Math.random() * 90_000) / 100;
    orders.set(id, { id, customer: pick(CUSTOMERS), status: 'open', total, updatedAt });
  };

  const persist = (): void => {
    if (!opts.statePath) return;
    writeFileSync(opts.statePath, JSON.stringify({ nextId, orders: [...orders.values()] }));
  };

  // Restore the dataset when the consumer was restarted; otherwise seed history: one order per
  // minute in the past, so the first poll has pages to walk.
  const restored = opts.statePath !== undefined && existsSync(opts.statePath);
  if (restored) {
    const saved = JSON.parse(readFileSync(opts.statePath as string, 'utf8')) as {
      nextId: number;
      orders: ErpOrder[];
    };
    nextId = saved.nextId;
    for (const o of saved.orders) orders.set(o.id, o);
  } else {
    const seed = opts.seed ?? 120;
    const start = Date.now() - seed * 60_000;
    for (let i = 0; i < seed; i++) create(new Date(start + i * 60_000).toISOString());
    persist();
  }

  // The ERP's "users": create an order, advance a status, or cancel one (soft delete).
  // Every 10th tick starts a 3-tick quiet period (nobody touches the ERP for ~6s): that is when
  // you see 304s and the poller's adaptive interval grow.
  let ticks = 0;
  const mutate = (): void => {
    if (++ticks % 10 < 3 && ticks > 3) return;
    const now = new Date().toISOString();
    const live = [...orders.values()].filter((o) => NEXT_STATUS[o.status] !== null);
    const roll = Math.random();
    if (roll < 0.35 || live.length === 0) {
      create(now);
    } else if (roll < 0.85) {
      const o = pick(live);
      orders.set(o.id, { ...o, status: NEXT_STATUS[o.status] as OrderStatus, updatedAt: now });
    } else {
      const o = pick(live);
      orders.set(o.id, { ...o, status: 'cancelled', updatedAt: now });
    }
    persist();
  };
  // After a restore, the world moved on while the consumer was down: apply a few changes now.
  if (restored) for (let i = 0; i < (opts.catchUp ?? 3); i++) mutate();

  const every = opts.mutateEveryMs ?? 2_000;
  const timer = every > 0 ? setInterval(mutate, every) : null;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/orders') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    stats.requests++;

    // Rate limit: the client is expected to read Retry-After and back off exactly that long.
    if (throttleEvery > 0 && stats.requests % throttleEvery === 0) {
      stats.throttled++;
      log(`429 ${url.search}  Retry-After: 2`);
      res
        .writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
        .end('{"error":"rate limited"}');
      return;
    }

    const since = url.searchParams.get('updated_since');
    const afterId = url.searchParams.get('after_id');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const sinceMs = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);

    // Keyset filter on (updatedAt, id): strictly after the tuple when after_id is present,
    // inclusive on the timestamp otherwise (clients re-scan an overlap window anyway).
    const rows = [...orders.values()]
      .filter((o) => {
        const ms = Date.parse(o.updatedAt);
        if (ms !== sinceMs) return ms > sinceMs;
        return afterId === null ? true : o.id > afterId;
      })
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    const data = rows.slice(0, limit);
    const body = JSON.stringify({ data, has_more: rows.length > limit });

    // ETag = hash of the body: an identical result set costs zero bytes and counts as "idle".
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    if (req.headers['if-none-match'] === etag) {
      stats.notModified++;
      log(`304 ${url.search}`);
      res.writeHead(304, { etag }).end();
      return;
    }
    log(`200 ${url.search}  ${data.length} rows${rows.length > limit ? ' (has_more)' : ''}`);
    res.writeHead(200, { 'content-type': 'application/json', etag }).end(body);
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    get size() {
      return orders.size;
    },
    restored,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (timer) clearInterval(timer);
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
