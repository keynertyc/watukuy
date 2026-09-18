import { describe, expect, it, type Mock, vi } from 'vitest';
import { toCloudEvent } from '../core/cloudevents.ts';
import type { HandlerContext, WatukuyEvent } from '../core/event.ts';
import type { Logger } from '../core/ports.ts';
import {
  type BullMQQueueLike,
  bullmqSink,
  type KafkaProducerLike,
  kafkaSink,
  type SqsClientLike,
  type SqsSendMessageInput,
  sqsSink,
} from './queues.ts';
import { CLOUDEVENTS_CONTENT_TYPE, JSON_CONTENT_TYPE, serializeEvent } from './serialize.ts';

interface Order {
  id: string;
  total: number;
}

function makeEvent(overrides: Partial<WatukuyEvent<Order>> = {}): WatukuyEvent<Order> {
  return {
    id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    type: 'updated',
    source: 'urn:watukuy:orders',
    subject: 'ord_1',
    time: '2025-09-18T11:59:59.000Z',
    poller: 'orders',
    partition: '',
    lane: 'live',
    sequence: 7,
    cursor: { value: '2025-09-18T11:59:00Z' },
    data: { id: 'ord_1', total: 42 },
    attempt: 1,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): HandlerContext & { ack: Mock<() => void> } {
  return {
    signal: new AbortController().signal,
    logger: makeLogger(),
    partition: { key: '', data: undefined },
    attempt: 1,
    ack: vi.fn(),
  };
}

describe('serializeEvent', () => {
  it('serializes CloudEvents structured mode', () => {
    const event = makeEvent();
    const out = serializeEvent(event, 'cloudevents');
    expect(out.contentType).toBe(CLOUDEVENTS_CONTENT_TYPE);
    expect(JSON.parse(out.body)).toEqual(toCloudEvent(event));
  });

  it('serializes the raw envelope', () => {
    const event = makeEvent();
    const out = serializeEvent(event, 'raw');
    expect(out.contentType).toBe(JSON_CONTENT_TYPE);
    expect(JSON.parse(out.body)).toEqual(event);
  });
});

describe('bullmqSink', () => {
  function makeQueue(): BullMQQueueLike & { add: Mock<BullMQQueueLike['add']> } {
    return { add: vi.fn<BullMQQueueLike['add']>(async () => ({ id: 'job' })) };
  }

  it('adds a job with jobId = event.id, default name and CloudEvents data', async () => {
    const queue = makeQueue();
    const event = makeEvent();
    const ctx = makeCtx();
    await bullmqSink<Order>(queue)(event, ctx);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0]!;
    expect(name).toBe('orders.updated');
    expect(data).toEqual(toCloudEvent(event));
    expect(opts).toEqual({ jobId: event.id });
    expect(ctx.ack).toHaveBeenCalledTimes(1);
  });

  it('supports a fixed or computed job name and raw format', async () => {
    const queue = makeQueue();
    const event = makeEvent({ type: 'deleted', data: undefined });
    await bullmqSink<Order>(queue, { jobName: 'fixed', format: 'raw' })(event, makeCtx());
    await bullmqSink<Order>(queue, { jobName: (e) => `${e.subject}:${e.type}` })(event, makeCtx());

    expect(queue.add.mock.calls[0]![0]).toBe('fixed');
    expect(queue.add.mock.calls[0]![1]).toEqual(event);
    expect(queue.add.mock.calls[1]![0]).toBe('ord_1:deleted');
  });

  it('merges jobOptions but keeps jobId pinned to event.id', async () => {
    const queue = makeQueue();
    const event = makeEvent();
    await bullmqSink<Order>(queue, {
      jobOptions: { attempts: 3, removeOnComplete: true, jobId: 'spoofed' },
    })(event, makeCtx());
    expect(queue.add.mock.calls[0]![2]).toEqual({
      attempts: 3,
      removeOnComplete: true,
      jobId: event.id,
    });
  });

  it('propagates queue failures so the dispatcher can retry', async () => {
    const failure = new Error('redis down');
    const queue: BullMQQueueLike = { add: vi.fn(async () => Promise.reject(failure)) };
    const ctx = makeCtx();
    await expect(bullmqSink<Order>(queue)(makeEvent(), ctx)).rejects.toBe(failure);
    expect(ctx.ack).not.toHaveBeenCalled();
  });
});

