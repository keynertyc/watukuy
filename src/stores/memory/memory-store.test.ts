import { storeContractSuite } from '../../testing/store-contract.ts';
import { MemoryStore } from './memory-store.ts';

storeContractSuite({ name: 'MemoryStore', create: () => new MemoryStore() });
