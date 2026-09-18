import type { EventHandler, HandlerContext, WatukuyEvent } from './event.ts';

/** Where delivered events go: a registered handler or a `subscribe()` iterator. */
export interface Consumer<Item = unknown> {
  deliver(event: WatukuyEvent<Item>, ctx: HandlerContext): Promise<void>;
  /** Release waiting iterators / reject undelivered events. */
  close(reason?: unknown): void;
  readonly kind: 'handler' | 'iterator';
}

/** Wrap an `engine.on()` handler. In `manual` ack mode the handler must call `ctx.ack()`. */
export function handlerConsumer<Item>(
  handler: EventHandler<Item>,
  ackMode: 'auto' | 'manual',
): Consumer<Item> {
  return {
    kind: 'handler',
    async deliver(event, ctx) {
      let acked = false;
      const wrapped: HandlerContext = {
        ...ctx,
        ack: () => {
          acked = true;
          ctx.ack();
        },
      };
      await handler(event, wrapped);
      if (ackMode === 'manual' && !acked) {
        throw new Error(
          `handler returned without calling ctx.ack() for event ${event.id} (delivery.ackMode is 'manual')`,
        );
      }
    },
    close() {},
  };
}

interface Pending<Item> {
  event: WatukuyEvent<Item>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * Backpressured async iterator (see docs/delivery.md, G10). An event is acknowledged when the consumer asks
 * for the next one (or returns from the loop); if the consumer throws or the signal aborts while
 * an event is in flight, that event is not acknowledged and will be redelivered.
 */
export class SubscribeConsumer<Item> implements Consumer<Item>, AsyncIterable<WatukuyEvent<Item>> {
  readonly kind = 'iterator' as const;
  private puller: ((result: IteratorResult<WatukuyEvent<Item>>) => void) | null = null;
  private inflight: Pending<Item> | null = null;
  private readonly queue: Pending<Item>[] = [];
  private closed = false;
  private closeReason: unknown = undefined;
  private iterated = false;

  constructor(signal?: AbortSignal) {
    if (signal) {
      if (signal.aborted) this.close(signal.reason);
      else signal.addEventListener('abort', () => this.close(signal.reason), { once: true });
    }
  }

  deliver(event: WatukuyEvent<Item>): Promise<void> {
    if (this.closed) return Promise.reject(this.closeReason ?? new Error('subscriber closed'));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (!this.puller || this.inflight || this.queue.length === 0) return;
    const next = this.queue.shift() as Pending<Item>;
    const puller = this.puller;
    this.puller = null;
    this.inflight = next;
    puller({ value: next.event, done: false });
  }

  private settleInflight(ok: boolean, reason?: unknown): void {
    const f = this.inflight;
    if (!f) return;
    this.inflight = null;
    if (ok) f.resolve();
    else f.reject(reason ?? new Error('event not acknowledged'));
  }

  [Symbol.asyncIterator](): AsyncIterator<WatukuyEvent<Item>> {
    if (this.iterated) throw new Error('a watukuy subscription can only be iterated once');
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<WatukuyEvent<Item>>> => {
        this.settleInflight(true);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.puller = resolve;
          this.pump();
        });
      },
      return: (): Promise<IteratorResult<WatukuyEvent<Item>>> => {
        this.settleInflight(true);
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (err?: unknown): Promise<IteratorResult<WatukuyEvent<Item>>> => {
        this.settleInflight(false, err);
        this.close(err);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    // In-flight event: we cannot know whether processing finished; do not ack (at-least-once).
    this.settleInflight(false, reason ?? new Error('subscriber closed while event in flight'));
    for (const p of this.queue.splice(0)) p.reject(reason ?? new Error('subscriber closed'));
    const puller = this.puller;
    this.puller = null;
    puller?.({ value: undefined, done: true });
  }
}
