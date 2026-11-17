// One-time moves of task sync data into the provider-neutral tables, each guarded by a store meta key.
import type { Store } from '../db';
import type { SecretBox } from '../secrets';
/** The owner a token is sealed for: a sealed value opens only for its user and provider. */
export const tokenOwner=(userId:string,provider:string)=>`${provider}:${userId}`;
/** Vikunja tokens (vk_tokens, sealed for the user alone) → ts_tokens, sealed for the user and provider `vikunja`.
 *  vk_tokens stays until the full migration drops it; a token that no longer opens is not copied. */
export function migrateTokens(store:Store,box:SecretBox):void {
  if(store.meta('ts_tokens_from_vk')==='1')return;
  const has=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vk_tokens'").get();
  const rows=has?store.db.prepare('SELECT user_id,sealed,username,saved_at FROM vk_tokens').all() as {user_id:string;sealed:string;username:string;saved_at:string}[]:[];
  const put=store.db.prepare("INSERT OR IGNORE INTO ts_tokens(user_id,provider,sealed,username,saved_at) VALUES(?,'vikunja',?,?,?)");
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for(const r of rows){let token:string;try{token=box.open(r.sealed,r.user_id);}catch{continue;}put.run(r.user_id,box.seal(token,tokenOwner(r.user_id,'vikunja')),r.username,r.saved_at);}
    store.setMeta('ts_tokens_from_vk','1');store.db.exec('COMMIT');
  }catch(error){store.db.exec('ROLLBACK');throw error;}
}
