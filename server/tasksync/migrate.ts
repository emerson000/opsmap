// One-time moves of task sync data into the provider-neutral tables, each guarded by a store meta key.
import type { Store } from '../db';
import type { SecretBox } from '../secrets';
import type { Doc } from '../../src/core/model/types';
import { apply } from '../../src/core/commands/apply';
import { emptyDoc } from '../../src/core/model/seed';
import { TASK_SYNC_TABLES } from './links';
/** The owner a token is sealed for: a sealed value opens only for its user and provider. */
export const tokenOwner=(userId:string,provider:string)=>`${provider}:${userId}`;
/** Vikunja tokens (vk_tokens, sealed for the user alone) → ts_tokens, sealed for the user and provider `vikunja`.
 *  vk_tokens stays until the full migration drops it; a token that no longer opens is not copied. */
export const TOKENS_TABLE='CREATE TABLE IF NOT EXISTS ts_tokens(user_id TEXT NOT NULL,provider TEXT NOT NULL,sealed TEXT NOT NULL,username TEXT NOT NULL,saved_at TEXT NOT NULL,PRIMARY KEY(user_id,provider))';
export function migrateTokens(store:Store,box:SecretBox):void {
  store.db.exec(TOKENS_TABLE);
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
const hasTable=(store:Store,name:string)=>Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const count=(store:Store,sql:string,...args:string[])=>(store.db.prepare(sql).get(...args) as {n:number}).n;
/** D8: the Vikunja sync's links (vk_links) and per-map state (vk_maps) → ts_links and ts_maps, once (meta tasksync_v1),
 *  in one transaction; then the old tables go and snapshots are cleared, so maps replay their `vk` ops in the neutral
 *  shape. Task ids become strings; the agreed values keep their field names. vk_tokens goes once its copy into
 *  ts_tokens has run (migrateTokens, which needs the secret key), so a token removed since never comes back. */
export function migrateTaskSync(store:Store):void {
  store.db.exec(TASK_SYNC_TABLES);
  if(store.meta('tasksync_v1')!=='1') {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const links=hasTable(store,'vk_links'),maps=hasTable(store,'vk_maps');
      if(links)store.db.exec('INSERT OR IGNORE INTO ts_links(map_id,unit_id,remote_id,base) SELECT map_id,unit_id,CAST(task_id AS TEXT),base FROM vk_links');
      if(maps) {
        const put=store.db.prepare("INSERT OR IGNORE INTO ts_maps(map_id,provider,secret,hooks,owner,hooks_checked,last_delivery,relations) VALUES(?,'vikunja',?,?,?,?,?,?)");
        for(const r of store.db.prepare('SELECT * FROM vk_maps').all() as {map_id:string;secret:string;hooks:string|null;owner:string|null;hooks_checked:string|null;last_delivery:string|null;relations?:string|null}[]) {
          let relations=r.relations??null;
          if(relations){const saved=JSON.parse(relations) as {parents?:Record<string,number|string|null>};if(saved.parents)saved.parents=Object.fromEntries(Object.entries(saved.parents).map(([k,v])=>[k,v===null?null:String(v)]));relations=JSON.stringify(saved);}
          put.run(r.map_id,r.secret,r.hooks,r.owner,r.hooks_checked,r.last_delivery,relations);
        }
      }
      store.db.exec('DROP TABLE IF EXISTS vk_links; DROP TABLE IF EXISTS vk_maps;');
      if(links||maps)store.db.exec('DELETE FROM snapshots');
      store.setMeta('tasksync_v1','1');store.db.exec('COMMIT');
    }catch(error){store.db.exec('ROLLBACK');throw error;}
  }
  if(store.meta('ts_tokens_from_vk')==='1'&&hasTable(store,'vk_tokens'))store.db.exec('DROP TABLE vk_tokens');
}
/** A map's document from its whole journal, without touching the store (the hub's snapshots may be in the old shape). */
function replay(store:Store,mapId:string):Doc {
  let doc=emptyDoc('UTC');
  for(const op of store.db.prepare('SELECT seq,cmd,at,user_id,source,via FROM ops WHERE map_id=? ORDER BY seq').all(mapId) as {seq:number;cmd:string;at:string;user_id:string;source:string;via:string|null}[]) {
    const result=apply(doc,JSON.parse(op.cmd),new Date(op.at),op.user_id,op.via??op.source);
    if('error'in result)throw new Error(`Replay of map ${mapId} failed at operation ${op.seq}`);
    doc=result.doc;
  }
  return doc;
}
/** What migrateTaskSync would move (`tasks migrate --dry-run`), one line per bound map. */
export function taskSyncSummary(store:Store):string[] {
  if(store.meta('tasksync_v1')==='1')return ['already migrated'];
  if(!hasTable(store,'vk_maps'))return ['nothing to migrate'];
  const tokens=hasTable(store,'vk_tokens')?count(store,'SELECT COUNT(*) AS n FROM vk_tokens'):hasTable(store,'ts_tokens')?count(store,"SELECT COUNT(*) AS n FROM ts_tokens WHERE provider='vikunja'"):0;
  const links=hasTable(store,'vk_links');
  return (store.db.prepare('SELECT map_id FROM vk_maps ORDER BY map_id').all() as {map_id:string}[]).map(({map_id:id})=>{
    const bound=replay(store,id).settings.taskSync,n=links?count(store,'SELECT COUNT(*) AS n FROM vk_links WHERE map_id=?',id):0;
    return `map ${id}: ${bound?`bound to ${bound.label} project ${bound.root}`:'not bound'}, ${n} units linked, ${tokens} tokens`;
  });
}
