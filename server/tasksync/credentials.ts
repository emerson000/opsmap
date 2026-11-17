// Each user's token for each task service, set in the app (user menu → the service), checked with the provider and
// sealed with the server's SecretBox for that user and provider. Tokens never leave the server: the app sees only
// whether one is set and the service's user name. A map syncs with its binder's token, never one a document names.
import type { Store } from '../db';
import type { SecretBox } from '../secrets';
import { RemoteAuthError, type ProviderSession, type TaskProvider } from './contract';
import type { ProviderRegistry } from './registry';
import { migrateTokens, tokenOwner } from './migrate';
export interface TaskAccount { connected:boolean; username?:string; savedAt?:string }
export class Credentials {
  constructor(private readonly store:Store,private readonly box:SecretBox,private readonly registry:ProviderRegistry) {
    migrateTokens(store,box);
  }
  private provider(id:string):TaskProvider {const p=this.registry.get(id);if(!p)throw new Error(`Unknown task service: ${id}`);return p;}
  account(userId:string,provider:string):TaskAccount {
    this.provider(provider);
    const row=this.store.db.prepare('SELECT username,saved_at FROM ts_tokens WHERE user_id=? AND provider=?').get(userId,provider) as {username:string;saved_at:string}|undefined;
    return row?{connected:true,username:row.username,savedAt:row.saved_at}:{connected:false};
  }
  /** Checks the token with the provider, then stores it sealed. */
  async save(userId:string,provider:string,token:unknown):Promise<TaskAccount> {
    const p=this.provider(provider),label=p.descriptor.label,value=typeof token==='string'?token.trim():'';
    if(value.length<8||value.length>512||/\s/.test(value))throw new Error(`That does not look like a ${label} token`);
    let username:string;
    try{username=(await p.verify(value)).username;}
    catch(error){if(error instanceof RemoteAuthError)throw new Error(`${label} refused that token`);throw new Error(`Could not reach ${label}: ${error instanceof Error?error.message:'unknown error'}`);}
    const now=new Date().toISOString();
    this.store.db.prepare('INSERT INTO ts_tokens(user_id,provider,sealed,username,saved_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET sealed=excluded.sealed,username=excluded.username,saved_at=excluded.saved_at')
      .run(userId,provider,this.box.seal(value,tokenOwner(userId,provider)),username,now);
    return {connected:true,username,savedAt:now};
  }
  remove(userId:string,provider:string):void {this.store.db.prepare('DELETE FROM ts_tokens WHERE user_id=? AND provider=?').run(userId,provider);}
  /** The user's token, or undefined when none is set or it no longer opens (another key, user or provider). */
  token(userId:string|undefined,provider:string):string|undefined {
    if(!userId)return undefined;
    const row=this.store.db.prepare('SELECT sealed FROM ts_tokens WHERE user_id=? AND provider=?').get(userId,provider) as {sealed:string}|undefined;
    if(!row)return undefined;
    try{return this.box.open(row.sealed,tokenOwner(userId,provider));}catch{return undefined;}
  }
  /** A connection with the user's token, or undefined when there is none. */
  session(userId:string|undefined,provider:string):ProviderSession|undefined {
    const p=this.registry.get(provider),token=p&&this.token(userId,provider);
    return p&&token?p.connect(token):undefined;
  }
}
