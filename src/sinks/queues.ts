import { toCloudEvent } from '../core/cloudevents.ts';
import type { EventHandler, WatukuyEvent } from '../core/event.ts';
import {
  CLOUDEVENTS_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  type SinkFormat,
  serializeEvent,
  toSinkPayload,
} from './serialize.ts';

// ---------------------------------------------------------------------------------------------
// BullMQ
// ---------------------------------------------------------------------------------------------

/**
 * The subset of BullMQ `JobsOptions` the sink relies on. Any extra BullMQ option passes through
 * from {@link BullMQSinkOptions.jobOptions}.
 *
 * @example
 * const opts: BullMQJobOptionsLike = { jobId: event.id };
 */
export interface BullMQJobOptionsLike {
  jobId?: string | undefined;
}

/**
 * Structural view of a BullMQ `Queue`: only `add` is used, so no BullMQ types are imported and any
 * compatible object (or a fake in tests) works.
 *
 * @example
 * const queue: BullMQQueueLike = new Queue('orders', { connection });
 */
export interface BullMQQueueLike {
  add(name: string, data: unknown, opts?: BullMQJobOptionsLike): Promise<unknown>;
}

/**
 * Options for {@link bullmqSink}.
 *
 * @example
 * const options: BullMQSinkOptions<Order> = {
 *   jobName: (e) => `order-${e.type}`,
 *   jobOptions: { attempts: 5, removeOnComplete: true },
 * };
 */
export interface BullMQSinkOptions<Item> {
  /** Job name. @default `${event.poller}.${event.type}` */
  jobName?: string | ((event: WatukuyEvent<Item>) => string) | undefined;
  /** Extra BullMQ job options. `jobId` is always overwritten with `event.id`. */
  jobOptions?: Record<string, unknown> | undefined;
  /** Job data format. @default 'cloudevents' */
  format?: SinkFormat | undefined;
}

/**
 * Enqueue each event as a BullMQ job. `jobId = event.id`, so BullMQ deduplicates redeliveries and
 * the at-least-once dispatcher becomes effectively-once at the queue. The job name defaults to
 * `${poller}.${type}` (e.g. `orders.updated`), matching the CloudEvents `type`.
 *
 * @example
 * import { Queue } from 'bullmq';
 * engine.on('orders', bullmqSink(new Queue('orders'), { format: 'raw' }));
 */
export function bullmqSink<Item>(
  queue: BullMQQueueLike,
  options: BullMQSinkOptions<Item> = {},
): EventHandler<Item> {
  const format = options.format ?? 'cloudevents';
  const { jobName } = options;
  return async (event, ctx) => {
    const name =
      typeof jobName === 'function' ? jobName(event) : (jobName ?? defaultJobName(event));
    await queue.add(name, toSinkPayload(event, format), { ...options.jobOptions, jobId: event.id });
    ctx.ack();
  };
}

function defaultJobName<Item>(event: WatukuyEvent<Item>): string {
  return `${event.poller}.${event.type}`;
}

// ---------------------------------------------------------------------------------------------
// SQS
// ---------------------------------------------------------------------------------------------

/**
 * Structural view of an AWS SDK v3 `SQSClient`: only `send` is used.
 *
 * @example
 * const client: SqsClientLike = new SQSClient({ region: 'us-east-1' });
 */
export interface SqsClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * A string SQS message attribute, the only kind the sink emits.
 *
 * @example
 * const attr: SqsMessageAttributeValue = { DataType: 'String', StringValue: 'orders' };
 */
export interface SqsMessageAttributeValue {
  DataType: 'String';
  StringValue: string;
}

/**
 * The `SendMessage` input built by {@link sqsSink}. Structurally compatible with the SDK's
 * `SendMessageCommandInput`, so `new SendMessageCommand(input)` type-checks without any import
 * on our side.
 *
 * @example
 * const createCommand = (input: SqsSendMessageInput) => new SendMessageCommand(input);
 */
export interface SqsSendMessageInput {
  QueueUrl: string;
  MessageBody: string;
  MessageAttributes: Record<string, SqsMessageAttributeValue>;
  /** Present for FIFO queues only. Always `event.id`. */
  MessageDeduplicationId?: string;
  /** Present for FIFO queues only. */
  MessageGroupId?: string;
}

/**
 * Options for {@link sqsSink}.
 *
 * @example
 * const options: SqsSinkOptions<Order> = {
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/orders.fifo',
 *   createCommand: (input) => new SendMessageCommand(input),
 *   messageGroupId: (e) => e.data?.customerId ?? e.subject,
 * };
 */
export interface SqsSinkOptions<Item> {
  queueUrl: string;
  /** Wraps the input in the SDK command; we cannot import `@aws-sdk/client-sqs` ourselves. */
  createCommand: (input: SqsSendMessageInput) => unknown;
  /** `false` omits `MessageDeduplicationId` / `MessageGroupId` for standard queues. @default true */
  fifo?: boolean | undefined;
  /** Body format. @default 'cloudevents' */
  format?: SinkFormat | undefined;
  /**
   * FIFO `MessageGroupId`. Pass the same function you gave `delivery.orderingKey` to keep the
   * queue's ordering aligned with the dispatcher's. @default event.subject
   */
  messageGroupId?: string | ((event: WatukuyEvent<Item>) => string) | undefined;
}

