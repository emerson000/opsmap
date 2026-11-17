// The task services this server has: each provider module's factory reads its own environment and returns a provider
// or nothing (server/providers/index.ts lists the modules). Nothing outside server/providers/ names a provider.
import type { ProviderInfo } from '../../src/core/commands/grammar';
import type { ProviderDescriptor, ProviderFactory, TaskProvider } from './contract';
import { PROVIDERS } from '../providers';
export interface ProviderModule {
  id:string; factory:ProviderFactory;
  /** Older webhook paths (with :map) that reach this provider's deliveries; the first is where the engine registers its webhooks. */
  legacyRoutes?:{ provider:string; hook:string }[];
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
