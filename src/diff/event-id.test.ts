import { describe, expect, it } from 'vitest';
import { type EventIdParts, eventId, eventIdMaterial } from './event-id.ts';

const parts: EventIdParts = {
  source: 'urn:watukuy:orders',
  partition: '',
  identity: 'o1',
  version: 'v1',
  schemaVersion: 1,
  type: 'created',
};

describe('eventIdMaterial', () => {
  it('lays out the parts with a versioned prefix', () => {
    expect(eventIdMaterial(parts)).toBe('watukuy|v1|urn:watukuy:orders||o1|v1|1|created');
  });

  it('escapes separators and backslashes inside parts', () => {
    expect(eventIdMaterial({ ...parts, identity: 'a|b', version: 'c\\d' })).toBe(
      'watukuy|v1|urn:watukuy:orders||a\\|b|c\\\\d|1|created',
    );
  });
});

describe('eventId', () => {
  it('is deterministic and hex encoded (known vector)', async () => {
    // printf '%s' 'watukuy|v1|urn:watukuy:orders||o1|v1|1|created' | shasum -a 256
    const id = await eventId(parts);
    expect(id).toBe('5dc9ec28d4ec668a7add37c6a32e916f839cd6d98ee013de30acd06b32599862');
    expect(await eventId({ ...parts })).toBe(id);
  });

  it('changes when any part changes', async () => {
    const base = await eventId(parts);
    const variants: EventIdParts[] = [
      { ...parts, source: 'urn:watukuy:invoices' },
      { ...parts, partition: 'acme' },
      { ...parts, identity: 'o2' },
      { ...parts, version: 'v2' },
      { ...parts, schemaVersion: 2 },
      { ...parts, type: 'updated' },
      { ...parts, type: 'deleted' },
    ];
    const ids = await Promise.all(variants.map((v) => eventId(v)));
    for (const id of ids) expect(id).not.toBe(base);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is safe against separator injection across part boundaries', async () => {
    const a = await eventId({ ...parts, identity: 'a|b', version: 'c' });
    const b = await eventId({ ...parts, identity: 'a', version: 'b|c' });
    expect(a).not.toBe(b);
    const c = await eventId({ ...parts, identity: 'a\\', version: '|c' });
    const d = await eventId({ ...parts, identity: 'a', version: '\\|c' });
    expect(c).not.toBe(d);
    const e = await eventId({ ...parts, partition: '', identity: '|o1' });
    const f = await eventId({ ...parts, partition: '|', identity: 'o1' });
    expect(e).not.toBe(f);
  });
});
