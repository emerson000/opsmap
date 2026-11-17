// The task services this server has: each provider module's factory reads its own environment and returns a provider
// or nothing (server/providers/index.ts lists the modules). Nothing outside server/providers/ names a provider.
import type { ProviderInfo } from '../../src/core/commands/grammar';
import type { ProviderDescriptor, ProviderFactory, TaskProvider } from './contract';
import { PROVIDERS } from '../providers';
import { SYNC_FIELDS, type SyncField } from '../../src/core/model/types';
import { FIELD_KEY, SWITCHED } from './merge';
export interface ProviderModule {
  id:string; factory:ProviderFactory;
  /** Older webhook paths (with :map) that reach this provider's deliveries; the first is where the engine registers its webhooks. */
  legacyRoutes?:{ provider:string; hook:string }[];
}
export class ProviderRegistry {
  private readonly byId=new Map<string,TaskProvider>();
  constructor(list:TaskProvider[]) {
    const names=new Set<string>();
    for(const p of list){for(const name of new Set([p.descriptor.id,...p.descriptor.aliases])){if(names.has(name))throw new Error(`Two task services use the name ${name}`);names.add(name);}this.byId.set(p.descriptor.id,p);}
  }
  get(id:string):TaskProvider|undefined {return this.byId.get(id);}
  list():TaskProvider[] {return [...this.byId.values()];}
  /** What the browser shows (the welcome's taskSync): the descriptor, and the field switches (D21) the service syncs. */
  descriptors():(ProviderDescriptor&{ fields:SyncField[] })[] {return this.list().map(p=>({...p.descriptor,fields:SYNC_FIELDS.filter(f=>p.capabilities.fields.has(FIELD_KEY[SWITCHED[f]]))}));}
  /** What the grammar needs: ids, labels, aliases. */
  info():ProviderInfo[] {return this.list().map(({descriptor:d})=>({id:d.id,label:d.label,aliases:[...d.aliases],rootNoun:d.rootNoun}));}
  static fromEnv(env:NodeJS.ProcessEnv,factories:ProviderFactory[]=PROVIDERS):ProviderRegistry {
    return new ProviderRegistry(factories.map(f=>f(env)).filter((p):p is TaskProvider=>p!==undefined));
  }
}
