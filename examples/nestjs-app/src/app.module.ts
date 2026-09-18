import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { WatukuyHealthIndicator, WatukuyModule, type WatukuyModuleOptions } from 'watukuy/nestjs';
import { SqliteStore } from 'watukuy/store-sqlite';
import type { FakeErp } from '../../legacy-orders/fake-erp.ts';
import { ErpModule, FAKE_ERP } from './erp.module.ts';
import { HealthController } from './health.controller.ts';
import { InspectController } from './inspect.controller.ts';
import { OrdersHandler } from './orders.handler.ts';
import { ordersPoller } from './orders.poller.ts';

// One SQLite file in the working directory (`pnpm start` runs from examples/nestjs-app);
// restarts resume from the saved cursor.
const dbPath = resolve('nestjs-orders.db');

@Module({
  imports: [
    ErpModule,
    TerminusModule,
    // `forRootAsync` because the poller needs the ERP's URL, which is only known once the
    // FAKE_ERP provider has started. With a static URL, `forRoot({ store, pollers })` suffices.
    WatukuyModule.forRootAsync({
      inject: [FAKE_ERP],
      useFactory: async (erp: FakeErp): Promise<WatukuyModuleOptions> => {
        const store = new SqliteStore({ path: dbPath });
        await store.migrate(); // idempotent; the module does not migrate for you
        return {
          store,
          pollers: [ordersPoller(erp.url)],
          // 'daemon' (default): engine.start() at bootstrap, engine.stop() at shutdown.
          stop: { drain: true, timeout: '10s' },
        };
      },
    }),
  ],
  controllers: [HealthController, InspectController],
  // WatukuyHealthIndicator is not registered by WatukuyModule (terminus is optional): add it here.
  providers: [OrdersHandler, WatukuyHealthIndicator],
})
export class AppModule {}
