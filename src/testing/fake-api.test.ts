import { describe, expect, it } from 'vitest';
import { HttpError } from '../core/errors.ts';
import { FakeApi, type FakeApiOptions, type FakeItem, fakeItems } from './fake-api.ts';
import { VirtualClock } from './virtual-clock.ts';

type Order = FakeItem;

const START = Date.UTC(2026, 0, 1);

function setup(overrides: Partial<FakeApiOptions<Order>> = {}) {
  const clock = new VirtualClock();
  const api = new FakeApi<Order>({
    clock,
    identity: (o) => o.id,
    timestampField: 'updatedAt',
    ...overrides,
  });
  return { clock, api, fetch: api.fetchImpl() };
}

const order = (id: string, value = 0): Order => ({ id, name: `Order ${id}`, value, updatedAt: '' });

/** Track a promise's state without awaiting it. */
function track<T>(p: Promise<T>) {
  const state = {
    status: 'pending' as 'pending' | 'resolved' | 'rejected',
    error: undefined as unknown,
  };
  const tracked = p.then(
    (v) => {
      state.status = 'resolved';
      return v;
    },
    (e: unknown) => {
      state.status = 'rejected';
      state.error = e;
      throw e;
    },
  );
  tracked.catch(() => undefined);
  return { state, promise: tracked };
}

