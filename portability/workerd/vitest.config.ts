import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs the runtime-agnostic core suites inside workerd (PLAN §9.6). Store, CLI, NestJS, and OTel
// suites are Node-specific by design and excluded here.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: [
      '../../src/core/**/*.test.ts',
      '../../src/scheduler/**/*.test.ts',
      '../../src/cursor/**/*.test.ts',
      '../../src/diff/**/*.test.ts',
      '../../src/budget/**/*.test.ts',
      '../../src/http/**/*.test.ts',
      '../../src/validate/**/*.test.ts',
      '../../src/testing/**/*.test.ts',
      '../../test/integration/**/*.test.ts',
    ],
  },
});
