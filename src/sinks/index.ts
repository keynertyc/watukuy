/**
 * `watukuy/sinks` — re-emit events as Standard Webhooks or onto BullMQ, SQS and Kafka through
 * user-provided clients (see docs/recipes.md). Zero runtime dependencies.
 * @packageDocumentation
 */

export {
  type BullMQJobOptionsLike,
  type BullMQQueueLike,
  type BullMQSinkOptions,
  bullmqSink,
  type KafkaMessageLike,
  type KafkaProducerLike,
  type KafkaSinkOptions,
  kafkaSink,
  type SqsClientLike,
  type SqsMessageAttributeValue,
  type SqsSendMessageInput,
  type SqsSinkOptions,
  sqsSink,
} from './queues.ts';
export {
  CLOUDEVENTS_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  type SerializedEvent,
  type SinkFormat,
  serializeEvent,
  toSinkPayload,
} from './serialize.ts';
export {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  DEFAULT_WEBHOOK_TOLERANCE_SEC,
  decodeWebhookSecret,
  MAX_WEBHOOK_ERROR_BODY_CHARS,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_SECRET_PREFIX,
  WebhookDeliveryError,
  type WebhookSinkOptions,
  webhookSink,
} from './webhook.ts';
