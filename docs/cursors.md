# Cursor strategies

The cursor strategy answers "what did I already see?" for one poller. Pick it from what the API offers, not from what you wish it offered.

| Strategy | Use when the API has | Cursor passed to `fetch` | Next cursor | Deletes |
|---|---|---|---|---|
| `timestamp` | an `updated_since` (or `modified_after`) filter | `{ value: string \| null, tieBreak: string \| null }` | largest `field` in the page, with the largest `tieBreak` at that timestamp | via `reconcile` |
| `token` | an opaque `next` / `cursor` / `sync_token` | `{ value: string \| null }` | the page's `cursor`; `null` or `''` means caught up | via `reconcile` |
| `page` | page numbers | `{ page: number }` | `page + 1` while `hasMore`; resets to `initial` when the cycle completes | via `reconcile` |
| `snapshotDiff` | nothing usable | `null` | n/a, every cycle lists everything | **built in** |
| `custom` | anything else | your own type | your `advance()` | via `reconcile` |

`fetch` receives the cursor typed by strategy, plus `page` (1-based request index in this cycle), `partition`, `lane`, `http`, `signal`, `attempt`, and `logger`. It returns a `Page`: `{ items, cursor?, hasMore? }`. Return `hasMore: true` to make the runner fetch again immediately (catch-up mode).

## Decision guide

1. **Does the API filter by modification time?** Use `timestamp`. It is the cheapest incremental strategy and it exposes lag as a metric.
2. **Does it hand you an opaque cursor for "changes since"?** Use `token`. Store nothing else.
3. **Does it only page a listing, with no change filter?** If the listing is small enough to walk every cycle, use `snapshotDiff` and get deletes for free. If it is large, use `page` for the live lane and add `reconcile` for deletes on a slow cadence.
4. **Is it something else (offset + limit, GraphQL connections with `endCursor`, keyset over a numeric id)?** Use `customCursor()`.

Every strategy is combined with the identity → version map: an item that is fetched again with the same `version` (or the same fingerprint hash) is silently skipped. That is why overlap, re-listing, and page resets cost requests, never duplicate events.

## `timestamp`

```ts
import { definePoller } from 'watukuy';

interface Order { id: string; updatedAt: string; status: string }

const orders = definePoller({
  name: 'orders',
  identity: (o: Order) => o.id,
  version: (o) => o.updatedAt,
  cursor: {
    strategy: 'timestamp',
    field: 'updatedAt',              // dot paths allowed: 'meta.updatedAt'
    tieBreak: 'id',                  // default null
    initial: '2026-01-01T00:00:00Z', // or null to start from the beginning
    lag: '30s',                      // default 0
    overlap: '2m',                   // default 0
  },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://erp.example.com/orders', {
      query: { updated_since: cursor.value, after_id: cursor.tieBreak, limit: 500, sort: 'updatedAt,id' },
    });
    const body = await res.json<{ data: Order[]; has_more: boolean }>();
    return { items: body.data, hasMore: body.has_more };
  },
});
```

### How the watermark advances

After each page the strategy takes the **largest `field` value among the page's items** and stores the server's own string for it, never a re-serialized `Date`. If several items share that largest timestamp and `tieBreak` is set, it also stores the largest tie-break value among them. If the page's maximum equals the current watermark, only `tieBreak` grows. That is the composite keyset `(value, tieBreak)`.

Your `fetch` must request items with `field >= cursor.value` and, when `cursor.tieBreak` is non-null, `tieBreak > cursor.tieBreak` for items at exactly `cursor.value`. Most APIs express this as `updated_since` plus an `after_id`, or as a sort by `(updatedAt, id)` with a keyset filter.

### Pitfall 1: ties at the page boundary

An API returns pages of 100. Items 100 through 150 all have `updatedAt = 12:00:00`. With a plain watermark, the next request asks for `> 12:00:00` and skips fifty items, or asks for `>= 12:00:00` and re-fetches the same page forever. The composite keyset fixes both: the next request asks for `updatedAt >= 12:00:00 AND id > 'o0100'`.

