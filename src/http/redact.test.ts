import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTED_HEADERS, REDACTED_VALUE, redactHeaders } from './redact.ts';

describe('redactHeaders', () => {
  it('masks the default sensitive headers case-insensitively and keeps other values', () => {
    const input = {
      Authorization: 'Bearer secret',
      COOKIE: 'a=b',
      'Set-Cookie': 'sid=1',
      'x-api-key': 'key',
      'Proxy-Authorization': 'Basic xyz',
      Accept: 'application/json',
    };
    expect(redactHeaders(input)).toEqual({
      Authorization: REDACTED_VALUE,
      COOKIE: REDACTED_VALUE,
      'Set-Cookie': REDACTED_VALUE,
      'x-api-key': REDACTED_VALUE,
      'Proxy-Authorization': REDACTED_VALUE,
      Accept: 'application/json',
    });
  });

  it('accepts a Headers instance and yields lower-case names', () => {
    const headers = new Headers({ Authorization: 'Bearer x', 'Content-Type': 'text/plain' });
    expect(redactHeaders(headers)).toEqual({
      authorization: REDACTED_VALUE,
      'content-type': 'text/plain',
    });
  });

  it('masks extra names case-insensitively', () => {
    const input = { 'X-Signature': 'sig', 'X-Other': 'ok' };
    expect(redactHeaders(input, ['x-signature'])).toEqual({
      'X-Signature': REDACTED_VALUE,
      'X-Other': 'ok',
    });
    expect(redactHeaders(input, [' X-SIGNATURE '])['X-Signature']).toBe(REDACTED_VALUE);
  });

  it('does not mutate the input', () => {
    const input = { Authorization: 'Bearer x' };
    redactHeaders(input);
    expect(input.Authorization).toBe('Bearer x');
    const headers = new Headers({ Authorization: 'Bearer x' });
    redactHeaders(headers);
    expect(headers.get('authorization')).toBe('Bearer x');
  });

  it('exposes the default list', () => {
    expect(DEFAULT_REDACTED_HEADERS).toContain('authorization');
    expect(DEFAULT_REDACTED_HEADERS).toContain('set-cookie');
  });
});
