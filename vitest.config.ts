import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['test/types/**/*.test-d.ts', 'test/docs/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/cli/**', 'src/**/index.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
