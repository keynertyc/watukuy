/**
 * Multi-tenant polling: one poller definition, three tenants.
 *
 * `partitions()` fans the definition out into N independent (poller, partition) keys. Each
 * tenant gets its own cursor, lease, adaptive interval and circuit, and can be paused and
 * resumed on its own. Events carry `event.partition` so a consumer can route per tenant.
 *
 * The backend is `FakeApi` from `watukuy/testing`: an in-memory third-party API, called
 * directly (no HTTP) so the example stays about partitions. Timeline:
 *
 *   t=0s   start; a timer mutates a random tenant's invoices every 1.5s
 *   t=10s  engine.pause('invoices', { partition: 't2' })   -> t2 stops polling, t1/t3 continue
 *   t=20s  engine.resume('invoices', { partition: 't2' })  -> t2 catches up in one burst
 *   t=30s  exit (override with --duration <seconds>)
 */
import { type Clock, createWatukuy, definePoller, MemoryStore } from 'watukuy';
import { FakeApi } from 'watukuy/testing';

interface Invoice {
  id: string;
  number: string;
  amount: number;
  status: 'draft' | 'sent' | 'paid';
  updatedAt: string;
  [extra: string]: unknown; // FakeApi items are Record<string, unknown>
}

/** A tenant record: what your database would hold. `data` is handed to `fetch` untouched. */
interface Tenant {
  id: string;
  name: string;
  api: FakeApi<Invoice>; // in real life: a base URL and a token
}

// FakeApi takes a Clock so tests can freeze time; here we simply pass the real one.
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const tenants: Tenant[] = [
  { id: 't1', name: 'Acme' },
  { id: 't2', name: 'Globex' },
  { id: 't3', name: 'Initech' },
].map((t) => ({
  ...t,
  api: new FakeApi<Invoice>({ clock, identity: (inv) => inv.id, timestampField: 'updatedAt' }),
}));

const counters = new Map<string, number>();
function addInvoice(tenant: Tenant): void {
  const n = (counters.get(tenant.id) ?? 0) + 1;
  counters.set(tenant.id, n);
  const id = `${tenant.id}-inv-${String(n).padStart(3, '0')}`;
  tenant.api.add({
    id,
    number: `INV-${String(n).padStart(4, '0')}`,
    amount: Math.round(50 + Math.random() * 950),
    status: 'draft',
    updatedAt: '', // FakeApi stamps timestampField with the clock's time
  });
}
for (const tenant of tenants) for (let i = 0; i < 3; i++) addInvoice(tenant);

// ---------------------------------------------------------------- the poller
const invoices = definePoller({
  name: 'invoices',
  identity: (inv: Invoice) => inv.id,
  version: (inv) => inv.updatedAt,
  cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },

  // One partition per tenant. Called at start and every `partitionsRefresh`, so tenants
  // added to your database later are picked up without a restart. `data` is never persisted:
  // put credentials here freely.
  partitions: () => tenants.map((tenant) => ({ key: tenant.id, data: tenant })),
  partitionsRefresh: '1m',

  fetch: async ({ cursor, partition }) => {
    // `partition.data` is the Tenant above; `cursor` is this tenant's own watermark.
    const page = partition.data.api.listSince({
      since: cursor.value,
      afterId: cursor.tieBreak,
      limit: 50,
    });
    return { items: page.items, hasMore: page.hasMore };
  },

  schedule: { min: '1s', max: '5s' },
  retain: 'payload',
});

const engine = createWatukuy({ store: new MemoryStore(), pollers: { invoices } });

// ---------------------------------------------------------------- consume
const tenantName = (key: string): string => tenants.find((t) => t.id === key)?.name ?? key;
engine.on('invoices', (event) => {
  const who = `[${event.partition} ${tenantName(event.partition).padEnd(7)}]`;
  const inv = event.data as Invoice;
  const change =
    event.type === 'updated' && event.previous
      ? `status ${event.previous.status} -> ${inv.status}`
      : `${inv.number} $${inv.amount} ${inv.status}`;
  console.log(`${who} ${event.type.padEnd(7)} ${event.subject.padEnd(14)} ${change}`);
});

// ---------------------------------------------------------------- run
await engine.start();
console.log('[ops] started; 3 tenants, 3 invoices each. Watching for changes...');

// Simulated activity: every 1.5s a random tenant creates or advances an invoice.
const NEXT: Record<Invoice['status'], Invoice['status'] | null> = {
  draft: 'sent',
  sent: 'paid',
  paid: null,
};
const activity = setInterval(() => {
  const tenant = tenants[Math.floor(Math.random() * tenants.length)] as Tenant;
  const open = tenant.api.all().filter((inv) => NEXT[inv.status] !== null);
  if (open.length === 0 || Math.random() < 0.4) addInvoice(tenant);
  else {
    const inv = open[Math.floor(Math.random() * open.length)] as Invoice;
    tenant.api.update(inv.id, { status: NEXT[inv.status] as Invoice['status'] });
  }
}, 1_500);

// Per-partition status from inspect(): each row is one (poller, partition) key.
async function printStatus(label: string): Promise<void> {
  const report = await engine.inspect();
  const rows = report.pollers.map(
    (p) =>
      `${p.partition}:${p.paused ? 'PAUSED' : 'active'} items=${p.items} pending=${p.outboxPending}`,
  );
  console.log(`[ops] ${label}  ${rows.join('  ')}`);
}

// Operations target a single partition; the other tenants are unaffected.
setTimeout(async () => {
  await engine.pause('invoices', { partition: 't2' });
  await printStatus('paused t2 (Globex); its changes now queue up at the API');
}, 10_000);
setTimeout(async () => {
  await engine.resume('invoices', { partition: 't2' });
  await printStatus('resumed t2; expect a burst of Globex events');
}, 20_000);

const flag = process.argv.indexOf('--duration');
const durationSec = flag === -1 ? 30 : Number(process.argv[flag + 1] ?? 30);
async function shutdown(reason: string): Promise<void> {
  clearInterval(activity);
  console.log(`[ops] ${reason}: stopping`);
  await engine.stop({ drain: true });
  await printStatus('final');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
if (durationSec > 0)
  setTimeout(() => void shutdown(`${durationSec}s elapsed`), durationSec * 1_000);
