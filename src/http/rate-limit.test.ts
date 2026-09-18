import { describe, expect, it } from 'vitest';
import { parseRateLimitHeaders, parseRetryAfter } from './rate-limit.ts';

const NOW = 1_700_000_000_000;

describe('parseRateLimitHeaders', () => {
  describe('IETF structured fields (draft-11)', () => {
    it('parses RateLimit + RateLimit-Policy with quoted policy names', () => {
      const headers = new Headers({
        RateLimit: '"default";r=50;t=30',
        'RateLimit-Policy': '"default";q=100;w=60',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'ietf',
        limit: 100,
        remaining: 50,
        resetAt: NOW + 30_000,
        policy: '"default";q=100;w=60',
      });
    });

    it('tolerates spaces and a missing quoted name', () => {
      const headers = new Headers({ RateLimit: 'r=5 ; t=2' });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'ietf',
        remaining: 5,
        resetAt: NOW + 2_000,
      });
    });

    it('ignores unknown keys and byte-sequence partition keys', () => {
      const headers = new Headers({
        RateLimit: '"burst"; r=7; t=12; pk=:cHsdsRa894==:; foo="bar;baz"',
        'RateLimit-Policy': '"burst";q=20;qu="requests";w=10;pk=:cHsdsRa894==:',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toMatchObject({
        source: 'ietf',
        limit: 20,
        remaining: 7,
        resetAt: NOW + 12_000,
      });
    });

    it('picks the policy named by RateLimit when several are advertised', () => {
      const headers = new Headers({
        RateLimit: '"daily";r=10;t=100',
        'RateLimit-Policy': '"burst";q=100;w=60, "daily";q=1000;w=86400',
      });
      const info = parseRateLimitHeaders(headers, NOW);
      expect(info?.limit).toBe(1000);
      expect(info?.policy).toBe('"burst";q=100;w=60, "daily";q=1000;w=86400');
    });

    it('falls back to the first policy when names do not match', () => {
      const headers = new Headers({
        RateLimit: '"other";r=1;t=1',
        'RateLimit-Policy': '"a";q=11;w=1, "b";q=22;w=2',
      });
      expect(parseRateLimitHeaders(headers, NOW)?.limit).toBe(11);
    });

    it('accepts the older dictionary form', () => {
      const headers = new Headers({ RateLimit: 'limit=100, remaining=50, reset=30' });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'ietf',
        limit: 100,
        remaining: 50,
        resetAt: NOW + 30_000,
      });
    });

    it('returns limit-only info from RateLimit-Policy alone', () => {
      const headers = new Headers({ 'RateLimit-Policy': '"p";q=42;w=60' });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'ietf',
        limit: 42,
        policy: '"p";q=42;w=60',
      });
    });

    it('accepts decimal reset seconds and rounds to milliseconds', () => {
      const headers = new Headers({ RateLimit: 'r=1;t=1.5' });
      expect(parseRateLimitHeaders(headers, NOW)?.resetAt).toBe(NOW + 1_500);
    });

    it('takes priority over legacy and vendor headers', () => {
      const headers = new Headers({
        RateLimit: 'r=1;t=1',
        'RateLimit-Remaining': '99',
        'X-RateLimit-Remaining': '77',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toMatchObject({ source: 'ietf', remaining: 1 });
    });

    it('falls through to legacy when RateLimit carries nothing usable', () => {
      const headers = new Headers({ RateLimit: '"name";foo=bar', 'RateLimit-Remaining': '3' });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({ source: 'legacy', remaining: 3 });
    });
  });

  describe('legacy draft-07 triple', () => {
    it('parses limit, remaining and delta reset', () => {
      const headers = new Headers({
        'RateLimit-Limit': '100',
        'RateLimit-Remaining': '20',
        'RateLimit-Reset': '45',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'legacy',
        limit: 100,
        remaining: 20,
        resetAt: NOW + 45_000,
      });
    });

    it('takes the leading integer of a quota-policy style limit', () => {
      const headers = new Headers({ 'RateLimit-Limit': '100, 100;w=60' });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({ source: 'legacy', limit: 100 });
    });

    it('accepts a partial triple', () => {
      const headers = new Headers({ 'RateLimit-Reset': '10' });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'legacy',
        resetAt: NOW + 10_000,
      });
    });
  });

  describe('vendor X-RateLimit-* variants', () => {
    it('parses a delta reset', () => {
      const headers = new Headers({
        'X-RateLimit-Limit': '5000',
        'X-RateLimit-Remaining': '4999',
        'X-RateLimit-Reset': '60',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'vendor',
        limit: 5000,
        remaining: 4999,
        resetAt: NOW + 60_000,
      });
    });

    it('detects an epoch-seconds reset (10 digits, recent)', () => {
      const resetEpoch = Math.floor(NOW / 1000) + 3600;
      const headers = new Headers({
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetEpoch),
      });
      expect(parseRateLimitHeaders(headers, NOW)?.resetAt).toBe(resetEpoch * 1000);
    });

    it('detects an epoch-milliseconds reset (13 digits)', () => {
      const headers = new Headers({ 'X-RateLimit-Reset': String(NOW + 5_000) });
      expect(parseRateLimitHeaders(headers, NOW)?.resetAt).toBe(NOW + 5_000);
    });

    it('drops a 10-digit reset that is older than a day (neither delta nor timestamp)', () => {
      const stale = Math.floor(NOW / 1000) - 2 * 86_400;
      const headers = new Headers({
        'X-RateLimit-Remaining': '1',
        'X-RateLimit-Reset': String(stale),
      });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({ source: 'vendor', remaining: 1 });
    });

    it('accepts X-Rate-Limit-* spelling', () => {
      const headers = new Headers({
        'X-Rate-Limit-Limit': '10',
        'X-Rate-Limit-Remaining': '9',
        'X-Rate-Limit-Reset': '30',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toEqual({
        source: 'vendor',
        limit: 10,
        remaining: 9,
        resetAt: NOW + 30_000,
      });
    });

    it('prefers X-RateLimit-Reset-After (delta) over X-RateLimit-Reset', () => {
      const headers = new Headers({
        'X-RateLimit-Reset': String(Math.floor(NOW / 1000) + 9999),
        'X-RateLimit-Reset-After': '2.5',
      });
      expect(parseRateLimitHeaders(headers, NOW)?.resetAt).toBe(NOW + 2_500);
    });
  });

  describe('robustness', () => {
    it('returns null when no rate-limit headers are present', () => {
      expect(parseRateLimitHeaders(new Headers({ 'content-type': 'text/plain' }), NOW)).toBeNull();
    });

    it('returns null for unparseable values', () => {
      const headers = new Headers({
        'X-RateLimit-Limit': 'unlimited',
        'X-RateLimit-Remaining': 'n/a',
        'X-RateLimit-Reset': 'soon',
      });
      expect(parseRateLimitHeaders(headers, NOW)).toBeNull();
    });

    it('never throws on malformed structured fields', () => {
      const weird = ['", ;;;=;"unterminated', '=;=;=', ';;;', '"\\"escaped\\"";r=;t=abc', '   '];
      for (const value of weird) {
        expect(() => parseRateLimitHeaders(new Headers({ RateLimit: value }), NOW)).not.toThrow();
      }
    });

    it('ignores negative values', () => {
      const headers = new Headers({ 'X-RateLimit-Remaining': '-1' });
      expect(parseRateLimitHeaders(headers, NOW)).toBeNull();
    });
  });
});

describe('parseRetryAfter', () => {
  it('converts integer seconds to milliseconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(' 7 ', NOW)).toBe(7_000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('accepts fractional seconds', () => {
    expect(parseRetryAfter('1.5', NOW)).toBe(1_500);
  });

  it('converts a future HTTP-date to a delay from now', () => {
    const future = new Date(NOW + 90_000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBe(90_000);
  });

  it('clamps a past HTTP-date to zero', () => {
    const past = new Date(NOW - 90_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  it('returns undefined for garbage, negatives, empty and null', () => {
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter('5 seconds', NOW)).toBeUndefined();
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });
});