/**
 * Send each event to an SQS queue. For FIFO queues (default) `MessageDeduplicationId = event.id`
 * and `MessageGroupId` is the ordering key (defaults to `event.subject`), so redeliveries within
 * SQS's 5-minute dedup window collapse and per-item order is preserved. `MessageAttributes`
 * carries `poller`, `type` and `contentType` for filtering without parsing the body.
 *
 * @example
 * import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
 * engine.on('orders', sqsSink(new SQSClient({}), {
 *   queueUrl: process.env.QUEUE_URL!,
 *   createCommand: (input) => new SendMessageCommand(input),
 * }));
 */
export function sqsSink<Item>(
  client: SqsClientLike,
  options: SqsSinkOptions<Item>,
): EventHandler<Item> {
  const format = options.format ?? 'cloudevents';
  const fifo = options.fifo ?? true;
  const { messageGroupId } = options;
  return async (event, ctx) => {
    const { body, contentType } = serializeEvent(event, format);
    const input: SqsSendMessageInput = {
      QueueUrl: options.queueUrl,
      MessageBody: body,
      MessageAttributes: {
        poller: stringAttribute(event.poller),
        type: stringAttribute(event.type),
        contentType: stringAttribute(contentType),
      },
    };
    if (fifo) {
      input.MessageDeduplicationId = event.id;
      input.MessageGroupId =
        typeof messageGroupId === 'function'
          ? messageGroupId(event)
          : (messageGroupId ?? event.subject);
    }
    await client.send(options.createCommand(input));
    ctx.ack();
  };
}

function stringAttribute(value: string): SqsMessageAttributeValue {
  return { DataType: 'String', StringValue: value };
}

// ---------------------------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------------------------

/**
 * One Kafka message as produced by {@link kafkaSink}. Compatible with kafkajs's `Message`.
 *
 * @example
 * const message: KafkaMessageLike = { key: 'ord_1', value: '{"id":"ord_1"}' };
 */
export interface KafkaMessageLike {
  key?: string;
  value: string;
  headers?: Record<string, string>;
}

/**
 * Structural view of a kafkajs `Producer`: only `send` is used.
 *
 * @example
 * const producer: KafkaProducerLike = kafka.producer();
 */
export interface KafkaProducerLike {
  send(record: { topic: string; messages: KafkaMessageLike[] }): Promise<unknown>;
}

/**
 * Options for {@link kafkaSink}.
 *
 * @example
 * const options: KafkaSinkOptions = { topic: 'orders', format: 'structured' };
 */
export interface KafkaSinkOptions {
  topic: string;
  /**
   * CloudEvents Kafka binding mode. `'binary'` (default): value is the JSON item, attributes
   * travel as `ce_*` headers with `content-type: application/json`. `'structured'`: value is the
   * full CloudEvent JSON with `content-type: application/cloudevents+json`.
   * @default 'binary'
   */
  format?: 'binary' | 'structured' | undefined;
}

/**
 * Produce each event to a Kafka topic per the CloudEvents Kafka protocol binding. The message key
 * is `event.subject`, so all changes of one item land on the same partition in order. In binary
 * mode the value is `JSON.stringify(event.data)` (`null` for deletes without a payload) and the
 * envelope travels as `ce_id`, `ce_type`, `ce_source`, `ce_specversion`, `ce_subject`, `ce_time`
 * and `ce_watukuy*` headers.
 *
 * @example
 * import { Kafka } from 'kafkajs';
 * const producer = new Kafka({ brokers }).producer();
 * await producer.connect();
 * engine.on('orders', kafkaSink(producer, { topic: 'orders' }));
 */
export function kafkaSink<Item>(
  producer: KafkaProducerLike,
  options: KafkaSinkOptions,
): EventHandler<Item> {
  const format = options.format ?? 'binary';
  return async (event, ctx) => {
    const message: KafkaMessageLike =
      format === 'structured'
        ? {
            key: event.subject,
            value: JSON.stringify(toCloudEvent(event)),
            headers: { 'content-type': CLOUDEVENTS_CONTENT_TYPE },
          }
        : {
            key: event.subject,
            value: JSON.stringify(event.data ?? null),
            headers: kafkaBinaryHeaders(event),
          };
    await producer.send({ topic: options.topic, messages: [message] });
    ctx.ack();
  };
}

/** Binary-mode headers: every CloudEvent attribute except `data` becomes `ce_<name>`. */
function kafkaBinaryHeaders<Item>(event: WatukuyEvent<Item>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE };
  for (const [name, value] of Object.entries(toCloudEvent(event))) {
    if (name === 'data' || name === 'datacontenttype' || name === 'watukuyprevious') continue;
    if (value === undefined || value === '') continue;
    headers[`ce_${name}`] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return headers;
}