describe('FakeApi', () => {
  describe('dataset', () => {
    it('add() stamps the timestamp field with the clock time and returns a copy', () => {
      const { api, clock } = setup();
      const stored = api.add(order('a'));
      expect(stored.updatedAt).toBe(clock.iso());
      stored.value = 99;
      expect(api.get('a')?.value).toBe(0);
      expect(api.size).toBe(1);
    });

    it('add() rejects duplicate identities', () => {
      const { api } = setup();
      api.add(order('a'));
      expect(() => api.add(order('a'))).toThrow(/already exists/);
    });

    it('update() merges the patch, bumps the timestamp and returns a copy', async () => {
      const { api, clock } = setup();
      api.add(order('a', 1));
      await clock.advance(5_000);
      const updated = api.update('a', { value: 2 });
      expect(updated).toEqual({
        id: 'a',
        name: 'Order a',
        value: 2,
        updatedAt: '2026-01-01T00:00:05.000Z',
      });
      expect(api.get('a')).toEqual(updated);
    });

    it('update() throws for a missing item or an identity change', () => {
      const { api } = setup();
      api.add(order('a'));
      expect(() => api.update('nope', { value: 1 })).toThrow(/no item 'nope'/);
      expect(() => api.update('a', { id: 'b' } as Partial<Order>)).toThrow(/change identity/);
      expect(api.get('a')).toBeDefined();
    });

    it('remove() reports whether something was deleted', () => {
      const { api } = setup();
      api.add(order('a'));
      expect(api.remove('a')).toBe(true);
      expect(api.remove('a')).toBe(false);
      expect(api.get('a')).toBeUndefined();
      expect(api.size).toBe(0);
    });

    it('all() returns copies ordered by identity', () => {
      const { api } = setup();
      api.add(order('c'));
      api.add(order('a'));
      api.add(order('b'));
      const all = api.all();
      expect(all.map((o) => o.id)).toEqual(['a', 'b', 'c']);
      all[0]!.value = 42;
      expect(api.get('a')?.value).toBe(0);
    });

    it('seed() replaces the dataset, keeping existing timestamps and filling missing ones', () => {
      const { api, clock } = setup();
      api.add(order('old'));
      api.seed([
        { id: 'x', name: 'x', value: 1, updatedAt: '2025-06-01T00:00:00.000Z' },
        { id: 'y', name: 'y', value: 2 } as unknown as Order,
      ]);
      expect(api.get('old')).toBeUndefined();
      expect(api.get('x')?.updatedAt).toBe('2025-06-01T00:00:00.000Z');
      expect(api.get('y')?.updatedAt).toBe(clock.iso());
      expect(api.size).toBe(2);
    });

    it('constructor items follow seed() semantics', () => {
      const items = fakeItems(3);
      const { api } = setup({ items });
      expect(api.all()).toEqual(items);
    });

    it('does not touch items when no timestampField is configured', () => {
      const { api } = setup({ timestampField: undefined });
      const stored = api.add({ id: 'a', name: 'a', value: 1, updatedAt: 'keep' });
      expect(stored.updatedAt).toBe('keep');
    });

    it('dataset operations are not counted as requests', () => {
      const { api } = setup();
      api.add(order('a'));
      api.update('a', { value: 1 });
      api.get('a');
      api.all();
      api.remove('a');
      expect(api.calls).toBe(0);
      expect(api.log).toEqual([]);
    });
  });

  describe('listSince (keyset)', () => {
    async function tiedDataset() {
      const { api, clock } = setup();
      // t0: a, b, c share a timestamp; t1: d, e; t2: f
      api.add(order('c'));
      api.add(order('a'));
      api.add(order('b'));
      await clock.advance(1_000);
      api.add(order('e'));
      api.add(order('d'));
      await clock.advance(1_000);
      api.add(order('f'));
      const t0 = new Date(START).toISOString();
      const t1 = new Date(START + 1_000).toISOString();
      return { api, clock, t0, t1 };
    }

    it('since: null returns everything ordered by (timestamp, identity)', async () => {
      const { api } = await tiedDataset();
      const page = api.listSince({ since: null });
      expect(page.items.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      expect(page.hasMore).toBe(false);
    });

    it('since is inclusive (>=)', async () => {
      const { api, t1 } = await tiedDataset();
      expect(api.listSince({ since: t1 }).items.map((o) => o.id)).toEqual(['d', 'e', 'f']);
    });

    it('afterId skips ties at the since timestamp with identity <= afterId', async () => {
      const { api, t0 } = await tiedDataset();
      const page = api.listSince({ since: t0, afterId: 'b' });
      expect(page.items.map((o) => o.id)).toEqual(['c', 'd', 'e', 'f']);
    });

    it('afterId does not skip items with a later timestamp even if their id is smaller', async () => {
      const { api, t1 } = await tiedDataset();
      // 'f' > 'e' at t2 but also everything at t2 must appear regardless of id ordering
      const page = api.listSince({ since: t1, afterId: 'e' });
      expect(page.items.map((o) => o.id)).toEqual(['f']);
    });

    it('a page boundary inside a group of ties resumes without duplicates or gaps', async () => {
      const { api, t0 } = await tiedDataset();
      const first = api.listSince({ since: null, limit: 2 });
      expect(first.items.map((o) => o.id)).toEqual(['a', 'b']);
      expect(first.hasMore).toBe(true);
      const last = first.items.at(-1)!;
      expect(last.updatedAt).toBe(t0);
      const second = api.listSince({ since: last.updatedAt, afterId: last.id, limit: 2 });
      expect(second.items.map((o) => o.id)).toEqual(['c', 'd']);
      expect(second.hasMore).toBe(true);
      const third = api.listSince({
        since: second.items.at(-1)!.updatedAt,
        afterId: second.items.at(-1)!.id,
        limit: 2,
      });
      expect(third.items.map((o) => o.id)).toEqual(['e', 'f']);
      expect(third.hasMore).toBe(false);
    });

    it('a full keyset walk visits every item exactly once with many ties', async () => {
      const { api, clock } = setup();
      const ids: string[] = [];
      for (let group = 0; group < 4; group++) {
        for (let i = 0; i < 5; i++) {
          const id = `g${group}-${i}`;
          ids.push(id);
          api.add(order(id));
        }
        await clock.advance(1_000);
      }
      const seen: string[] = [];
      let since: string | null = null;
      let afterId: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const page = api.listSince({ since, afterId, limit: 3 });
        seen.push(...page.items.map((o) => o.id));
        if (!page.hasMore) break;
        const last = page.items.at(-1)!;
        since = last.updatedAt;
        afterId = last.id;
      }
      expect(seen).toEqual(ids.slice().sort());
    });

    it('hasMore reflects whether items remain beyond the page', async () => {
      const { api } = await tiedDataset();
      expect(api.listSince({ since: null, limit: 6 }).hasMore).toBe(false);
      expect(api.listSince({ since: null, limit: 5 }).hasMore).toBe(true);
    });

    it('validates its inputs', async () => {
      const { api } = await tiedDataset();
      expect(() => api.listSince({ since: 'not a date' })).toThrow(RangeError);
      expect(() => api.listSince({ since: null, limit: 0 })).toThrow(RangeError);
      expect(() => api.listSince({ since: null, limit: 1.5 })).toThrow(RangeError);
    });

    it('requires timestampField', () => {
      const { api } = setup({ timestampField: undefined });
      expect(() => api.listSince({ since: null })).toThrow(/timestampField/);
    });

    it('uses pageSize as the default limit', () => {
      const { api } = setup({ pageSize: 2, items: fakeItems(5) });
      const page = api.listSince({ since: null });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
    });
  });

  describe('listPage', () => {
    it('pages 1-based by identity and reports totals', () => {
      const { api } = setup({ items: fakeItems(7) });
      const p1 = api.listPage({ page: 1, limit: 3 });
      expect(p1.items.map((o) => o.id)).toEqual(['item-001', 'item-002', 'item-003']);
      expect(p1).toMatchObject({ hasMore: true, pages: 3 });
      const p3 = api.listPage({ page: 3, limit: 3 });
      expect(p3.items.map((o) => o.id)).toEqual(['item-007']);
      expect(p3.hasMore).toBe(false);
    });

    it('returns an empty page past the end and 1 page for an empty dataset', () => {
      const { api } = setup({ items: fakeItems(2) });
      expect(api.listPage({ page: 5, limit: 2 })).toEqual({ items: [], hasMore: false, pages: 1 });
      const empty = setup().api;
      expect(empty.listPage({ page: 1 })).toEqual({ items: [], hasMore: false, pages: 1 });
    });

    it('rejects invalid page numbers', () => {
      const { api } = setup();
      expect(() => api.listPage({ page: 0 })).toThrow(RangeError);
      expect(() => api.listPage({ page: 1.5 })).toThrow(RangeError);
    });
  });

  describe('listToken', () => {
    it('walks the dataset with opaque tokens until next is null', () => {
      const { api } = setup({ items: fakeItems(5) });
      const seen: string[] = [];
      let token: string | null = null;
      let pages = 0;
      do {
        const page = api.listToken({ token, limit: 2 });
        seen.push(...page.items.map((o) => o.id));
        token = page.next;
        pages++;
      } while (token);
      expect(pages).toBe(3);
      expect(seen).toEqual(fakeItems(5).map((o) => o.id));
    });

    it('tokens are base64-encoded offsets', () => {
      const { api } = setup({ items: fakeItems(5) });
      const page = api.listToken({ token: null, limit: 2 });
      expect(atob(page.next as string)).toBe('2');
    });

    it('rejects tokens it did not issue', () => {
      const { api } = setup({ items: fakeItems(5) });
      expect(() => api.listToken({ token: '!!!' })).toThrow(RangeError);
      expect(() => api.listToken({ token: btoa('-1') })).toThrow(RangeError);
      expect(() => api.listToken({ token: btoa('abc') })).toThrow(RangeError);
    });

    it('empty dataset yields no items and no next token', () => {
      const { api } = setup();
      expect(api.listToken({ token: null })).toEqual({ items: [], next: null });
    });
  });

  describe('listAll', () => {
    it('returns everything by identity and counts as one request', () => {
      const { api } = setup({ items: fakeItems(3) });
      expect(api.listAll().map((o) => o.id)).toEqual(['item-001', 'item-002', 'item-003']);
      expect(api.calls).toBe(1);
      expect(api.log[0]).toMatchObject({ route: 'all', status: 200 });
    });
  });

  describe('faults on direct methods', () => {
    it('consumes queued faults in order, then serves normally', () => {
      const { api } = setup({ items: fakeItems(2) });
      api.failNext({ kind: 'http', status: 500 });
      api.failNext({ kind: 'network' });
      expect(api.pendingFaults()).toBe(2);

      let first: unknown;
      try {
        api.listAll();
      } catch (e) {
        first = e;
      }
      expect(first).toBeInstanceOf(HttpError);
      expect((first as HttpError).status).toBe(500);

      expect(() => api.listAll()).toThrow(TypeError);
      expect(api.listAll()).toHaveLength(2);
      expect(api.pendingFaults()).toBe(0);
      expect(api.calls).toBe(3);
      expect(api.log.map((e) => e.status)).toEqual([500, 0, 200]);
    });

    it('times repeats the same fault', () => {
      const { api } = setup();
      api.failNext({ kind: 'network', message: 'ECONNRESET' }, 2);
      expect(() => api.listAll()).toThrow('ECONNRESET');
      expect(() => api.listAll()).toThrow('ECONNRESET');
      expect(api.listAll()).toEqual([]);
    });

    it('http faults carry retryAfterMs and problem details into HttpError', () => {
      const { api } = setup();
      api.failNext({ kind: 'http', status: 429, retryAfterMs: 7_000 });
      try {
        api.listSince({ since: null });
        expect.fail('should throw');
      } catch (e) {
        const err = e as HttpError;
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(429);
        expect(err.retryAfterMs).toBe(7_000);
        expect(err.isThrottle).toBe(true);
        expect(err.problem).toEqual({ title: 'Fault', status: 429 });
        expect(err.url).toBe('https://fake.api/since');
      }
    });

    it('timeout and malformed faults throw the documented errors', () => {
      const { api } = setup();
      api.failNext({ kind: 'timeout' });
      api.failNext({ kind: 'malformed' });
      try {
        api.listAll();
        expect.fail('should throw');
      } catch (e) {
        expect((e as Error).name).toBe('TimeoutError');
      }
      expect(() => api.listAll()).toThrow(SyntaxError);
    });

    it('clearFaults drops the queue and failNext validates times', () => {
      const { api } = setup();
      api.failNext({ kind: 'network' }, 3);
      api.clearFaults();
      expect(api.pendingFaults()).toBe(0);
      expect(api.listAll()).toEqual([]);
      expect(() => api.failNext({ kind: 'network' }, 0)).toThrow(RangeError);
    });

    it('logs 400 for invalid parameters and rethrows', () => {
      const { api } = setup();
      expect(() => api.listPage({ page: -1 })).toThrow(RangeError);
      expect(api.log.at(-1)).toMatchObject({ route: 'page', status: 400 });
    });
  });

  describe('fetchImpl routes', () => {
    it('GET /since returns { data, has_more } honouring since, after_id and limit', async () => {
      const { api, fetch, clock } = setup();
      api.add(order('a'));
      api.add(order('b'));
      api.add(order('c'));
      await clock.advance(1_000);
      api.add(order('d'));
      const t0 = new Date(START).toISOString();
      const res = await fetch(
        `https://fake.api/since?since=${encodeURIComponent(t0)}&after_id=a&limit=2`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      const body = (await res.json()) as { data: Order[]; has_more: boolean };
      expect(body.data.map((o) => o.id)).toEqual(['b', 'c']);
      expect(body.has_more).toBe(true);
      expect(api.log.at(-1)).toMatchObject({
        route: 'since',
        status: 200,
        params: { since: t0, after_id: 'a', limit: '2' },
      });
    });

    it('GET /page returns { data, has_more, pages }', async () => {
      const { fetch } = setup({ items: fakeItems(5) });
      const res = await fetch('https://fake.api/page?page=2&limit=2');
      expect(await res.json()).toEqual({
        data: fakeItems(5).slice(2, 4),
        has_more: true,
        pages: 3,
      });
      const defaulted = await fetch('https://fake.api/page');
      expect(await defaulted.json()).toMatchObject({ has_more: false, pages: 1 });
    });

    it('GET /token returns { data, next } and can be walked', async () => {
      const { fetch } = setup({ items: fakeItems(5) });
      const seen: string[] = [];
      let next: string | null = null;
      do {
        const url = new URL('https://fake.api/token');
        url.searchParams.set('limit', '2');
        if (next) url.searchParams.set('token', next);
        const body = (await (await fetch(url)).json()) as { data: Order[]; next: string | null };
        seen.push(...body.data.map((o) => o.id));
        next = body.next;
      } while (next);
      expect(seen).toEqual(fakeItems(5).map((o) => o.id));
    });

    it('GET /all returns { data }', async () => {
      const { fetch } = setup({ items: fakeItems(2) });
      expect(await (await fetch('https://fake.api/all')).json()).toEqual({ data: fakeItems(2) });
    });

    it('GET /items/:id returns the item or a 404 problem', async () => {
      const { fetch } = setup({ items: fakeItems(2) });
      const ok = await fetch('https://fake.api/items/item-002');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual(fakeItems(2)[1]);
      const missing = await fetch('https://fake.api/items/nope');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-type')).toBe('application/problem+json');
      expect(await missing.json()).toMatchObject({ title: 'Not Found', status: 404 });
    });

    it('unknown paths and foreign origins are 404, non-GET is 405', async () => {
      const { fetch } = setup();
      expect((await fetch('https://fake.api/nope')).status).toBe(404);
      expect((await fetch('https://fake.api/items/')).status).toBe(404);
      expect((await fetch('https://other.example/all')).status).toBe(404);
      const post = await fetch('https://fake.api/all', { method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET');
    });

    it('invalid query parameters are 400 problems', async () => {
      const { fetch } = setup();
      const res = await fetch('https://fake.api/page?limit=abc');
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(await res.json()).toMatchObject({ title: 'Bad Request', status: 400 });
      const since = await fetch('https://fake.api/since?since=garbage');
      expect(since.status).toBe(400);
    });

    it('accepts URL and Request inputs and init overrides', async () => {
      const { fetch } = setup({ items: fakeItems(1) });
      expect((await fetch(new URL('https://fake.api/all'))).status).toBe(200);
      const req = new Request('https://fake.api/all', { method: 'POST' });
      expect((await fetch(req)).status).toBe(405);
      expect((await fetch(req, { method: 'GET' })).status).toBe(200);
    });

    it('respects a baseUrl with a path prefix', async () => {
      const { api, fetch } = setup({ baseUrl: 'https://api.example.com/v2/', items: fakeItems(1) });
      expect(api.baseUrl).toBe('https://api.example.com/v2');
      expect((await fetch('https://api.example.com/v2/all')).status).toBe(200);
      expect((await fetch('https://api.example.com/all')).status).toBe(404);
    });

    it('counts calls and records log entries with the clock time', async () => {
      const { api, fetch, clock } = setup();
      await clock.advance(1_234);
      await fetch('https://fake.api/all');
      await fetch('https://fake.api/nope');
      expect(api.calls).toBe(2);
      expect(api.log).toEqual([
        { at: START + 1_234, route: 'all', params: {}, status: 200 },
        { at: START + 1_234, route: '/nope', params: {}, status: 404 },
      ]);
      const ref = api.log;
      api.resetStats();
      expect(api.calls).toBe(0);
      expect(ref).toHaveLength(0);
    });
  });

  describe('ETag / 304', () => {
    it('emits a weak ETag and answers 304 to a matching If-None-Match', async () => {
      const { api, fetch } = setup({ items: fakeItems(2) });
      const first = await fetch('https://fake.api/all');
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);

      const second = await fetch('https://fake.api/all', {
        headers: { 'If-None-Match': etag as string },
      });
      expect(second.status).toBe(304);
      expect(second.headers.get('etag')).toBe(etag);
      expect(second.headers.get('content-type')).toBeNull();
      expect(await second.text()).toBe('');
      expect(api.log.at(-1)).toMatchObject({ route: 'all', status: 304 });
    });

    it('changes the ETag once the data changes', async () => {
      const { api, fetch } = setup({ items: fakeItems(2) });
      const etag = (await fetch('https://fake.api/all')).headers.get('etag') as string;
      api.update('item-001', { value: 100 });
      const res = await fetch('https://fake.api/all', { headers: { 'if-none-match': etag } });
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).not.toBe(etag);
    });

    it('supports lists, strong-form comparison and *', async () => {
      const { fetch } = setup({ items: fakeItems(1) });
      const etag = (await fetch('https://fake.api/all')).headers.get('etag') as string;
      const strong = etag.replace(/^W\//, '');
      expect(
        (await fetch('https://fake.api/all', { headers: { 'if-none-match': `"x", ${strong}` } }))
          .status,
      ).toBe(304);
      expect(
        (await fetch('https://fake.api/all', { headers: { 'if-none-match': '*' } })).status,
      ).toBe(304);
      expect(
        (await fetch('https://fake.api/all', { headers: { 'if-none-match': '"stale"' } })).status,
      ).toBe(200);
    });

    it('setEtags(false) disables ETags and ignores If-None-Match', async () => {
      const { api, fetch } = setup({ items: fakeItems(1) });
      const etag = (await fetch('https://fake.api/all')).headers.get('etag') as string;
      api.setEtags(false);
      const res = await fetch('https://fake.api/all', { headers: { 'if-none-match': etag } });
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBeNull();
    });

    it('does not attach ETags to error responses', async () => {
      const { fetch } = setup();
      expect((await fetch('https://fake.api/nope')).headers.get('etag')).toBeNull();
    });
  });

  describe('rate-limit headers', () => {
    it('ietf style emits RateLimit and RateLimit-Policy structured fields', async () => {
      const { api, fetch } = setup();
      api.setRateLimit({ limit: 100, remaining: 5, resetInMs: 30_000 });
      const res = await fetch('https://fake.api/all');
      expect(res.headers.get('ratelimit')).toBe('"default";r=5;t=30');
      expect(res.headers.get('ratelimit-policy')).toBe('"default";q=100;w=60');
      expect(res.headers.get('x-ratelimit-limit')).toBeNull();
      expect(res.headers.get('ratelimit-limit')).toBeNull();
    });

    it('ietf style honours windowMs and rounds seconds up', async () => {
      const { api, fetch } = setup();
      api.setRateLimit({ limit: 10, remaining: 0, resetInMs: 1_500, windowMs: 15_000 });
      const res = await fetch('https://fake.api/all');
      expect(res.headers.get('ratelimit')).toBe('"default";r=0;t=2');
      expect(res.headers.get('ratelimit-policy')).toBe('"default";q=10;w=15');
    });

    it('legacy style emits the RateLimit-Limit/Remaining/Reset triple in delta seconds', async () => {
      const { api, fetch } = setup();
      api.setRateLimit({ limit: 100, remaining: 5, resetInMs: 30_000, style: 'legacy' });
      const res = await fetch('https://fake.api/all');
      expect(res.headers.get('ratelimit-limit')).toBe('100');
      expect(res.headers.get('ratelimit-remaining')).toBe('5');
      expect(res.headers.get('ratelimit-reset')).toBe('30');
      expect(res.headers.get('ratelimit')).toBeNull();
    });

    it('vendor style emits X-RateLimit-* with an epoch-seconds reset', async () => {
      const { api, fetch, clock } = setup();
      await clock.advance(500);
      api.setRateLimit({ limit: 60, remaining: 59, resetInMs: 30_000, style: 'vendor' });
      const res = await fetch('https://fake.api/all');
      expect(res.headers.get('x-ratelimit-limit')).toBe('60');
      expect(res.headers.get('x-ratelimit-remaining')).toBe('59');
      expect(res.headers.get('x-ratelimit-reset')).toBe(
        String(Math.ceil((START + 500 + 30_000) / 1000)),
      );
    });

    it('headers also ride on fault responses and 304s, and null removes them', async () => {
      const { api, fetch } = setup({ items: fakeItems(1) });
      api.setRateLimit({ limit: 100, remaining: 0, resetInMs: 10_000 });
      api.failNext({ kind: 'http', status: 429 });
      const fault = await fetch('https://fake.api/all');
      expect(fault.status).toBe(429);
      expect(fault.headers.get('ratelimit')).toBe('"default";r=0;t=10');

      const ok = await fetch('https://fake.api/all');
      const notModified = await fetch('https://fake.api/all', {
        headers: { 'if-none-match': ok.headers.get('etag') as string },
      });
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get('ratelimit')).toBe('"default";r=0;t=10');

      api.setRateLimit(null);
      expect((await fetch('https://fake.api/all')).headers.get('ratelimit')).toBeNull();
    });
  });

  describe('faults via fetchImpl', () => {
    it('http fault: status, Retry-After in seconds, problem+json body', async () => {
      const { api, fetch } = setup();
      api.failNext({ kind: 'http', status: 429, retryAfterMs: 4_200 });
      const res = await fetch('https://fake.api/all');
      expect(res.status).toBe(429);
      expect(res.ok).toBe(false);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(await res.json()).toEqual({ title: 'Fault', status: 429 });
      expect(api.log.at(-1)).toMatchObject({ status: 429 });
    });

    it('http fault without retryAfterMs omits Retry-After; custom bodies are passed through', async () => {
      const { api, fetch } = setup();
      api.failNext({ kind: 'http', status: 503, body: { title: 'Down', detail: 'maintenance' } });
      const res = await fetch('https://fake.api/all');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBeNull();
      expect(await res.json()).toEqual({ title: 'Down', detail: 'maintenance' });
    });

    it('network fault rejects with a TypeError like fetch', async () => {
      const { api, fetch } = setup();
      api.failNext({ kind: 'network' });
      await expect(fetch('https://fake.api/all')).rejects.toThrow(TypeError);
      api.failNext({ kind: 'network', message: 'ECONNREFUSED' });
      await expect(fetch('https://fake.api/all')).rejects.toThrow('ECONNREFUSED');
      expect(api.log.map((e) => e.status)).toEqual([0, 0]);
    });

    it('timeout fault stays pending until the signal aborts, then rejects with its reason', async () => {
      const { api, fetch, clock } = setup();
      api.failNext({ kind: 'timeout' });
      const ac = new AbortController();
      const { state, promise } = track(fetch('https://fake.api/all', { signal: ac.signal }));
      await clock.flush();
      await clock.advance(60_000);
      expect(state.status).toBe('pending');
      const reason = new Error('deadline');
      ac.abort(reason);
      await expect(promise).rejects.toBe(reason);
      expect(api.log.at(-1)).toMatchObject({ status: 0 });
    });

    it('timeout fault with the default abort reason rejects with an AbortError', async () => {
      const { api, fetch } = setup();
      api.failNext({ kind: 'timeout' });
      const ac = new AbortController();
      const p = fetch('https://fake.api/all', { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('timeout fault without a signal never settles', async () => {
      const { api, fetch, clock } = setup();
      api.failNext({ kind: 'timeout' });
      const { state } = track(fetch('https://fake.api/all'));
      await clock.advance(3_600_000);
      expect(state.status).toBe('pending');
    });

    it('malformed fault returns 200 with a non-JSON body', async () => {
      const { api, fetch } = setup();
      api.failNext({ kind: 'malformed' });
      const res = await fetch('https://fake.api/all');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.clone().text()).toBe('not json');
      await expect(res.json()).rejects.toThrow(SyntaxError);
    });

    it('an already-aborted signal rejects immediately without touching the API', async () => {
      const { api, fetch } = setup();
      const ac = new AbortController();
      ac.abort(new Error('pre-aborted'));
      await expect(fetch('https://fake.api/all', { signal: ac.signal })).rejects.toThrow(
        'pre-aborted',
      );
      expect(api.calls).toBe(0);
    });
  });

  describe('latency', () => {
    it('resolves only after the virtual clock advances by the latency', async () => {
      const { api, fetch, clock } = setup({ items: fakeItems(1) });
      api.setLatency(250);
      const { state, promise } = track(fetch('https://fake.api/all'));
      await clock.flush();
      expect(state.status).toBe('pending');
      expect(clock.pendingTimers()).toBe(1);
      await clock.advance(249);
      expect(state.status).toBe('pending');
      await clock.advance(1);
      expect(state.status).toBe('resolved');
      expect((await promise).status).toBe(200);
      expect(api.log[0]?.at).toBe(START + 250);
    });

    it('does not use real time', async () => {
      const { api, fetch, clock } = setup();
      api.setLatency(10_000_000);
      const { state } = track(fetch('https://fake.api/all'));
      await new Promise((r) => setTimeout(r, 10));
      expect(state.status).toBe('pending');
      await clock.advance(10_000_000);
      expect(state.status).toBe('resolved');
    });

    it('aborting during the wait rejects and clears the timer', async () => {
      const { api, fetch, clock } = setup();
      api.setLatency(1_000);
      const ac = new AbortController();
      const p = fetch('https://fake.api/all', { signal: ac.signal });
      await clock.advance(100);
      ac.abort(new Error('gave up'));
      await expect(p).rejects.toThrow('gave up');
      expect(clock.pendingTimers()).toBe(0);
      expect(api.calls).toBe(0);
    });

    it('faults are applied after the latency elapses', async () => {
      const { api, fetch, clock } = setup();
      api.setLatency(100);
      api.failNext({ kind: 'network' });
      const { state, promise } = track(fetch('https://fake.api/all'));
      await clock.flush();
      expect(state.status).toBe('pending');
      await clock.advance(100);
      await expect(promise).rejects.toThrow(TypeError);
    });

    it('setLatency validates its argument', () => {
      const { api } = setup();
      expect(() => api.setLatency(-1)).toThrow(RangeError);
      expect(() => api.setLatency(Number.NaN)).toThrow(RangeError);
    });
  });

  describe('constructor validation', () => {
    it('rejects an invalid pageSize', () => {
      expect(() => setup({ pageSize: 0 })).toThrow(RangeError);
      expect(() => setup({ pageSize: 2.5 })).toThrow(RangeError);
    });
  });
});

describe('fakeItems', () => {
  it('generates deterministic, zero-padded, time-ordered items', () => {
    const items = fakeItems(3);
    expect(items).toEqual([
      { id: 'item-001', name: 'Item 1', value: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'item-002', name: 'Item 2', value: 2, updatedAt: '2026-01-01T00:00:01.000Z' },
      { id: 'item-003', name: 'Item 3', value: 3, updatedAt: '2026-01-01T00:00:02.000Z' },
    ]);
  });

  it('widens the id padding for large counts so identity order equals numeric order', () => {
    const items = fakeItems(1_000);
    expect(items[0]?.id).toBe('item-0001');
    expect(items.at(-1)?.id).toBe('item-1000');
    const ids = items.map((o) => o.id);
    expect(ids.slice().sort()).toEqual(ids);
  });

  it('applies factory overrides and extra fields', () => {
    const items = fakeItems(2, (i) => ({ tenant: i % 2 ? 'odd' : 'even', value: i * 10 }));
    expect(items[0]).toMatchObject({ id: 'item-001', tenant: 'even', value: 0 });
    expect(items[1]).toMatchObject({ id: 'item-002', tenant: 'odd', value: 10 });
    expect(items[1]?.tenant).toBe('odd');
  });

  it('returns [] for 0 and rejects invalid counts', () => {
    expect(fakeItems(0)).toEqual([]);
    expect(() => fakeItems(-1)).toThrow(RangeError);
    expect(() => fakeItems(1.5)).toThrow(RangeError);
  });

  it('plugs straight into FakeApi', () => {
    const clock = new VirtualClock();
    const api = new FakeApi({ clock, identity: (o) => o.id, items: fakeItems(4) });
    expect(api.size).toBe(4);
  });
});
