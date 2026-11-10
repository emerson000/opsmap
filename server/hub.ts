import { randomUUID } from 'node:crypto';
import type { Command, Doc, InversePatch } from '../src/core/model/types';
import { emptyDoc } from '../src/core/model/seed';
import { importJson } from '../src/core/model/json';
import { apply } from '../src/core/commands/apply';
import { createInverse } from '../src/core/model/patch';
import { Store, DEFAULT_MAP } from './db';
import { DEFAULT_TZ } from '../src/core/model/time';
export interface Op {seq:number;opId:string;userId:string;source:'web'|'mcp'|'system';at:string;cmd:Command;log:string;via?:string;}
interface Row {map_id:string;seq:number;op_id:string;user_id:string;source:Op['source'];at:string;cmd:string;log:string;inverse:string;undone_by:number|null;reverts:number|null;principal:string|null;via:string|null;}
const toOp=(r:Row):Op=>({seq:r.seq,opId:r.op_id,userId:r.user_id,source:r.source,at:r.at,cmd:JSON.parse(r.cmd),log:r.log,...(r.via?{via:r.via}:{})});
const mutationVerbs=new Set(['new','id','size','fn','rename','move','attack','moving','axis','advancing','bda','block','unblock','done','drop','reinforce','reduce','attach','detach','link','due','note','rate','key','cp','sector','pl','obj','ea','nai','intent','sidc']);
function overlaps(a:InversePatch,b:InversePatch):boolean {
  return (['units','orders','measures','sectors'] as const).some(k=>a[k].some(x=>b[k].some(y=>x.id===y.id)))||Object.keys(a.top).some(k=>Object.hasOwn(b.top,k));
}
export class Hub {
  doc:Doc;seq=0;
  readonly listeners=new Set<(op:Op)=>void>();
  constructor(readonly store:Store,readonly mapId:string=DEFAULT_MAP,readonly tz:string=DEFAULT_TZ) {
    this.doc=emptyDoc(tz);
    // New core semantics and attribution require one replay from the authoritative op history.
    if(store.meta('snapshots_v2_reset')!=='1'){store.db.exec('DELETE FROM snapshots');store.setMeta('snapshots_v2_reset','1');}
    const snap=store.db.prepare('SELECT * FROM snapshots WHERE map_id=? ORDER BY seq DESC LIMIT 1').get(mapId) as {seq:number;doc:string}|undefined;
    if(snap){this.doc=this.zoned(importJson(snap.doc));this.seq=snap.seq;}
    for(const op of this.since(this.seq)) {
      const result=apply(this.doc,op.cmd,new Date(op.at),op.userId,op.via??op.source);
      if('error'in result)throw new Error(`Replay failed at operation ${op.seq}`);
      this.doc=this.zoned(result.doc);this.seq=op.seq;
    }
  }
  /** Every map carries its calendar zone, so clients and replays agree without a configured default. */
  private zoned(doc:Doc):Doc {return doc.settings.tz?doc:{...doc,settings:{...doc.settings,tz:this.tz}};}
  since(seq:number):Op[] {return (this.store.db.prepare('SELECT * FROM ops WHERE map_id=? AND seq>? ORDER BY seq').all(this.mapId,seq) as unknown as Row[]).map(toOp);}
  snapshot() {this.store.db.prepare('INSERT OR REPLACE INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run(this.mapId,this.seq,JSON.stringify(this.doc),new Date().toISOString());this.pruneSnapshots();}
  private pruneSnapshots(){this.store.db.prepare('DELETE FROM snapshots WHERE map_id=? AND seq NOT IN (SELECT seq FROM snapshots WHERE map_id=? ORDER BY seq DESC LIMIT 3)').run(this.mapId,this.mapId);}
  existing(opId:string,userId:string):Op|undefined {
    const row=this.store.db.prepare('SELECT * FROM ops WHERE op_id=?').get(opId) as unknown as Row|undefined;
    if(row&&row.user_id!==userId)throw new Error('Operation id belongs to another user');
    if(row&&row.map_id!==this.mapId)throw new Error('Operation id belongs to another map');
    return row?toOp(row):undefined;
  }
  submit(userId:string,source:Op['source'],opId:string,cmd:Command,now=new Date(),agent?:{id:string;name:string}):Op {
    if(source!=='system'&&opId.startsWith('turn:'))throw new Error('Reserved operation id');
    const old=this.existing(opId,userId);if(old)return old;
    if(!cmd||typeof cmd.verb!=='string'||!cmd.args||typeof cmd.args!=='object'||Array.isArray(cmd.args)||!(mutationVerbs.has(cmd.verb)||source==='system'&&userId==='system'&&cmd.verb==='turn'))throw new Error('Invalid or privileged command');
    const safe={verb:cmd.verb,args:cmd.args,...(typeof cmd.raw==='string'&&cmd.raw.startsWith('/')?{raw:cmd.raw.slice(0,512)}:{})};
    if(JSON.stringify(safe.args).length>16384)throw new Error('Command too large');
    for(const value of Object.values(safe.args))if(typeof value==='string'&&value.length>2048)throw new Error('Text exceeds 2048 characters');
    return this.commit(userId,source,opId,safe,now,undefined,undefined,agent);
  }
  import(userId:string,doc:unknown,now=new Date()):Op {
    const validated=this.zoned(importJson(JSON.stringify(doc)));
    return this.commit(userId,'web',randomUUID(),{verb:'import',args:{doc:validated}},now);
  }
  private commit(userId:string,source:Op['source'],opId:string,cmd:Command,now:Date,reverts?:number,redoOriginal?:number,agent?:{id:string;name:string}):Op {
    if(typeof opId!=='string'||!opId.length||opId.length>128)throw new Error('Invalid operation id');
    if(source!=='system'&&opId.startsWith('turn:'))throw new Error('Reserved operation id');
    const via=agent?`mcp:${agent.name}`:source;
    const result=apply(this.doc,cmd,now,userId,via);
    if('error'in result)throw new Error(result.error);
    if(result.doc===this.doc)throw new Error('No change');
    // Core commands are parsed client-side; validate resulting references and types at the trust boundary.
    const next=this.zoned(importJson(JSON.stringify(result.doc)));
    const inverse=createInverse(this.doc,result.touched);
    const op:Op={seq:this.seq+1,opId,userId,source,at:now.toISOString(),cmd,log:result.log,via};
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO ops(map_id,seq,op_id,user_id,source,at,cmd,log,inverse,reverts,principal,via) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(this.mapId,op.seq,opId,userId,source,op.at,JSON.stringify(cmd),op.log,JSON.stringify(inverse),reverts??null,agent?`token:${agent.id}`:`user:${userId}`,via);
      if(reverts!==undefined)db.prepare('UPDATE ops SET undone_by=? WHERE map_id=? AND seq=?').run(op.seq,this.mapId,reverts);
      if(redoOriginal!==undefined)db.prepare('UPDATE ops SET undone_by=NULL WHERE map_id=? AND seq=?').run(this.mapId,redoOriginal);
      if(cmd.verb==='turn'&&next.lastTurn)this.store.setLastTurn(this.mapId,next.lastTurn);
      if(op.seq%200===0)db.prepare('INSERT OR REPLACE INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run(this.mapId,op.seq,JSON.stringify(next),op.at);
      this.pruneSnapshots();
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    this.doc=next;this.seq=op.seq;
    for(const listener of this.listeners)listener(op);
    return op;
  }
  undo(userId:string,opId:string,redo=false,source:Op['source']='web',agent?:{id:string;name:string}):Op {
    const existing=this.existing(opId,userId);if(existing)return existing;
    const rows=this.store.db.prepare('SELECT * FROM ops WHERE map_id=? ORDER BY seq').all(this.mapId) as unknown as Row[];
    const bySeq=new Map(rows.map(r=>[r.seq,r]));
    const root=(row:Row):number=>{while(row.reverts!==null)row=bySeq.get(row.reverts)!;return row.seq;};
    const candidates=rows.filter(r=>(r.principal??`user:${r.user_id}`)===(agent?`token:${agent.id}`:`user:${userId}`)&&r.undone_by===null&&(redo?r.reverts!==null&&bySeq.get(r.reverts)?.reverts===null&&bySeq.get(r.reverts)?.undone_by===r.seq:r.reverts===null));
    const target=candidates.at(-1);if(!target)throw new Error(`Nothing to ${redo?'redo':'undo'}`);
    // Redo only a direct undo of an original, never a redo of a redo.
    if(redo&&bySeq.get(target.reverts!)?.reverts!==null)throw new Error('Nothing to redo');
    const inverse:InversePatch=JSON.parse(target.inverse),targetRoot=root(target);
    const cancelled=new Set<number>();
    for(const row of rows)if(row.undone_by!==null){cancelled.add(row.seq);cancelled.add(row.undone_by);}
    const conflict=rows.find(r=>r.seq>target.seq&&!cancelled.has(r.seq)&&root(r)!==targetRoot&&(!redo||root(r)>targetRoot)&&overlaps(inverse,JSON.parse(r.inverse)));
    if(conflict)throw new Error(conflict.user_id===userId?`You changed it since in op ${conflict.seq}`:`Changed since by ${this.store.user(conflict.user_id)?.name??conflict.user_id}`);
    return this.commit(userId,source,opId,{verb:'revert',args:{seq:target.seq,inverse}},new Date(),target.seq,redo?targetRoot:undefined,agent);
  }
}
