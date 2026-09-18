/**
 * watukuy demo: turn a legacy ERP's polling endpoint into a stream of change events.
 *
 *   pnpm demo                      # from the repo root (builds first)
 *   node main.ts --duration 30     # exit after 30 seconds (default: run until Ctrl+C)
 *
 * Stop it with Ctrl+C and start it again: the cursor lives in SQLite, so the second run
 * resumes where the first one stopped instead of re-emitting the whole history.
 */
import { fileURLToPath } from 'node:url';
import { createWatukuy, definePoller, type WatukuyEvent } from 'watukuy';
import { SqliteStore } from 'watukuy/store-sqlite';
import { z } from 'zod';
import { startFakeErp } from './fake-erp.ts';

// Tiny ANSI helpers (respect NO_COLOR and pipes).
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const ESC = String.fromCharCode(27); // escape byte, kept out of the source as a raw control char
const paint = (code: number) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const [green, yellow, red, dim, bold] = [paint(32), paint(33), paint(31), paint(2), paint(1)];

// ---------------------------------------------------------------- 1. the third-party API
// In real life this is the vendor's server. Here it runs in-process on a random port and
// mutates its own data every 2 seconds. Set ERP_LOG=1 to see every request it serves.
const erp = await startFakeErp({
  // The ERP keeps its data in a JSON file: restarting *this* demo must not reset the vendor.
  statePath: fileURLToPath(new URL('./legacy-orders.erp.json', import.meta.url)),
  log: process.env.ERP_LOG ? (line) => console.log(dim(`[erp] ${line}`)) : undefined,
});
console.log(
  `${dim('[erp]')} fake ERP at ${erp.url}/orders (${erp.restored ? 'restored' : 'seeded'} ${erp.size} orders)`,
);

// ---------------------------------------------------------------- 2. describe one item
// Any Standard Schema validator works (zod, valibot, arktype...). It validates untrusted
// payloads at runtime and gives `definePoller` the `Order` type for free.
const Order = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.enum(['open', 'paid', 'shipped', 'cancelled']),
  total: z.number(),
  updatedAt: z.iso.datetime(),
});
type Order = z.infer<typeof Order>;

// ---------------------------------------------------------------- 3. describe how to poll
const orders = definePoller({
  name: 'orders',
  schema: Order,
  identity: (o) => o.id, // stable id per item
  version: (o) => o.updatedAt, // cheap change detection; defaults to a content hash

  cursor: {
    strategy: 'timestamp', // "updated_since"-style API
    field: 'updatedAt',
    tieBreak: 'id', // composite keyset (updatedAt, id): ties at a page edge are never skipped
    initial: null, // null = start from the beginning of history
    overlap: '5s', // re-scan the last 5s every cycle; re-seen versions are suppressed, not re-emitted
  },

  fetch: async ({ cursor, http, signal }) => {
    // `http` is watukuy's helper: it sends If-None-Match, parses Retry-After and RateLimit
    // headers, and charges budgets. You may ignore it and call fetch() yourself.
    const res = await http.get(`${erp.url}/orders`, {
      query: { updated_since: cursor.value, after_id: cursor.tieBreak, limit: 50 },
      signal,
    });
    if (res.notModified) return { items: [] }; // ETag hit: nothing changed, counts as idle
    const body = await res.json<{ data: unknown[]; has_more: boolean }>();
    return { items: body.data, hasMore: body.has_more }; // hasMore: keep paging right now
  },

  schedule: { min: '1s', max: '10s' }, // adaptive: speeds up on changes, backs off when idle
  retain: 'payload', // keep the last payload so `event.previous` is available on updates
});

// ---------------------------------------------------------------- 4. the engine
// SQLite: zero dependencies (node:sqlite), one file next to this script. Survives restarts.
const dbPath = fileURLToPath(new URL('./legacy-orders.db', import.meta.url));
const store = new SqliteStore({ path: dbPath });
const engine = createWatukuy({ store, pollers: { orders } });
await engine.migrate(); // idempotent: creates the tables on the first run

