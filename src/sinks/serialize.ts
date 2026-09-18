import { toCloudEvent } from '../core/cloudevents.ts';
import type { CloudEvent, WatukuyEvent } from '../core/event.ts';

/**
 * Wire format shared by every sink. `'cloudevents'` transports `toCloudEvent(event)` (CloudEvents
 * 1.0 structured mode, see docs/api.md); `'raw'` transports the {@link WatukuyEvent} envelope as-is,
 * which keeps `cursor` and `attempt` but is watukuy-specific.
 *
 * @example
 * const format: SinkFormat = process.env.INTEROP ? 'cloudevents' : 'raw';
 */
export type SinkFormat = 'cloudevents' | 'raw';

/**
 * Media type of a CloudEvents 1.0 structured-mode JSON body.
 *
 * @example
 * headers.set('content-type', CLOUDEVENTS_CONTENT_TYPE);
 */
export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json';

/**
 * Media type of a raw {@link WatukuyEvent} JSON body (and of CloudEvents `data`).
 *
 * @example
 * headers.set('content-type', JSON_CONTENT_TYPE);
 */
export const JSON_CONTENT_TYPE = 'application/json';

/**
 * A JSON-encoded event plus the media type that describes it.
 *
 * @example
 * const { body, contentType }: SerializedEvent = serializeEvent(event, 'cloudevents');
 */
export interface SerializedEvent {
  body: string;
  contentType: string;
}

/**
 * The object a sink transports for `event` in `format`, before JSON encoding. Sinks whose client
 * takes an object rather than a string (BullMQ job data) use this directly.
 *
 * @example
 * await queue.add('orders.updated', toSinkPayload(event, 'cloudevents'), { jobId: event.id });
 */
export function toSinkPayload<Item>(
  event: WatukuyEvent<Item>,
  format: SinkFormat,
): CloudEvent<Item> | WatukuyEvent<Item> {
  return format === 'cloudevents' ? toCloudEvent(event) : event;
}

/**
 * Serialize an event to a JSON string and the matching `content-type` (see docs/api.md). Use it when
 * building a custom sink so the body and media type stay consistent with the built-in ones.
 *
 * @example
 * const { body, contentType } = serializeEvent(event, 'cloudevents');
 * await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
 */
export function serializeEvent<Item>(
  event: WatukuyEvent<Item>,
  format: SinkFormat,
): SerializedEvent {
  return {
    body: JSON.stringify(toSinkPayload(event, format)),
    contentType: format === 'cloudevents' ? CLOUDEVENTS_CONTENT_TYPE : JSON_CONTENT_TYPE,
  };
}
