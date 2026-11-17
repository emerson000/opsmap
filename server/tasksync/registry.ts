// The task services this server has: each provider module's factory reads its own environment and returns a provider
// or nothing (server/providers/index.ts lists the modules). Nothing outside server/providers/ names a provider.
import type { ProviderInfo } from '../../src/core/commands/grammar';
import type { Maps } from '../maps';
import type { ProviderDescriptor, ProviderFactory, TaskProvider } from './contract';
import type { Credentials } from './credentials';
import type { SyncService } from './service';
import { PROVIDERS } from '../providers';
export interface ProviderModule {
  id:string; factory:ProviderFactory;
  /** Old webhook paths (with :map) that still reach this provider's deliveries, until its webhooks are re-registered. */
  legacyRoutes?:{ provider:string; hook:string }[];
  /** Until the provider-neutral engine runs every provider: the module's own sync service, when it has one. */
  sync?(context:{ maps:Maps; provider:TaskProvider; credentials:Credentials; publicUrl:string }):SyncService;
}
export class ProviderRegistry {
  private readonly byId=new Map<string,TaskProvider>();
  constructor(list:TaskProvider[]) {
    const names=new Set<string>();
    for(const p of list){for(const name of [p.descriptor.id,...p.descriptor.aliases]){if(names.has(name))throw new Error(`Two task services use the name ${name}`);names.add(name);}this.byId.set(p.descriptor.id,p);}
  }
  get(id:string):TaskProvider|undefined {return this.byId.get(id);}
  list():TaskProvider[] {return [...this.byId.values()];}
  descriptors():ProviderDescriptor[] {return this.list().map(p=>p.descriptor);}
  /** What the grammar needs: ids, labels, aliases. */
  info():ProviderInfo[] {return this.list().map(({descriptor:d})=>({id:d.id,label:d.label,aliases:[...d.aliases],rootNoun:d.rootNoun}));}
  static fromEnv(env:NodeJS.ProcessEnv,factories:ProviderFactory[]=PROVIDERS):ProviderRegistry {
    return new ProviderRegistry(factories.map(f=>f(env)).filter((p):p is TaskProvider=>p!==undefined));
  }
}
