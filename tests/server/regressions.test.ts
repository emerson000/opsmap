import { describe,it,expect } from 'vitest';
import { Store } from '../../server/db';
import { Hub } from '../../server/hub';
import { parse } from '../../src/core/commands/grammar';
import { config } from '../../server/config';
import { Bucket } from '../../server/limit';
import { emptyDoc } from '../../src/core/model/seed';
import { apply } from '../../src/core/commands/apply';

describe('regressions',()=>{
 it('supports undo undo redo redo on one entity and keeps redone conflicts',()=>{
  const store=new Store(':memory:');try {
   const hub=new Hub(store);let n=0;
   const command=(text:string)=>{const p=parse(text,hub.doc);if(!p.ok)throw Error(p.error);hub.submit('human','web',`op${++n}`,p.cmd);};
   command('/new pending "Unit" as UNIT');command('/note UNIT "one"');command('/note UNIT "two"');
   hub.undo('human','u1');hub.undo('human','u2');expect(hub.doc.units[0].note).toBeUndefined();
   hub.undo('human','r1',true);expect(hub.doc.units[0].note).toBe('one');
   hub.undo('human','r2',true);expect(hub.doc.units[0].note).toBe('two');
   hub.undo('human','u3');hub.undo('human','u4');expect(hub.doc.units[0].note).toBeUndefined();
  }finally{store.close();}
 });
 it('separates browser and token histories, retaining human and named agent',()=>{
  const store=new Store(':memory:');try{
   const hub=new Hub(store),a={id:'a',name:'agent-a'},b={id:'b',name:'agent-b'};
   const command=(text:string,id:string,agent?:typeof a)=>{const p=parse(text,hub.doc);if(!p.ok)throw Error(p.error);return hub.submit('human',agent?'mcp':'web',id,p.cmd,new Date(),agent);};
   command('/new pending "Browser" as WEB','web');command('/new pending "Agent A" as A','a',a);command('/new pending "Agent B" as B','b',b);
   expect(hub.doc.log.at(-1)).toMatchObject({by:'human',via:'mcp:agent-b'});
   hub.undo('human','ua',false,'mcp',a);expect(hub.doc.units.map(u=>u.designation)).toEqual(['WEB','B']);
   expect(()=>hub.undo('human','ua2',false,'mcp',a)).toThrow('Nothing to undo');
   hub.undo('human','uw');expect(hub.doc.units.map(u=>u.designation)).toEqual(['B']);
   expect(new Hub(store).doc).toEqual(hub.doc);
  }finally{store.close();}
 });
 it('rejects reserved ids, client turns and views and sanitizes raw logs',()=>{
  const store=new Store(':memory:');try{
   const hub=new Hub(store);
   for(const verb of ['turn','view'])expect(()=>hub.submit('human','web','id'+verb,{verb,args:{view:'detail'}})).toThrow('privileged');
   expect(()=>hub.submit('human','web','turn:2099-01-01',{verb:'intent',args:{text:'x'}})).toThrow('Reserved');
   hub.submit('human','web','safe',{verb:'intent',args:{text:'hello'},raw:'{"verb":"turn"}'});
   expect(hub.doc.log.at(-1)?.cmd).toBeUndefined();
   expect(()=>hub.submit('human','web','large',{verb:'intent',args:{text:'x'.repeat(2049)}})).toThrow('2048');
  }finally{store.close();}
 });
 it('reuses revoked token names with different identities',()=>{
  const store=new Store(':memory:');try{
   store.upsertUser('human','human@example.invalid','Human');const first=store.createToken('agent','human@example.invalid');
   const id=store.tokenIdentity(first)!.id;store.db.prepare("UPDATE tokens SET revoked_at='now'").run();
   const second=store.createToken('agent','human@example.invalid');expect(store.tokenIdentity(first)).toBeUndefined();expect(store.tokenIdentity(second)?.id).not.toBe(id);
  }finally{store.close();}
 });
 it('bounds snapshots and rejects insecure development binding',()=>{
  const store=new Store(':memory:');try{const hub=new Hub(store);for(let n=0;n<5;n++){hub.seq=n;hub.snapshot();}expect(store.db.prepare('SELECT count(*) AS n FROM snapshots').get()).toMatchObject({n:3});}finally{store.close();}
  expect(()=>config({OPSMAP_DEV_USERS:'a',HOST:'0.0.0.0'})).toThrow('loopback');
  const bucket=new Bucket(1,2);expect(bucket.take()).toBe(true);expect(bucket.take()).toBe(true);expect(bucket.take()).toBe(false);
 });
 it('caps the log deterministically and keeps new ids and authors after pruning',()=>{
  const doc=emptyDoc();doc.log=Array.from({length:2000},(_,i)=>({id:`log${i+1}`,at:'2026-11-09T12:00:00Z',text:'history'}));
  const result=apply(doc,{verb:'intent',args:{text:'one'}},new Date('2026-11-10T12:00:00Z'),'human','mcp:agent');
  if('error'in result)throw Error(result.error);
  expect(result.doc.log).toHaveLength(2000);expect(result.doc.log.at(-1)).toMatchObject({id:'log2001',by:'human',via:'mcp:agent'});
  const next=apply(result.doc,{verb:'intent',args:{text:'two'}},new Date('2026-11-10T12:01:00Z'),'human','web');
  if('error'in next)throw Error(next.error);expect(next.doc.log.at(-1)?.id).toBe('log2002');expect(doc.log[0].id).toBe('log1');
 });

});
