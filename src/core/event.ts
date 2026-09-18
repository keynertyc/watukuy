import type { Lane, Partition } from './poller-types.ts';
import type { Logger } from './ports.ts';

export type EventType = 'created' | 'updated' | 'deleted';

/** The normalized change event (PLAN §4.6). Convert with `toCloudEvent()` for interop. */
export interface WatukuyEvent<Item = unknown> {
  /** Deterministic: `sha256(source|partition|identity|version|schemaVersion|type)` as hex. */
  id: string;
  type: EventType;
  /** `urn:watukuy:<poller>` unless overridden. */
  source: string;
  /** The item identity. */
  subject: string;
  /** ISO 8601 observation time. */
  time: string;
  poller: string;
  /** `''` for single-partition pollers. */
  partition: string;
  lane: Lane;
  /** Monotonic per `(poller, partition)`. */
  sequence: number;
  /** Serialized cursor after the poll that produced this event. */
  cursor: unknown;
  /** The item. `undefined` for `deleted` when `retain: 'hash'`. */
  data: Item | undefined;
  /** Previous payload, only with `retain: 'payload'`. */
  previous?: Item | undefined;
  /** Delivery attempt, 1-based. */
  attempt: number;
}

export interface HandlerContext {
  signal: AbortSignal;
  logger: Logger;
  partition: Partition<unknown>;
  attempt: number;
  /** Acknowledge in `ackMode: 'manual'`. No-op in auto mode. */
  ack(): void;
}

export type EventHandler<Item> = (
  event: WatukuyEvent<Item>,
  ctx: HandlerContext,
) => void | Promise<void>;

/** CloudEvents 1.0 structured-mode representation. */
export interface CloudEvent<Data = unknown> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: Data | undefined;
  watukuypartition: string;
  watukuylane: Lane;
  watukuysequence: number;
  watukuypoller: string;
  [extension: string]: unknown;
}
