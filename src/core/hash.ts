/**
 * SHA-256 over a UTF-8 string, hex encoded. Uses Web Crypto so the core runs on Node, Bun, Deno,
 * and Cloudflare Workers alike (see docs/serverless.md).
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Short stable hash for keying validators by URL. */
export async function hashUrl(url: string): Promise<string> {
  return (await sha256Hex(url)).slice(0, 32);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b];
  return out;
}

/** Non-cryptographic 53-bit hash (cyrb53) for in-memory bucketing where speed matters. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
