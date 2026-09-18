# multi-tenant

One `definePoller` definition, three tenants. `partitions()` fans the definition out into
independent `(poller, partition)` keys: each tenant has its own cursor, lease, adaptive interval
and circuit, and can be paused and resumed on its own. Events carry `event.partition`.

The backend is `FakeApi` from `watukuy/testing`, called directly (no HTTP), with the real clock.

## Run

```sh
pnpm install && pnpm build          # once, at the repo root
pnpm --dir examples/multi-tenant start
# or: node examples/multi-tenant/main.ts --duration 45
```

Runs for 30 seconds by default (`--duration <seconds>` to change).

## What happens

| t | action |
|---|---|
| 0s | `engine.start()`; a timer mutates a random tenant's invoices every 1.5s |
| 10s | `engine.pause('invoices', { partition: 't2' })`: Globex stops polling; Acme and Initech continue |
| 20s | `engine.resume('invoices', { partition: 't2' })`: Globex catches up in one burst |
| 30s | `engine.stop({ drain: true })` and exit |

## What you will see

```
[ops] started; 3 tenants, 3 invoices each. Watching for changes...
[t2 Globex ] created t2-inv-001     INV-0001 $301 draft
[t2 Globex ] created t2-inv-002     INV-0002 $986 draft
[t2 Globex ] created t2-inv-003     INV-0003 $726 draft
[t3 Initech] created t3-inv-001     INV-0001 $214 draft
[t3 Initech] created t3-inv-002     INV-0002 $836 draft
[t3 Initech] created t3-inv-003     INV-0003 $418 draft
[t1 Acme   ] created t1-inv-001     INV-0001 $760 draft
[t1 Acme   ] created t1-inv-002     INV-0002 $695 draft
[t1 Acme   ] created t1-inv-003     INV-0003 $894 draft
[t1 Acme   ] created t1-inv-004     INV-0004 $271 draft
[t3 Initech] updated t3-inv-001     status draft -> paid
[t1 Acme   ] created t1-inv-006     INV-0006 $448 draft
[ops] paused t2 (Globex); its changes now queue up at the API  t1:active items=6 pending=0  t2:PAUSED items=3 pending=0  t3:active items=3 pending=0
[t1 Acme   ] created t1-inv-007     INV-0007 $626 draft
[t1 Acme   ] updated t1-inv-001     status draft -> sent
[ops] resumed t2; expect a burst of Globex events  t1:active items=7 pending=0  t2:active items=3 pending=0  t3:active items=3 pending=0
[t2 Globex ] created t2-inv-004     INV-0004 $173 draft
[t2 Globex ] updated t2-inv-001     status draft -> sent
[t2 Globex ] created t2-inv-005     INV-0005 $408 draft
[t2 Globex ] created t2-inv-006     INV-0006 $986 draft
[t3 Initech] created t3-inv-004     INV-0004 $240 draft
[t2 Globex ] updated t2-inv-001     status sent -> paid
[ops] 30s elapsed: stopping
[ops] final  t1:active items=7 pending=0  t2:active items=7 pending=0  t3:active items=5 pending=0
```

Between the `paused` and `resumed` lines no `[t2 Globex]` events appear even though the
Globex data keeps changing; right after `resumed`, everything that changed in the meantime
arrives at once (`t2-inv-004`, `005`, `006` and the status changes). Note the burst contains
`draft -> sent` and `sent -> paid` for `t2-inv-001` as two events: the cursor moved past both
updates, and both versions were observed, so both are emitted in order.

## Things to try

- Add a fourth tenant to the `tenants` array while it runs: nothing happens until
  `partitionsRefresh` ('1m' here) re-runs `partitions()`. Lower it to see the pickup.
- Replace `MemoryStore` with `new SqliteStore({ path: './multi-tenant.db' })` from
  `watukuy/store-sqlite` and restart: every tenant resumes from its own cursor.
- Put a bogus tenant in the list whose `fetch` throws: only that partition's circuit opens;
  the others are unaffected (`engine.inspect()` shows `circuit: 'open'` for one row).
