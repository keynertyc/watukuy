import { describe, expect, it } from 'vitest';
import { parseProblemDetails } from './problem.ts';

const PROBLEM = JSON.stringify({
  type: 'https://example.com/probs/out-of-credit',
  title: 'You do not have enough credit.',
  status: 403,
  detail: 'Your current balance is 30, but that costs 50.',
  instance: '/account/12345/msgs/abc',
  balance: 30,
  accounts: ['/account/12345', '/account/67890'],
});

describe('parseProblemDetails', () => {
  it('parses application/problem+json with parameters and keeps extensions', () => {
    const problem = parseProblemDetails('application/problem+json; charset=utf-8', PROBLEM);
    expect(problem).toEqual({
      type: 'https://example.com/probs/out-of-credit',
      title: 'You do not have enough credit.',
      status: 403,
      detail: 'Your current balance is 30, but that costs 50.',
      instance: '/account/12345/msgs/abc',
      balance: 30,
      accounts: ['/account/12345', '/account/67890'],
    });
  });

  it('is case-insensitive on the media type', () => {
    expect(parseProblemDetails('Application/Problem+JSON', '{"title":"x"}')).toEqual({
      title: 'x',
    });
  });

  it('accepts problem+json bodies even without the standard keys', () => {
    expect(parseProblemDetails('application/problem+json', '{"code":"E1"}')).toEqual({
      code: 'E1',
    });
  });

  it('parses application/json when the body carries a problem key', () => {
    expect(parseProblemDetails('application/json', '{"title":"Nope","status":404}')).toEqual({
      title: 'Nope',
      status: 404,
    });
    expect(parseProblemDetails('application/json', '{"detail":"d"}')).toEqual({ detail: 'd' });
    expect(parseProblemDetails('application/json', '{"type":"about:blank"}')).toEqual({
      type: 'about:blank',
    });
  });

  it('accepts other +json media types when problem keys are present', () => {
    expect(parseProblemDetails('application/vnd.api+json', '{"detail":"d"}')).toEqual({
      detail: 'd',
    });
  });

  it('returns undefined for JSON bodies without any problem key', () => {
    expect(parseProblemDetails('application/json', '{"error":"boom"}')).toBeUndefined();
  });

  it('returns undefined for non-JSON content types even if the body looks like a problem', () => {
    expect(parseProblemDetails('text/plain', '{"title":"x"}')).toBeUndefined();
    expect(parseProblemDetails('text/html', '<h1>Not Found</h1>')).toBeUndefined();
    expect(parseProblemDetails(null, '{"title":"x"}')).toBeUndefined();
  });

  it('returns undefined for invalid JSON, non-objects, empty or missing bodies', () => {
    expect(parseProblemDetails('application/problem+json', '{not json')).toBeUndefined();
    expect(parseProblemDetails('application/problem+json', '["title"]')).toBeUndefined();
    expect(parseProblemDetails('application/problem+json', '"title"')).toBeUndefined();
    expect(parseProblemDetails('application/problem+json', 'null')).toBeUndefined();
    expect(parseProblemDetails('application/problem+json', '')).toBeUndefined();
    expect(parseProblemDetails('application/problem+json', '   ')).toBeUndefined();
    expect(parseProblemDetails('application/problem+json', undefined)).toBeUndefined();
  });

  it('coerces a numeric-string status and drops ill-typed standard members', () => {
    const body = JSON.stringify({ status: '404', title: 42, detail: null, type: ['x'] });
    expect(parseProblemDetails('application/problem+json', body)).toEqual({ status: 404 });
    expect(parseProblemDetails('application/problem+json', '{"status":"abc"}')).toEqual({});
  });

  it('never throws', () => {
    expect(() => parseProblemDetails('application/json', String.fromCharCode(0))).not.toThrow();
    expect(() => parseProblemDetails(';;;', '{}')).not.toThrow();
  });
});
