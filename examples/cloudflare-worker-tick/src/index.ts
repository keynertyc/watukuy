/**
 * watukuy on a Cloudflare cron trigger.
 *
 * There is no long-running process here. Every cron invocation calls `engine.tick()`: one pass
 * over the pollers that are due, bounded by `maxDuration`, then return. Cursors, intervals and
 * the outbox live in the store, so a fleet of short-lived invocations behaves like one daemon.
 *
 *   pnpm start                                              # wrangler dev --test-scheduled
 *   curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"  # fire the cron by hand
 *   curl  http://localhost:8787/                             # engine.inspect() as JSON
 *
 * Backend: jsonplaceholder.typicode.com (public, no credentials), page-numbered with
 * `_page` / `_limit`. Its data never changes, so the first tick emits 100 `created` events and
 * later ticks emit nothing: the diff engine at work.
 */
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { createWatukuy, definePoller, MemoryStore } from 'watukuy';

interface Post {
  userId: number;
  id: number;
  title: string;
  body: string;
}

const PAGE_SIZE = 20;

const posts = definePoller({
  name: 'posts',
  identity: (p: Post) => String(p.id),
  // No `version`: the content hash of each item decides what changed.
  cursor: { strategy: 'page', initial: 1 },
  fetch: async ({ cursor, http, signal }) => {
    const res = await http.get('https://jsonplaceholder.typicode.com/posts', {
      query: { _page: cursor.page, _limit: PAGE_SIZE },
      signal,
    });
    const items = await res.json<Post[]>();
    return { items, hasMore: items.length === PAGE_SIZE };
  },
  schedule: { min: '1m', max: '30m' },
  maxPagesPerCycle: 10, // a tick that hits the limit resumes on the next invocation
});

// Module scope: warm isolates reuse the engine and its MemoryStore across invocations.
//
// MemoryStore is a demo choice. It forgets everything when the isolate is evicted, so each
// cold start re-emits the full list as `created`. For real deployments use `PostgresStore`
// over Hyperdrive or `RedisStore`; a Durable Object store is on the roadmap (ROADMAP.md).
const engine = createWatukuy({ store: new MemoryStore(), pollers: { posts } });

// Handlers must be registered before tick(); events without a consumer stay in the outbox.
engine.on('posts', (event) => {
  console.log(`[posts] ${event.type} #${event.subject} "${event.data?.title.slice(0, 40) ?? ''}"`);
});

async function runTick(cron: string): Promise<void> {
  // Workers cron handlers get generous wall-clock time but 30s of CPU: keep a margin.
  const result = await engine.tick({ maxDuration: '25s' });
  const events = result.polled.reduce((n, p) => n + p.events, 0);
  const errors = result.polled.filter((p) => p.error !== null).map((p) => p.error?.message);
  console.log(
    `[tick] cron="${cron}" polled=${result.polled.length} events=${events} ` +
      `skippedNotDue=${result.skippedNotDue} timedOut=${result.timedOut} ${result.durationMs}ms` +
      (errors.length ? ` errors=${JSON.stringify(errors)}` : ''),
  );
}

export default {
  // Cron trigger (see wrangler.jsonc). waitUntil keeps the isolate alive until the tick ends.
  scheduled(controller: ScheduledController, _env: unknown, ctx: ExecutionContext): void {
    ctx.waitUntil(runTick(controller.cron));
  },

  // Convenience: GET / returns engine.inspect() so you can watch the cursor and schedule.
  async fetch(): Promise<Response> {
    const report = await engine.inspect();
    return new Response(JSON.stringify(report, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