If the API **cannot** filter by a second key, set `tieBreak: null` (the default) and rely on `overlap` to re-scan the boundary; the version map suppresses the re-seen items. This is the documented trade-off: correctness through extra requests.

### Pitfall 2: late commits (`lag`)

A row's `updatedAt` is stamped when the transaction starts, but the row becomes visible when it commits. If the watermark moves to `12:00:05` and a row stamped `12:00:03` commits at `12:00:07`, a naive poller never sees it. `lag: '30s'` makes the strategy **drop items newer than `now - 30s` from the page and from the watermark**; they are re-fetched next cycle. Pick a lag longer than the API's longest transaction plus clock skew.

### Pitfall 3: clock skew and re-scans (`overlap`)

`overlap: '2m'` hands `fetch` a cursor whose `value` is the stored watermark minus two minutes (formatted in the same shape as the stored string) with `tieBreak: null`. Everything in that window is re-fetched every cycle. Items with an unchanged `version` are skipped without hashing. The persisted cursor is not moved back; only the value passed to `fetch` is.

### Pitfall 4: timestamp formats (`parse` / `format`)

The default parser handles ISO 8601 (via `Date.parse`), 10-digit epoch seconds, and 13-digit epoch milliseconds. `format`, used only for the overlap arithmetic, mirrors whichever of the three shapes the stored string has. For anything else, supply both:

```ts
const cursor = {
  strategy: 'timestamp',
  field: 'modified',
  initial: null,
  overlap: '5m',
  parse: (raw: string) => Date.parse(raw.replace(' ', 'T') + 'Z'),          // '2026-01-01 12:00:00'
  format: (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
} as const;
```

An item whose `field` is missing or unparseable is still diffed but never moves the watermark. A cursor value that cannot be parsed throws a `ConfigError` naming the field and the raw string.

### Pitfall 5: `initial`

`initial` is the API's own string, or `null` for "from the beginning". The first request is made with `cursor.value === initial`; handle `null` in your query (`updated_since: cursor.value` sends nothing when `null`, because the HTTP helper drops `null` and `undefined` query values).

### Overriding the watermark

If `fetch` returns a string `cursor`, the strategy trusts it as the new watermark, sets `tieBreak` to `null`, and applies no `lag` filtering. Use this when the API tells you the server time of the response and you would rather trust that than the maximum item timestamp.

### Lag as a metric

`inspect().pollers[i].lagMs` is `now - parse(cursor.value)` for timestamp pollers, `null` for others. Alert on it.

## `token`

```ts
interface Invoice { id: string; etag: string }

const invoices = definePoller({
  name: 'invoices',
  identity: (i: Invoice) => i.id,
  version: (i) => i.etag,
  cursor: { strategy: 'token', initial: null },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://api.vendor.com/invoices', {
      query: { cursor: cursor.value ?? undefined },
    });
    const body = await res.json<{ data: Invoice[]; next: string | null }>();
    return { items: body.data, cursor: body.next };
  },
});
```

- A non-empty string `cursor` becomes the next cursor and the cycle continues, unless the page says `hasMore: false`. That second form is the "sync token" pattern: the API hands back a token to use next time together with "nothing more right now".
- `null`, `undefined`, or `''` means the listing is exhausted: the cycle is done and the cursor resets to `initial`, so the next cycle starts over. If the API is a true change feed whose last token should be kept, return `{ items, cursor: body.next, hasMore: false }` instead.

## `page`

