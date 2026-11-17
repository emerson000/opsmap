// The task services this server can use. Each module's factory reads its own environment variables and returns a
// provider, or nothing when it is not configured. Adding a provider is one line here.
import type { ProviderFactory } from '../tasksync/contract';
import type { ProviderModule, ProviderRegistry } from '../tasksync/registry';
import type { Credentials } from '../tasksync/credentials';
import type { SyncService } from '../tasksync/service';
import type { Maps } from '../maps';
import { vikunja } from './vikunja';
import { fakeProvider } from './fake/provider';
export const MODULES: ProviderModule[] = [vikunja, { id: 'fake', factory: fakeProvider }];
export const PROVIDERS: ProviderFactory[] = MODULES.map(m => m.factory);
/** Old webhook paths that still reach a provider (D7). */
export const LEGACY_ROUTES = MODULES.flatMap(m => m.legacyRoutes ?? []);
/** The sync service for the configured providers: for now, the one a module brings itself (Vikunja's). */
export function createSyncService(context: { maps: Maps; registry: ProviderRegistry; credentials?: Credentials; publicUrl: string }): SyncService | undefined {
  const { registry, credentials } = context;
  for (const m of MODULES) { const provider = registry.get(m.id); if (m.sync && provider && credentials) return m.sync({ ...context, provider, credentials }); }
  return undefined;
}
