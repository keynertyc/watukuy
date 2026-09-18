/**
 * Shared site constants for astro.config.mjs and scripts/sync-docs.mjs, so the base path used
 * for routing and the base path baked into rewritten Markdown links can never disagree.
 *
 * Environment:
 *   DOCS_SITE  origin of the deployed site (default: https://keyner.github.io)
 *   DOCS_BASE  path prefix under that origin (default: /watukuy; use "/" for a custom domain)
 */

export const REPO_URL = 'https://github.com/keyner/watukuy';
export const DEFAULT_SITE = 'https://keyner.github.io';
export const DEFAULT_BASE = '/watukuy';

/** Normalized base path: `''` for the site root, otherwise `/segment` without a trailing slash. */
export function resolveBase(raw = process.env.DOCS_BASE) {
  const value = (raw ?? DEFAULT_BASE).trim();
  if (value === '' || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

/** Site origin without a trailing slash. */
export function resolveSite(raw = process.env.DOCS_SITE) {
  const value = (raw ?? DEFAULT_SITE).trim().replace(/\/+$/, '');
  return value === '' ? DEFAULT_SITE : value;
}
