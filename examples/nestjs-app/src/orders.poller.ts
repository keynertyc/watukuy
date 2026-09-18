import { definePoller } from 'watukuy';
import { z } from 'zod';

export const Order = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.enum(['open', 'paid', 'shipped', 'cancelled']),
  total: z.number(),
  updatedAt: z.iso.datetime(),
});
export type Order = z.infer<typeof Order>;

/**
 * Same poller as `examples/legacy-orders`, parameterized by the ERP base URL so the module can
 * build it from an injected dependency (`WatukuyModule.forRootAsync`).
 */
export function ordersPoller(baseUrl: string) {
  return definePoller({
    name: 'orders',
    schema: Order,
    identity: (o) => o.id,
    version: (o) => o.updatedAt,
    cursor: {
      strategy: 'timestamp',
      field: 'updatedAt',
      tieBreak: 'id',
      initial: null,
      overlap: '5s',
    },
    fetch: async ({ cursor, http, signal }) => {
      const res = await http.get(`${baseUrl}/orders`, {
        query: { updated_since: cursor.value, after_id: cursor.tieBreak, limit: 50 },
        signal,
      });
      if (res.notModified) return { items: [] };
      const body = await res.json<{ data: unknown[]; has_more: boolean }>();
      return { items: body.data, hasMore: body.has_more };
    },
    schedule: { min: '1s', max: '10s' },
    retain: 'payload',
  });
}
