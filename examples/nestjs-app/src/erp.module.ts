import { resolve } from 'node:path';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type FakeErp, startFakeErp } from '../../legacy-orders/fake-erp.ts';

/** Injection token for the running fake ERP (stands in for "the vendor's base URL + token"). */
export const FAKE_ERP = Symbol('FAKE_ERP');

/**
 * Boots the fake legacy ERP in-process so the example needs no network and no credentials.
 * In a real app this module would just provide configuration (base URL, API key).
 * The ERP persists its dataset in the working directory so app restarts resume realistically.
 */
@Global()
@Module({
  providers: [
    {
      provide: FAKE_ERP,
      useFactory: (): Promise<FakeErp> =>
        startFakeErp({ statePath: resolve('nestjs-orders.erp.json') }),
    },
  ],
  exports: [FAKE_ERP],
})
export class ErpModule implements OnApplicationShutdown {
  constructor(@Inject(FAKE_ERP) private readonly erp: FakeErp) {}

  // Runs after `beforeApplicationShutdown`, i.e. after WatukuyModule has drained the engine.
  onApplicationShutdown(): Promise<void> {
    return this.erp.close();
  }
}
