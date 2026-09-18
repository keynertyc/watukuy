/**
 * NestJS 12 + watukuy.
 *
 *   pnpm start                 # tsc build, then node dist/nestjs-app/src/main.js
 *   curl localhost:3000/health
 *   curl localhost:3000/inspect
 *   curl -X POST localhost:3000/orders/trigger
 *
 * Decorators are not erasable syntax, so this example is compiled with `tsc` instead of being
 * run directly by Node. `--duration <seconds>` closes the app after N seconds (default: run
 * until Ctrl+C, which drains in-flight deliveries via `app.enableShutdownHooks()`).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';

const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
app.enableShutdownHooks(); // SIGINT/SIGTERM -> beforeApplicationShutdown -> engine.stop({ drain })

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`[nest] http://localhost:${port}  GET /health  GET /inspect  POST /orders/trigger`);

const flag = process.argv.indexOf('--duration');
const durationSec = flag === -1 ? 0 : Number(process.argv[flag + 1] ?? 0);
if (durationSec > 0) {
  setTimeout(async () => {
    console.log(`[nest] ${durationSec}s elapsed: closing`);
    await app.close();
    process.exit(0);
  }, durationSec * 1_000);
}