```ts
const products = definePoller({
  name: 'products',
  identity: (p: { sku: string }) => p.sku,
  cursor: { strategy: 'page', initial: 1 },
  fetch: async ({ cursor, http }) => {
    const res = await http.get(`https://vendor.example.com/products?page=${cursor.page}`);
    const body = await res.json<{ items: { sku: string }[]; pages: number }>();
    return { items: body.items, hasMore: cursor.page < body.pages };
  },
});
```

Advances `page + 1` while `hasMore: true`; when the cycle completes it resets to `initial` (default `1`). The `page` strategy is also what the reconcile lane uses internally, always from 1.

## `snapshotDiff`

```ts
const catalog = definePoller({
  name: 'catalog',
  identity: (p: { sku: string; price: number }) => p.sku,
  cursor: { strategy: 'snapshotDiff' },
  fetch: async ({ page, http }) => {
    const res = await http.get(`https://vendor.example.com/products?page=${page}`);
    const body = await res.json<{ items: { sku: string; price: number }[]; pages: number }>();
    return { items: body.items, hasMore: page < body.pages };
  },
  schedule: { min: '10m', max: '6h' },
  retain: 'payload', // deleted events carry the last known payload
});
```

Every cycle lists everything (using `ctx.page` for pagination), hashes each item, diffs against the stored snapshot, and after the last page emits `deleted` for every stored identity that was not listed. Memory per cycle is one page plus a `Set` of identity strings.

Rules that matter operationally:

- `maxPagesPerCycle` (default 50) must be at least the number of pages in the full listing. A truncated scan emits no deletes and restarts from page 1 next cycle.
- A `304 Not Modified` from `ctx.http` is treated as "identical to last time", not as an empty listing. No deletes are emitted.
- `reconcile` is rejected with a `ConfigError` (redundant), and so is `backfill()`.
- With a `tick()` deadline, a scan that does not finish within `maxDuration` is truncated the same way.

## `custom`

`customCursor()` gives you full type inference: the cursor type comes from `initial` and flows into `advance()` and `fetch({ cursor })`.

```ts
import { customCursor, definePoller } from 'watukuy';

interface Row { id: number; name: string }

const rows = definePoller({
  name: 'rows',
  identity: (r: Row) => String(r.id),
  cursor: customCursor({
    initial: { afterId: 0 },
    advance: ({ cursor, items }) => {
      const last = items.at(-1) as Row | undefined;
      return last
        ? { cursor: { afterId: last.id }, done: items.length < 100 }
        : { cursor, done: true };
    },
  }),
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://api.example.com/rows', {
      query: { after_id: cursor.afterId, limit: 100 },
    });
    return { items: await res.json<Row[]>() };
  },
});
```

`advance` receives `{ cursor, items, pageCursor, hasMore }` (`items` are the validated items of the page, `pageCursor` and `hasMore` are what `fetch` returned) and must return `{ cursor, done }`. `serialize` / `deserialize` default to JSON; supply them for cursors that do not round-trip through JSON (BigInt, Date). For backfill and `resetCursor`, the raw string you pass is fed through `deserialize` (or `JSON.parse`), and `null` yields `initial`.

## Reconcile: deletes for incremental strategies

```ts
const orders = definePoller({
  name: 'orders',
  identity: (o: Order) => o.id,
  version: (o) => o.updatedAt,
  cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
  fetch: async ({ cursor, http }) => {
    const res = await http.get('https://erp.example.com/orders', {
      query: { updated_since: cursor.value, after_id: cursor.tieBreak },
    });
    return { items: await res.json<Order[]>() };
  },
  reconcile: {
    every: '6h',
    fetch: async ({ page, http }) => {
      const res = await http.get('https://erp.example.com/orders', { query: { page, limit: 1000 } });
      const body = await res.json<{ data: Order[]; has_more: boolean }>();
      return { items: body.data, hasMore: body.has_more };
    },
  },
});
```

The reconcile lane runs under the same lease and budget at lower priority than live. It lists everything with `reconcile.fetch` (paged via `ctx.page`), emits `created` for unknown identities, `updated` for hash mismatches, and `deleted` for stored identities absent from the listing. The first reconcile runs on the first cycle; later ones when `every` has elapsed since the last completed run. Events are tagged `lane: 'reconcile'`.

## Cursors in the store and in operations

- Cursors are persisted per lane as JSON text (`inspect().pollers[i].cursors.live` shows the parsed value).
- `engine.resetCursor(name, { to, clearSnapshot? })` takes the API's own raw string (`to: '2026-01-01T00:00:00Z'`, `to: '17'` for a page, a token string) or `null` for the strategy's initial cursor. `clearSnapshot: true` also drops the item rows so everything is re-emitted as `created` with the same ids.
- `engine.backfill(name, { from, to?, force? })` uses the same raw form for `from` and `to`.

Related: [how-it-works.md](./how-it-works.md), [runbook.md](./runbook.md), [recipes.md](./recipes.md).
