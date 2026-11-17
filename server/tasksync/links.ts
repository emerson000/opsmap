// The task sync's bookkeeping on the server, never in a map document: which task each unit is linked to and the
// values both sides last agreed on (ts_links), and per bound map its provider, binder, webhook secret and state, the
// relations last agreed on, and the delivery record (ts_maps).
import { randomBytes } from 'node:crypto';
import type { Store } from '../db';
import type { DeliveryRecord } from './delivery';
import type { Fields } from './merge';
export const TASK_SYNC_TABLES=`CREATE TABLE IF NOT EXISTS ts_links(map_id TEXT NOT NULL,unit_id TEXT NOT NULL,remote_id TEXT NOT NULL,base TEXT NOT NULL,PRIMARY KEY(map_id,unit_id));
  CREATE TABLE IF NOT EXISTS ts_maps(map_id TEXT PRIMARY KEY,provider TEXT NOT NULL,secret TEXT NOT NULL,hooks TEXT,owner TEXT,hooks_checked TEXT,last_delivery TEXT,state TEXT,relations TEXT,delivery TEXT);`;
/** The relations both sides last agreed on: each unit's parent task, and the relations between open units (edge keys).
 *  `refused`: relations made remotely that opsmap would not take (a link across sectors), not tried again. */
export interface RelationBase { parents:Record<string,string|null>; edges:string[]; refused:string[] }
export interface MapRow { map_id:string; provider:string; secret:string; hooks:string|null; owner:string|null; hooks_checked:string|null; last_delivery:string|null; state:string|null; relations:string|null; delivery:string|null }
const json=<T>(text:string|null|undefined,fallback:T):T=>{if(!text)return fallback;try{return JSON.parse(text) as T;}catch{return fallback;}};
export class SyncTables {
  constructor(private readonly store:Store) {store.db.exec(TASK_SYNC_TABLES);}
  private get db() {return this.store.db;}
  base(mapId:string,unitId:string):Fields|undefined {return json<Fields|undefined>((this.db.prepare('SELECT base FROM ts_links WHERE map_id=? AND unit_id=?').get(mapId,unitId) as {base:string}|undefined)?.base,undefined);}
  setBase(mapId:string,unitId:string,remoteId:string,base:Fields|null):void {
    if(base===null){this.db.prepare('DELETE FROM ts_links WHERE map_id=? AND unit_id=?').run(mapId,unitId);return;}
    this.db.prepare('INSERT INTO ts_links(map_id,unit_id,remote_id,base) VALUES(?,?,?,?) ON CONFLICT(map_id,unit_id) DO UPDATE SET remote_id=excluded.remote_id,base=excluded.base').run(mapId,unitId,remoteId,JSON.stringify(base));
  }
  row(mapId:string):MapRow|undefined {return this.db.prepare('SELECT * FROM ts_maps WHERE map_id=?').get(mapId) as MapRow|undefined;}
  /** The map's row, made with a new webhook secret when missing. */
  ensure(mapId:string,provider:string):MapRow {
    const row=this.row(mapId);if(row&&row.provider===provider)return row;
    if(row)this.release(mapId);
    this.db.prepare('INSERT INTO ts_maps(map_id,provider,secret) VALUES(?,?,?)').run(mapId,provider,randomBytes(32).toString('hex'));
    return this.row(mapId)!;
  }
  set(mapId:string,values:Partial<Omit<MapRow,'map_id'>>):void {
    const keys=Object.keys(values) as (keyof typeof values)[];if(!keys.length)return;
    this.db.prepare(`UPDATE ts_maps SET ${keys.map(k=>`${k}=?`).join(',')} WHERE map_id=?`).run(...keys.map(k=>values[k]??null),mapId);
  }
  hooks(mapId:string):unknown {return json<unknown>(this.row(mapId)?.hooks,null);}
  state(mapId:string):unknown {return json<unknown>(this.row(mapId)?.state,null);}
  delivery(mapId:string):DeliveryRecord {return json<DeliveryRecord>(this.row(mapId)?.delivery,{});}
  setDelivery(mapId:string,rec:DeliveryRecord):void {this.set(mapId,{delivery:JSON.stringify(rec)});}
  relations(mapId:string):RelationBase {const saved=json<Partial<RelationBase>>(this.row(mapId)?.relations,{});return {parents:saved.parents??{},edges:saved.edges??[],refused:saved.refused??[]};}
  setRelations(mapId:string,base:RelationBase):void {this.set(mapId,{relations:JSON.stringify(base)});}
  /** Unbound or deleted: its links and state go. */
  release(mapId:string):void {this.db.prepare('DELETE FROM ts_maps WHERE map_id=?').run(mapId);this.db.prepare('DELETE FROM ts_links WHERE map_id=?').run(mapId);}
}
