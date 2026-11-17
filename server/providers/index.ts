// The task services this server can use. Each module's factory reads its own environment variables and returns a
// provider, or nothing when it is not configured. Adding a provider is one line here.
import type { ProviderFactory } from '../tasksync/contract';
import type { ProviderModule } from '../tasksync/registry';
import { vikunja } from './vikunja';
import { fakeProvider } from './fake/provider';
export const MODULES: ProviderModule[] = [vikunja, { id: 'fake', factory: fakeProvider }];
export const PROVIDERS: ProviderFactory[] = MODULES.map(m => m.factory);
/** Old webhook paths that still reach a provider (D7). */
export const LEGACY_ROUTES = MODULES.flatMap(m => m.legacyRoutes ?? []);
