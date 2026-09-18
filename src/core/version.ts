/**
 * Package version, injected at build time by tsdown (`define`). Falls back to `0.0.0-dev` when
 * running from source (tests, examples).
 */
declare const __WATUKUY_VERSION__: string | undefined;
export const VERSION: string =
  typeof __WATUKUY_VERSION__ === 'string' ? __WATUKUY_VERSION__ : '0.0.0-dev';
