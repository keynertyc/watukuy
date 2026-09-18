import type { CloudEvent, WatukuyEvent } from './event.ts';

/**
 * Convert a watukuy event into a CloudEvents 1.0 structured-mode object (see docs/api.md).
 * `type` becomes `<poller>.<created|updated|deleted>`; watukuy-specific fields travel as
 * extension attributes.
 *
 * @example
 * await fetch(url, {
 *   method: 'POST',
 *   headers: { 'content-type': 'application/cloudevents+json' },
 *   body: JSON.stringify(toCloudEvent(event)),
 * });
 */
export function toCloudEvent<Item>(event: WatukuyEvent<Item>): CloudEvent<Item> {
  const ce: CloudEvent<Item> = {
    specversion: '1.0',
    id: event.id,
    source: event.source,
    type: `${event.poller}.${event.type}`,
    subject: event.subject,
    time: event.time,
    datacontenttype: 'application/json',
    data: event.data,
    watukuypartition: event.partition,
    watukuylane: event.lane,
    watukuysequence: event.sequence,
    watukuypoller: event.poller,
  };
  if (event.previous !== undefined) ce.watukuyprevious = event.previous;
  return ce;
}