describe('sqsSink', () => {
  const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/orders.fifo';

  function makeClient(): SqsClientLike & { send: Mock<SqsClientLike['send']> } {
    return { send: vi.fn<SqsClientLike['send']>(async () => ({ MessageId: 'm1' })) };
  }

  it('builds a FIFO SendMessage input and sends the created command', async () => {
    const client = makeClient();
    const event = makeEvent();
    const ctx = makeCtx();
    const createCommand = vi.fn((input: SqsSendMessageInput) => ({
      kind: 'SendMessageCommand',
      input,
    }));

    await sqsSink<Order>(client, { queueUrl, createCommand })(event, ctx);

    expect(createCommand).toHaveBeenCalledTimes(1);
    const input = createCommand.mock.calls[0]![0];
    expect(input.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(input.MessageBody)).toEqual(toCloudEvent(event));
    expect(input.MessageDeduplicationId).toBe(event.id);
    expect(input.MessageGroupId).toBe('ord_1');
    expect(input.MessageAttributes).toEqual({
      poller: { DataType: 'String', StringValue: 'orders' },
      type: { DataType: 'String', StringValue: 'updated' },
      contentType: { DataType: 'String', StringValue: CLOUDEVENTS_CONTENT_TYPE },
    });
    expect(client.send).toHaveBeenCalledWith({ kind: 'SendMessageCommand', input });
    expect(ctx.ack).toHaveBeenCalledTimes(1);
  });

  it('omits dedup and group ids for standard queues', async () => {
    const client = makeClient();
    const createCommand = vi.fn((input: SqsSendMessageInput) => input);
    await sqsSink<Order>(client, { queueUrl, createCommand, fifo: false })(makeEvent(), makeCtx());
    const input = createCommand.mock.calls[0]![0];
    expect(input).not.toHaveProperty('MessageDeduplicationId');
    expect(input).not.toHaveProperty('MessageGroupId');
    expect(input.MessageBody).toBeTypeOf('string');
  });

  it('supports a custom message group id and raw format', async () => {
    const client = makeClient();
    const createCommand = vi.fn((input: SqsSendMessageInput) => input);
    const event = makeEvent();
    await sqsSink<Order>(client, {
      queueUrl,
      createCommand,
      format: 'raw',
      messageGroupId: (e) => `tenant:${e.poller}`,
    })(event, makeCtx());
    await sqsSink<Order>(client, { queueUrl, createCommand, messageGroupId: 'fixed' })(
      event,
      makeCtx(),
    );
    const first = createCommand.mock.calls[0]![0];
    expect(first.MessageGroupId).toBe('tenant:orders');
    expect(JSON.parse(first.MessageBody)).toEqual(event);
    expect(first.MessageAttributes.contentType?.StringValue).toBe(JSON_CONTENT_TYPE);
    expect(createCommand.mock.calls[1]![0].MessageGroupId).toBe('fixed');
  });

  it('propagates client failures', async () => {
    const failure = new Error('throttled');
    const client: SqsClientLike = { send: vi.fn(async () => Promise.reject(failure)) };
    await expect(
      sqsSink<Order>(client, { queueUrl, createCommand: (i) => i })(makeEvent(), makeCtx()),
    ).rejects.toBe(failure);
  });
});

describe('kafkaSink', () => {
  function makeProducer(): KafkaProducerLike & { send: Mock<KafkaProducerLike['send']> } {
    return { send: vi.fn<KafkaProducerLike['send']>(async () => []) };
  }

  it('produces binary-mode messages keyed by subject with ce_* headers', async () => {
    const producer = makeProducer();
    const event = makeEvent();
    const ctx = makeCtx();
    await kafkaSink<Order>(producer, { topic: 'orders' })(event, ctx);

    expect(producer.send).toHaveBeenCalledTimes(1);
    const record = producer.send.mock.calls[0]![0];
    expect(record.topic).toBe('orders');
    expect(record.messages).toHaveLength(1);
    const message = record.messages[0]!;
    expect(message.key).toBe('ord_1');
    expect(JSON.parse(message.value)).toEqual({ id: 'ord_1', total: 42 });
    expect(message.headers).toEqual({
      'content-type': JSON_CONTENT_TYPE,
      ce_specversion: '1.0',
      ce_id: event.id,
      ce_source: 'urn:watukuy:orders',
      ce_type: 'orders.updated',
      ce_subject: 'ord_1',
      ce_time: event.time,
      ce_watukuylane: 'live',
      ce_watukuysequence: '7',
      ce_watukuypoller: 'orders',
    });
    expect(ctx.ack).toHaveBeenCalledTimes(1);
  });

  it('includes the partition header when set and sends null for deletes without payload', async () => {
    const producer = makeProducer();
    const event = makeEvent({
      type: 'deleted',
      data: undefined,
      partition: 'acme',
      previous: { id: 'ord_1', total: 42 },
    });
    await kafkaSink<Order>(producer, { topic: 'orders' })(event, makeCtx());
    const message = producer.send.mock.calls[0]![0].messages[0]!;
    expect(message.value).toBe('null');
    expect(message.headers?.ce_watukuypartition).toBe('acme');
    expect(message.headers?.ce_type).toBe('orders.deleted');
    expect(message.headers).not.toHaveProperty('ce_watukuyprevious');
    expect(message.headers).not.toHaveProperty('ce_data');
  });

  it('produces structured-mode messages with the CloudEvents media type', async () => {
    const producer = makeProducer();
    const event = makeEvent();
    await kafkaSink<Order>(producer, { topic: 'orders', format: 'structured' })(event, makeCtx());
    const message = producer.send.mock.calls[0]![0].messages[0]!;
    expect(message.key).toBe('ord_1');
    expect(JSON.parse(message.value)).toEqual(toCloudEvent(event));
    expect(message.headers).toEqual({ 'content-type': CLOUDEVENTS_CONTENT_TYPE });
  });

  it('propagates producer failures', async () => {
    const failure = new Error('broker unavailable');
    const producer: KafkaProducerLike = { send: vi.fn(async () => Promise.reject(failure)) };
    const ctx = makeCtx();
    await expect(kafkaSink<Order>(producer, { topic: 'orders' })(makeEvent(), ctx)).rejects.toBe(
      failure,
    );
    expect(ctx.ack).not.toHaveBeenCalled();
  });
});
