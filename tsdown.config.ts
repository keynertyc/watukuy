import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'store-sqlite': 'src/stores/sqlite/index.ts',
    'store-postgres': 'src/stores/postgres/index.ts',
    'store-redis': 'src/stores/redis/index.ts',
    nestjs: 'src/nestjs/index.ts',
    otel: 'src/otel/index.ts',
    sinks: 'src/sinks/index.ts',
    testing: 'src/testing/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  publint: true,
  attw: { profile: 'esm-only' },
});
