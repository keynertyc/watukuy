import type { ProblemDetails } from '../core/errors.ts';

const PROBLEM_MEDIA_TYPE = 'application/problem+json';
const PROBLEM_KEYS = ['type', 'title', 'status', 'detail'] as const;

/**
 * Parse an RFC 9457 Problem Details body.
 *
 * Returns a {@link ProblemDetails} when the content type is `application/problem+json`
 * (parameters such as `charset` allowed), or when the content type is any JSON media type
 * (`application/json`, `*+json`) and the object carries at least one of `type`, `title`,
 * `status` or `detail`. Standard members are kept only when well-typed (`status` may also be a
 * numeric string); extension members are preserved as-is. Never throws.
 *
 * @param contentType Raw `Content-Type` header value, or `null` when absent.
 * @param bodyText Response body text, or `undefined` when it could not be read.
 */
export function parseProblemDetails(
  contentType: string | null,
  bodyText: string | undefined,
): ProblemDetails | undefined {
  if (bodyText === undefined || bodyText.trim() === '') return undefined;
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const isProblem = mediaType === PROBLEM_MEDIA_TYPE;
  const isJson = isProblem || mediaType === 'application/json' || mediaType.endsWith('+json');
  if (!isJson) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (!isProblem && !PROBLEM_KEYS.some((key) => key in parsed)) return undefined;

  const out: ProblemDetails = {};
  for (const [key, value] of Object.entries(parsed)) {
    switch (key) {
      case 'type':
      case 'title':
      case 'detail':
      case 'instance':
        if (typeof value === 'string') out[key] = value;
        break;
      case 'status':
        if (typeof value === 'number' && Number.isFinite(value)) out.status = value;
        else if (typeof value === 'string' && /^\d{3}$/.test(value)) out.status = Number(value);
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
