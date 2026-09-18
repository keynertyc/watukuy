# legacy-orders

The headline demo. A "legacy ERP" that has no webhooks, only
`GET /orders?updated_since=...&after_id=...&limit=...`, becomes a stream of `created` /
`updated` events with one `definePoller` call. Everything runs in-process on `127.0.0.1`; no
network, no credentials.

```sh
pnpm demo                                   # from the repo root (builds first)
# or, after `pnpm install && pnpm build`:
pnpm --dir examples/legacy-orders start
node examples/legacy-orders/main.ts --duration 30   # exit after 30s (default: until Ctrl+C)
```

## What it shows

`main.ts` is a commented tutorial (about 170 lines):

| Piece | Where | Why it matters |
|---|---|---|
| zod schema as `schema` | step 2 | validates untrusted payloads, infers the `Order` type; any Standard Schema validator works |
| `cursor: { strategy: 'timestamp', field, tieBreak: 'id', overlap: '5s' }` | step 3 | composite keyset `(updatedAt, id)` so ties at a page edge are never skipped; the overlap re-scans the last 5s and dedups by version instead of re-emitting |
| `ctx.http.get(url, { query })` | step 3 | sends `If-None-Match`, exposes `res.notModified`, parses `Retry-After`; you may use plain `fetch` instead |
| `hasMore` | step 3 | first run pages through 120 historical orders in one cycle (3 pages of 50) |
| `schedule: { min: '1s', max: '10s' }` | step 3 | adaptive: halves after a cycle with changes, grows 1.5x when idle |
| `retain: 'payload'` | step 3 | `event.previous` on updates, so the consumer prints exactly which fields changed |
| `SqliteStore({ path })` + `engine.migrate()` | step 4 | zero-dependency durability; a restart resumes from the saved cursor |
| `engine.on('orders', handler)` | step 5 | one line per event, colored, with the field diff |
| `engine.inspect()` | step 6 | status line every 10s: lag, interval, circuit, outbox, items |
| `SIGINT` -> `engine.stop({ drain: true })` | step 6 | finish in-flight deliveries, persist, release the lease, close the file |

`fake-erp.ts` is the vendor: keyset ordering by `(updatedAt, id)` with `has_more`, `ETag` /
`304`, a `429` with `Retry-After: 2` every 15th request, soft deletes (`status: 'cancelled'`),
and a timer that changes something every 2 seconds (with a ~6s quiet period every 20s). It
persists its dataset to `legacy-orders.erp.json` so that restarting the demo does not reset
the "vendor"; on restore it applies three changes that "happened while you were away".

## What you will see

First run (fresh directory):

```
[erp] fake ERP at http://127.0.0.1:55746/orders (seeded 120 orders)
[watukuy] no saved cursor: first run, the whole history arrives as 'created'
+ created #   1 ord_0001  Vandelay open      $   719.42
+ created #   2 ord_0002  Acme     open      $   365.38
+ created #   3 ord_0003  Hooli    open      $   287.82
...
+ created # 119 ord_0119  Acme     open      $   673.86
+ created # 120 ord_0120  Acme     open      $    94.79
~ updated # 121 ord_0072  status: open -> cancelled
+ created # 122 ord_0121  Vandelay open      $   287.37
~ updated # 123 ord_0067  status: open -> cancelled
~ updated # 124 ord_0003  status: open -> cancelled
[status] lag=2.0s interval=1.5s circuit=closed pending=0 items=121 lastPoll=3 items/1 page | erp: 11 req, 0 x 304, 0 x 429
~ updated # 125 ord_0095  status: open -> paid
~ updated # 126 ord_0002  status: open -> cancelled
[watukuy] [orders] live cycle failed {
  error: 'GET http://127.0.0.1:55746/orders?updated_since=2026-09-18T19%3A37%3A47.094Z&limit=50 responded 429',
  code: 'HTTP',
  status: 429
}
~ updated # 127 ord_0089  status: open -> paid
~ updated # 128 ord_0118  status: open -> paid
[status] lag=2.0s interval=1.5s circuit=closed pending=0 items=121 lastPoll=3 items/1 page | erp: 19 req, 0 x 304, 1 x 429
~ updated # 130 ord_0039  status: open -> cancelled
~ updated # 131 ord_0084  status: open -> paid
[status] lag=2.0s interval=1.5s circuit=closed pending=0 items=121 lastPoll=2 items/1 page | erp: 24 req, 2 x 304, 1 x 429
~ updated # 132 ord_0076  status: open -> cancelled

[watukuy] --duration 32s elapsed: draining in-flight deliveries...
[watukuy] stopped. cursor saved at 2026-09-18T19:38:10.105Z; run again to resume.
```

Reading it:

- 120 `created` in the first cycle (three pages, `has_more` paging), then only changes.
- `~ updated ... status: open -> cancelled` in red is the ERP's soft delete. A timestamp poller
  never sees hard deletes; use `snapshotDiff` or a `reconcile` lane for those.
- The `429` line is the ERP throttling us. The engine treats it as a throttle, sleeps exactly
  `Retry-After`, does not count it as a failure (`circuit=closed`, no backoff), and keeps going.
- `2 x 304` appears after the ERP's quiet period: two consecutive polls asked for the same
  window, the second one sent `If-None-Match` and got no body back.
- `lag` is `now - cursor`; it hovers around the ERP's 2s mutation period.

Second run, same directory (Ctrl+C or `--duration`, then start again):

```
[erp] fake ERP at http://127.0.0.1:55777/orders (restored 122 orders)
[watukuy] resuming from saved cursor 2026-09-18T19:38:10.105Z
~ updated # 133 ord_0093  status: open -> paid
+ created # 134 ord_0122  Globex   open      $   193.69
~ updated # 135 ord_0057  status: open -> paid
~ updated # 136 ord_0093  status: paid -> shipped
~ updated # 137 ord_0045  status: open -> paid
...
[watukuy] --duration 16s elapsed: draining in-flight deliveries...
[watukuy] stopped. cursor saved at 2026-09-18T19:39:03.730Z; run again to resume.
```

No `created` flood: the sequence continues at `#133`, and the first three events are the
changes the ERP applied "while you were away". Delete `legacy-orders.db` and
`legacy-orders.erp.json` to start over.

## Things to try

- `ERP_LOG=1 pnpm demo` prints every request the ERP serves, including the `304`s and `429`s.
- Change `schedule.min` to `'250ms'` and watch `interval` drop after changes and climb back up
  during the quiet period.
- Remove `tieBreak: 'id'` and set the ERP's page size to 1 to see why keyset paging matters
  (items sharing a timestamp at a page edge would be skipped without it).
- Swap `SqliteStore` for `MemoryStore` (exported from `watukuy`) and restart: the whole history
  comes back as `created`, which is exactly what a durable cursor prevents.