// ---------------------------------------------------------------- 5. consume events
// One line per change. `event.type` is 'created' | 'updated' | 'deleted'; `event.data` is a
// validated Order; `event.previous` is the last payload we saw (because retain: 'payload').
engine.on('orders', (event) => console.log(formatEvent(event)));

function formatEvent(event: WatukuyEvent<Order>): string {
  const tag = `${dim(`#${String(event.sequence).padStart(4)}`)} ${event.subject}`;
  switch (event.type) {
    case 'created': {
      const o = event.data as Order;
      return `${green('+ created')} ${tag}  ${o.customer.padEnd(8)} ${o.status.padEnd(9)} ${money(o.total)}`;
    }
    case 'updated': {
      // Timestamp pollers never see hard deletes; a soft delete shows up as an update.
      const color = event.data?.status === 'cancelled' ? red : yellow;
      return `${color('~ updated')} ${tag}  ${diff(event.previous, event.data)}`;
    }
    case 'deleted':
      // Only emitted by snapshotDiff pollers or a `reconcile` lane; kept here for completeness.
      return `${red('- deleted')} ${tag}  ${event.data ? `last seen ${event.data.status}` : ''}`;
  }
}

/** "status: open -> paid, total: 10 -> 12" from the previous and current payloads. */
function diff(previous: Order | undefined, next: Order | undefined): string {
  if (!previous || !next) return '';
  return (Object.keys(next) as Array<keyof Order>)
    .filter((k) => k !== 'updatedAt' && previous[k] !== next[k])
    .map((k) => `${k}: ${dim(String(previous[k]))} -> ${bold(String(next[k]))}`)
    .join(', ');
}

const money = (n: number): string => `$${n.toFixed(2).padStart(9)}`;
const secs = (n: number | null): string => (n === null ? '-' : `${(n / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- 6. run
// Everything the engine knows is in the store, so a restart is just "start again".
const before = await engine.inspect();
const saved = before.pollers[0]?.cursors.live as { value: string | null } | undefined;
console.log(
  saved?.value
    ? `${dim('[watukuy]')} resuming from saved cursor ${bold(saved.value)}`
    : `${dim('[watukuy]')} no saved cursor: first run, the whole history arrives as 'created'`,
);
await engine.start();

// A status line every 10s straight from `engine.inspect()` (the same data /healthz would use).
const status = setInterval(async () => {
  const p = (await engine.inspect()).pollers[0];
  if (!p) return;
  const last = p.lastPoll
    ? `${p.lastPoll.items} items/${p.lastPoll.pages} page${p.lastPoll.notModified ? ', 304' : ''}`
    : '-';
  console.log(
    dim(
      `[status] lag=${secs(p.lagMs)} interval=${secs(p.schedule.intervalMs)} circuit=${p.schedule.circuit} ` +
        `pending=${p.outboxPending} items=${p.items} lastPoll=${last} | erp: ${erp.stats.requests} req, ` +
        `${erp.stats.notModified} x 304, ${erp.stats.throttled} x 429`,
    ),
  );
}, 10_000);

// Graceful shutdown: finish in-flight deliveries, persist, release the lease, close the file.
let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(status);
  console.log(`\n${dim('[watukuy]')} ${reason}: draining in-flight deliveries...`);
  await engine.stop({ drain: true, timeout: '10s' });
  const live = (await engine.inspect()).pollers[0]?.cursors.live as { value: string | null };
  await store.close();
  await erp.close();
  console.log(
    `${dim('[watukuy]')} stopped. cursor saved at ${bold(String(live?.value))}; run again to resume.`,
  );
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const flag = process.argv.indexOf('--duration');
const durationSec = flag === -1 ? 0 : Number(process.argv[flag + 1] ?? 0);
if (durationSec > 0) {
  setTimeout(() => void shutdown(`--duration ${durationSec}s elapsed`), durationSec * 1_000);
}
