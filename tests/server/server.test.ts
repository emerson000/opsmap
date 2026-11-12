import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startServer } from '../../server/app';
import { config, type Config } from '../../server/config';
import { Store } from '../../server/db';
import { Hub } from '../../server/hub';
import { schedulerTick, zonedDay } from '../../server/scheduler';
import { parse } from '../../src/core/commands/grammar';
import { emptyDoc } from '../../src/core/model/seed';
import { apply } from '../../src/core/commands/apply';
import type { Command } from '../../src/core/model/types';
type Message=Record<string,any>;
class Peer {
  readonly messages:Message[]=[];
  constructor(readonly ws:WebSocket){ws.on('message',raw=>this.messages.push(JSON.parse(raw.toString())));}
  send(value:unknown){this.ws.send(JSON.stringify(value));}
  async next(t:string,predicate:(msg:Message)=>boolean=()=>true):Promise<Message> {
    const until=Date.now()+2500;
    while(Date.now()<until) {
      const index=this.messages.findIndex(m=>m.t===t&&predicate(m));if(index>=0)return this.messages.splice(index,1)[0];
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw new Error(`Timed out waiting for ${t}: ${JSON.stringify(this.messages)}`);
  }
}
describe('shared server',()=>{
  let dir:string,settings:Config,runtime:ReturnType<typeof startServer>,url:string;
  const peers:Peer[]=[];
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'opsmap-server-'));
    const clientDir=join(dir,'client');mkdirSync(clientDir);writeFileSync(join(clientDir,'index.html'),'<!doctype html><title>opsmap fixture</title>');writeFileSync(join(clientDir,'asset.js'),'window.ok=true;');
    settings={port:0,host:'127.0.0.1',publicUrl:'http://localhost',dataDir:dir,clientDir,devUsers:['alice','bob'],adminEmails:['alice@dev.local'],group:'opsmap_users',tz:'America/New_York'};
    runtime=startServer(settings,{schedule:false});
    if(!runtime.server.listening)await once(runtime.server,'listening');
    url=`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}`;
  });
  afterEach(async()=>{for(const p of peers.splice(0))p.ws.terminate();await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const login=async(name:string)=>{
    const response=await fetch(`${url}/auth/dev-login?user=${name}`,{redirect:'manual'});
    expect(response.status).toBe(302);return response.headers.get('set-cookie')!.split(';')[0];
  };
  const connect=async(cookie:string,since=0)=>{
    const ws=new WebSocket(`${url.replace('http','ws')}/ws`,{headers:{Cookie:cookie,Origin:settings.publicUrl}}),peer=new Peer(ws);peers.push(peer);await once(ws,'open');peer.send({t:'hello',since});return {peer,welcome:await peer.next('welcome')};
  };
  const command=(text:string):Command=>{const parsed=parse(text,runtime.hub.doc);if(!parsed.ok)throw new Error(parsed.error);return parsed.cmd;};
  const sendOp=(peer:Peer,text:string,opId=randomUUID())=>{peer.send({t:'op',opId,cmd:command(text)});return opId;};
  it('serializes two concurrent clients, broadcasts, catches up and deduplicates reconnects',async()=>{
    const al=await login('alice'),bo=await login('bob');
    const a=await connect(al),b=await connect(bo);expect(a.welcome.doc.units).toEqual([]);expect(b.welcome.me.name).toBe('Bob');
    a.peer.send({t:'presence',selectedId:'u1'});
    expect((await b.peer.next('presence',m=>m.users.some((u:any)=>u.selectedId==='u1'))).users).toContainEqual({userId:'dev:alice',selectedId:'u1'});
    const x=sendOp(a.peer,'/new pending "First capture" as FIRST'),y=sendOp(b.peer,'/new friend "Second capture" as SECOND');
    const a1=await a.peer.next('op'),a2=await a.peer.next('op'),b1=await b.peer.next('op'),b2=await b.peer.next('op');
    expect([a1.op.seq,a2.op.seq]).toEqual([1,2]);expect([b1.op.seq,b2.op.seq]).toEqual([1,2]);
    expect(runtime.hub.doc.units.map(u=>u.designation)).toEqual(['FIRST','SECOND']);expect(runtime.hub.doc.units.map(u=>u.createdBy)).toEqual(['dev:alice','dev:bob']);
    const reconnected=await connect(al,1);expect(reconnected.welcome.doc).toEqual(runtime.hub.doc);
    reconnected.peer.send({t:'op',opId:x,cmd:runtime.hub.since(0)[0].cmd});
    expect((await reconnected.peer.next('op')).op.seq).toBe(1);expect(runtime.hub.seq).toBe(2);
    const replay=runtime.hub.since(0).reduce((doc,op)=>{const r=apply(doc,op.cmd,new Date(op.at),op.userId,op.via??op.source);if('error'in r)throw new Error(r.error);return r.doc;},emptyDoc('America/New_York'));expect(replay).toEqual(runtime.hub.doc);
  });
  it('replays control-measure moves and phase-line dates from the op journal, and undoes a move',async()=>{
    const a=(await connect(await login('alice'))).peer;
    for(const text of ['/new friend inf "Response" in Household near as RSP','/nai add "WATCH" in Work far','/nai move WATCH to Household mid','/obj add "GOAL" in Household near','/obj move GOAL near RSP','/pl add "LAUNCH" 2026-12-24','/pl date LAUNCH 2027-01-02']){sendOp(a,text);await a.next('op');}
    expect(runtime.hub.doc.measures.find(m=>m.name==='WATCH')?.sectorId).toBe('household');
    const replay=runtime.hub.since(0).reduce((doc,op)=>{const r=apply(doc,op.cmd,new Date(op.at),op.userId,op.via??op.source);if('error'in r)throw new Error(r.error);return r.doc;},emptyDoc('America/New_York'));expect(replay).toEqual(runtime.hub.doc);
    a.send({t:'undo',opId:'undo-date'});await a.next('op');
    expect(runtime.hub.doc.measures.find(m=>m.name==='LAUNCH')?.date?.slice(0,10)).not.toBe('2027-01-02');
    a.send({t:'undo',opId:'undo-pl-add'});await a.next('op');
    a.send({t:'undo',opId:'undo-goal-move'});await a.next('op');
    const added=runtime.hub.since(0).slice(0,4).reduce((doc,op)=>{const r=apply(doc,op.cmd,new Date(op.at),op.userId,op.via??op.source);if('error'in r)throw new Error(r.error);return r.doc;},emptyDoc('America/New_York'));
    expect(runtime.hub.doc.measures.find(m=>m.name==='GOAL')).toEqual(added.measures.find(m=>m.name==='GOAL'));
    expect(runtime.hub.doc.measures.find(m=>m.name==='LAUNCH')).toBeUndefined();
  });
  it('refuses undo when another user changed the same entity, and preserves unrelated changes',async()=>{
    const a=(await connect(await login('alice'))).peer,b=(await connect(await login('bob'))).peer;
    sendOp(a,'/new pending "Shared item" as SHARED');await a.next('op');await b.next('op');
    sendOp(b,'/note SHARED "Bob edited this"');await a.next('op');await b.next('op');
    a.send({t:'undo',opId:'conflict'});expect((await a.next('reject')).error).toBe('Changed since by Bob');expect(runtime.hub.seq).toBe(2);
    b.send({t:'undo',opId:'undo-note'});expect((await b.next('op')).op.cmd.verb).toBe('revert');await a.next('op');expect(runtime.hub.doc.units[0].note).toBeUndefined();
    b.send({t:'redo',opId:'redo-note'});await b.next('op');await a.next('op');expect(runtime.hub.doc.units[0].note).toBe('Bob edited this');
    b.send({t:'undo',opId:'undo-note-again'});await b.next('op');expect(runtime.hub.doc.units[0].note).toBeUndefined();
    // A user's newer operation on a separate entity remains independently undoable.
    sendOp(a,'/new pending "Separate" as OTHER');await a.next('op',m=>m.op.opId!=='undo-note-again');
    b.send({t:'redo',opId:'redo-unrelated'});await b.next('op',m=>m.op.opId==='redo-unrelated');expect(runtime.hub.doc.units).toHaveLength(2);
  });
  it('enforces HTTP authentication, admin imports, origins and privileged command rejection',async()=>{
    expect((await fetch(`${url}/api/me`)).status).toBe(401);expect((await fetch(`${url}/api/export`)).status).toBe(401);
    const al=await login('alice'),bo=await login('bob');
    expect(await (await fetch(`${url}/api/me`,{headers:{cookie:al}})).json()).toMatchObject({name:'Alice',isAdmin:true});
    const post=(cookie:string,origin=settings.publicUrl)=>fetch(`${url}/api/import`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(emptyDoc('America/New_York'))});
    expect((await post(bo)).status).toBe(403);expect((await post(al,'https://elsewhere.invalid')).status).toBe(403);expect((await post(al)).status).toBe(200);
    const peer=(await connect(al)).peer;
    for(const verb of ['import','revert']) {peer.send({t:'op',opId:verb,cmd:{verb,args:{doc:emptyDoc()}}});expect((await peer.next('reject')).error).toMatch(/privileged/);}
    peer.send({t:'op',opId:'invalid',cmd:{verb:'new',args:{title:'Bad',affiliation:'hostile',sectorId:'missing'}}});await peer.next('reject');expect(runtime.hub.seq).toBe(1);
    await fetch(`${url}/auth/logout`,{method:'POST',headers:{cookie:al,origin:settings.publicUrl},redirect:'manual'});expect((await fetch(`${url}/api/me`,{headers:{cookie:al}})).status).toBe(401);
    peer.send({t:'ping'});const closed=await once(peer.ws,'close');expect(closed[0]).toBe(1008);
  });
  it('rejects socket upgrades with absent cookies or cross-site origins',async()=>{
    const cookie=await login('alice');
    for(const headers of [{Origin:settings.publicUrl},{Origin:'https://evil.invalid',Cookie:cookie}]) {
      const ws=new WebSocket(`${url.replace('http','ws')}/ws`,{headers});ws.on('error',()=>{});
      const [,response]=await once(ws,'unexpected-response');expect(response.statusCode).toBe(headers.Cookie?403:401);response.resume();ws.terminate();
    }
  });
  it('serves client assets with an SPA fallback and keeps unknown APIs out of it',async()=>{
    expect(await (await fetch(`${url}/asset.js`)).text()).toBe('window.ok=true;');
    expect(await (await fetch(`${url}/some/deep/link`,{headers:{accept:'text/html'}})).text()).toContain('opsmap fixture');
    expect((await fetch(`${url}/api/missing`,{headers:{accept:'text/html'}})).status).toBe(404);
  });
  it('authenticates stateless MCP, runs all tools as the token user and supports revocation',async()=>{
    await login('alice');const token=runtime.store.createToken('integration','alice@dev.local');
    const rpc=async(method:string,params:unknown={},bearer=token)=>{
      const response=await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      return {status:response.status,body:await response.json() as any};
    };
    expect((await rpc('tools/list',{},'invalid')).status).toBe(401);
    expect((await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}})).body.result.serverInfo.name).toBe('opsmap');
    const tools=await rpc('tools/list');expect(tools.body.result.tools.map((t:any)=>t.name)).toEqual(['opsmap_maps','opsmap_command','opsmap_query','opsmap_sitrep','opsmap_help','opsmap_map_create','opsmap_map_rename','opsmap_map_delete','opsmap_import','opsmap_tokens','opsmap_token_revoke']);
    const call=async(name:string,args:unknown={})=>JSON.parse((await rpc('tools/call',{name,arguments:args})).body.result.content[0].text);
    expect(await call('opsmap_command',{text:'/new pending "MCP capture" as MCP'})).toMatchObject({ok:true});
    expect(runtime.hub.since(0)[0]).toMatchObject({source:'mcp',userId:'dev:alice'});
    expect(await call('opsmap_query',{text:'capture'})).toMatchObject([{designation:'MCP'}]);
    expect(await call('opsmap_sitrep')).toContain('SITREP');expect(await call('opsmap_help',{verb:'new'})).toMatchObject({verb:'new'});
    expect(await call('opsmap_command',{text:'/note MISSING "bad"'})).toMatchObject({ok:false});
    runtime.store.db.prepare('UPDATE tokens SET revoked_at=?').run(new Date().toISOString());expect((await rpc('tools/list')).status).toBe(401);
  });
  it('recovers from snapshots and replays later ops including undo',()=>{
    const user=runtime.store.upsertUser('al','al@example.invalid','Alice');
    runtime.hub.submit(user.id,'web','create',command('/new pending "One" as ONE'));runtime.hub.snapshot();
    runtime.hub.submit(user.id,'web','note',command('/note ONE "persisted"'));runtime.hub.undo(user.id,'undo');
    const recovered=new Hub(runtime.store,'main','America/New_York');expect(recovered.seq).toBe(3);expect(recovered.doc).toEqual(runtime.hub.doc);
    recovered.undo(user.id,'redo',true);expect(recovered.doc.units[0].note).toBe('persisted');
  });
  it('runs one morning turn in the configured zone and daily backup, retaining 14 copies',()=>{
    const early=new Date('2026-11-09T08:59:00Z'),morning=new Date('2026-11-09T09:00:00Z');
    expect(zonedDay(early,'America/New_York')).toEqual({day:'2026-11-09',hour:3});
    schedulerTick(runtime.maps,dir,early);expect(runtime.hub.seq).toBe(0);
    schedulerTick(runtime.maps,dir,morning);schedulerTick(runtime.maps,dir,morning);expect(runtime.hub.seq).toBe(1);expect(runtime.store.lastTurn('main')).toBe('2026-11-09');
    const backup=join(dir,'backups','opsmap-2026-11-09.db'),db=new DatabaseSync(backup,{readOnly:true});expect(db.prepare('SELECT count(*) AS n FROM ops').get()).toMatchObject({n:1});db.close();
    for(let day=10;day<=25;day++)schedulerTick(runtime.maps,dir,new Date(`2026-11-${day}T09:00:00Z`));
    expect(readdirSync(join(dir,'backups'))).toHaveLength(14);
  });
});
it('forbids production dev logins and requires secure production configuration',()=>{
  expect(()=>config({NODE_ENV:'production',OPSMAP_DEV_USERS:'alice'})).toThrow(/forbidden/);
  expect(()=>config({})).toThrow(/OIDC/);
  expect(()=>config({PUBLIC_URL:'http://example.invalid',OIDC_ISSUER:'https://example.invalid',OIDC_CLIENT_ID:'x',OIDC_CLIENT_SECRET:'fixture-value'})).toThrow(/HTTPS/);
});
