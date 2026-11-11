import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startServer } from '../../server/app';
import type { Config } from '../../server/config';
import { Store } from '../../server/db';
import { Maps } from '../../server/maps';
import { schedulerTick } from '../../server/scheduler';
import { parse } from '../../src/core/commands/grammar';
import { emptyDoc, seedDoc } from '../../src/core/model/seed';
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

describe('multiple maps',()=>{
  let dir:string,settings:Config,runtime:ReturnType<typeof startServer>,url:string;
  const peers:Peer[]=[];
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'opsmap-maps-'));
    const clientDir=join(dir,'client');mkdirSync(clientDir);writeFileSync(join(clientDir,'index.html'),'<!doctype html>');
    settings={port:0,host:'127.0.0.1',publicUrl:'http://localhost',dataDir:dir,clientDir,devUsers:['alice','bob'],adminEmails:['alice@dev.local'],group:'opsmap_users',tz:'Europe/London'};
    runtime=startServer(settings,{schedule:false});
    if(!runtime.server.listening)await once(runtime.server,'listening');
    url=`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}`;
  });
  afterEach(async()=>{for(const p of peers.splice(0))p.ws.terminate();await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const login=async(name:string)=>(await fetch(`${url}/auth/dev-login?user=${name}`,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const connect=async(cookie:string,map?:string)=>{
    const ws=new WebSocket(`${url.replace('http','ws')}/ws`,{headers:{Cookie:cookie,Origin:settings.publicUrl}}),peer=new Peer(ws);peers.push(peer);await once(ws,'open');peer.send({t:'hello',since:0,map});return {peer,welcome:await peer.next('welcome')};
  };
  const api=async(method:string,path:string,cookie:string,body?:unknown,origin=settings.publicUrl)=>{
    const response=await fetch(`${url}${path}`,{method,headers:{cookie,origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  };
  const op=(peer:Peer,doc:any,text:string)=>{const p=parse(text,doc);if(!p.ok)throw new Error(p.error);const opId=randomUUID();peer.send({t:'op',opId,cmd:p.cmd});return opId;};

  it('creates, lists, renames and deletes maps over HTTP with origin and admin checks',async()=>{
    const al=await login('alice'),bo=await login('bob');
    expect((await api('GET','/api/maps',al)).body.maps).toMatchObject([{id:'main',name:'Main'}]);
    expect((await api('POST','/api/maps',bo,{name:'Garden'},'https://evil.invalid')).status).toBe(403);
    const created=await api('POST','/api/maps',bo,{name:'  Garden   project '});
    expect(created.status).toBe(200);expect(created.body.map).toMatchObject({name:'Garden project',createdBy:'dev:bob'});
    const id=created.body.map.id;
    expect((await api('POST','/api/maps',al,{name:'garden PROJECT'})).body.error).toMatch(/already exists/);
    expect((await api('POST','/api/maps',al,{name:''})).status).toBe(400);
    expect((await api('POST','/api/maps',al,{name:'x'.repeat(61)})).body.error).toMatch(/60/);
    expect((await api('PATCH',`/api/maps/${id}`,bo,{name:'Garden'})).body.map.name).toBe('Garden');
    expect((await api('PATCH','/api/maps/nope',bo,{name:'Other'})).status).toBe(400);
    expect((await api('GET','/api/maps',bo)).body.maps.map((m:any)=>m.name)).toEqual(['Main','Garden']);
    // A new map starts with the five standard sectors.
    expect((await (await fetch(`${url}/api/export?map=${id}`,{headers:{cookie:bo}})).json() as any).sectors).toHaveLength(5);
    expect((await fetch(`${url}/api/export?map=missing`,{headers:{cookie:bo}})).status).toBe(404);
    expect((await api('DELETE',`/api/maps/${id}`,bo)).status).toBe(403);
    expect((await api('DELETE',`/api/maps/${id}`,al)).status).toBe(200);
    expect((await api('DELETE','/api/maps/main',al)).body.error).toMatch(/last map/);
    expect(runtime.store.db.prepare('SELECT count(*) AS n FROM maps').get()).toMatchObject({n:1});
  });

  it('creates a map from an imported document and imports into a named map',async()=>{
    const al=await login('alice');
    const seeded=await api('POST','/api/maps',al,{name:'Demo',doc:seedDoc(new Date())});
    expect(seeded.status).toBe(200);
    expect(runtime.maps.get(seeded.body.map.id)!.doc.units).toHaveLength(20);
    expect((await api('POST','/api/maps',al,{name:'Broken',doc:{version:1}})).status).toBe(400);
    expect(runtime.store.maps().map(m=>m.name)).toEqual(['Main','Demo']);
    const imported=await fetch(`${url}/api/import?map=Demo`,{method:'POST',headers:{cookie:al,origin:settings.publicUrl,'content-type':'application/json'},body:JSON.stringify(emptyDoc())});
    expect(imported.status).toBe(200);expect(runtime.maps.get(seeded.body.map.id)!.doc.units).toHaveLength(0);
    expect(runtime.maps.default.doc.units).toHaveLength(0);expect(runtime.maps.default.seq).toBe(0);
  });

  it('keeps ops, sequence numbers, presence and undo separate per map',async()=>{
    const al=await login('alice'),bo=await login('bob');
    const garden=runtime.maps.create('dev:alice','Garden');
    const a=await connect(al),b=await connect(bo,garden.id);
    expect(a.welcome).toMatchObject({map:'main'});expect(b.welcome).toMatchObject({map:garden.id,seq:0});
    expect(b.welcome.maps.map((m:any)=>m.name)).toEqual(['Main','Garden']);
    op(a.peer,runtime.maps.default.doc,'/new pending "Main item" as MAINITEM');
    expect((await a.peer.next('op')).op.seq).toBe(1);
    op(b.peer,runtime.maps.get(garden.id)!.doc,'/new pending "Garden item" as GARDENITEM');
    expect((await b.peer.next('op')).op.seq).toBe(1);
    await new Promise(r=>setTimeout(r,50));
    expect(a.peer.messages.filter(m=>m.t==='op')).toEqual([]);expect(b.peer.messages.filter(m=>m.t==='op')).toEqual([]);
    expect(runtime.maps.default.doc.units.map(u=>u.designation)).toEqual(['MAINITEM']);
    expect(runtime.maps.get(garden.id)!.doc.units.map(u=>u.designation)).toEqual(['GARDENITEM']);
    // Presence lists only the users on the same map.
    a.peer.send({t:'presence',selectedId:'mainitem'});
    expect((await a.peer.next('presence',m=>m.users.some((u:any)=>u.selectedId==='mainitem'))).users).toEqual([{userId:'dev:alice',selectedId:'mainitem'}]);
    // Undo history is per map: Alice has nothing to undo on Garden.
    const c=await connect(al,garden.id);c.peer.send({t:'undo',opId:'garden-undo'});expect((await c.peer.next('reject')).error).toBe('Nothing to undo');
    // An op id cannot be reused on another map.
    const first=runtime.maps.default.since(0)[0];
    c.peer.send({t:'op',opId:first.opId,cmd:first.cmd});expect((await c.peer.next('reject')).error).toMatch(/another map/);
    // Restarting replays every map from its own journal.
    const reloaded=new Maps(runtime.store,'Europe/London');
    expect(reloaded.get(garden.id)!.doc).toEqual(runtime.maps.get(garden.id)!.doc);expect(reloaded.default.doc).toEqual(runtime.maps.default.doc);
  });

  it('broadcasts map list changes and moves clients off a deleted map',async()=>{
    const al=await login('alice'),bo=await login('bob');
    const a=await connect(al),created=await api('POST','/api/maps',al,{name:'Trip'});
    expect((await a.peer.next('maps')).maps.map((m:any)=>m.name)).toEqual(['Main','Trip']);
    const b=await connect(bo,created.body.map.id);
    await api('PATCH',`/api/maps/${created.body.map.id}`,al,{name:'Trip 2027'});
    expect((await b.peer.next('maps')).maps[1].name).toBe('Trip 2027');
    await api('DELETE',`/api/maps/${created.body.map.id}`,al);
    expect((await a.peer.next('maps',m=>m.maps.length===1)).maps).toHaveLength(1);
    const [code]=await once(b.peer.ws,'close');expect(code).toBe(4004);
    // A hello for an unknown map is served the default map and says so; a name resolves to its map.
    expect((await connect(bo,created.body.map.id)).welcome).toMatchObject({map:'main',fallback:true});
    const other=runtime.maps.create('dev:alice','Other');
    const byName=(await connect(bo,'other')).welcome;expect(byName.map).toBe(other.id);expect(byName.fallback).toBeUndefined();
  });

  it('runs a daily turn on every map and MCP tools address maps by name',async()=>{
    await login('alice');
    const garden=runtime.maps.create('dev:alice','Garden',undefined,new Date('2026-11-08T15:00:00Z'));
    expect(runtime.store.lastTurn(garden.id)).toBe('2026-11-08');
    // A copy made this morning, after its source took today's turn, waits for tomorrow without retrying every minute.
    schedulerTick(runtime.maps,dir,new Date('2026-11-09T09:00:00Z'));schedulerTick(runtime.maps,dir,new Date('2026-11-09T09:30:00Z'));
    expect(runtime.maps.default.seq).toBe(1);expect(runtime.maps.get(garden.id)!.seq).toBe(1);expect(runtime.store.lastTurn(garden.id)).toBe('2026-11-09');
    const copy=runtime.maps.create('dev:alice','Copy',runtime.maps.default.doc,new Date('2026-11-09T09:10:00Z'));
    runtime.store.setLastTurn(copy.id,'2026-11-08');
    schedulerTick(runtime.maps,dir,new Date('2026-11-09T09:40:00Z'));
    expect(runtime.store.lastTurn(copy.id)).toBe('2026-11-09');expect(runtime.maps.get(copy.id)!.seq).toBe(1);
    runtime.maps.remove(copy.id);
    const token=runtime.store.createToken('maps','alice@dev.local');
    const call=async(name:string,args:unknown={})=>{
      const response=await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      return JSON.parse(((await response.json()) as any).result.content[0].text);
    };
    expect(await call('opsmap_maps')).toEqual([{id:'main',name:'Main',default:true,units:0},{id:garden.id,name:'Garden',default:false,units:0}]);
    expect(await call('opsmap_command',{text:'/new pending "Weed beds" as WEED',map:'garden'})).toMatchObject({ok:true});
    expect(runtime.maps.get(garden.id)!.doc.units.map(u=>u.designation)).toEqual(['WEED']);expect(runtime.maps.default.doc.units).toEqual([]);
    expect(await call('opsmap_query',{map:garden.id})).toMatchObject([{designation:'WEED'}]);
    expect(await call('opsmap_query',{})).toEqual([]);
    expect(await call('opsmap_sitrep',{map:'Garden'})).toContain('SITREP');
    expect(await call('opsmap_command',{text:'/sitrep',map:'Nowhere'})).toMatchObject({ok:false,error:'Unknown map: Nowhere'});
  });
});

it('migrates a single-map database into map "main", keeping ops, snapshots and the last turn',()=>{
  const dir=mkdtempSync(join(tmpdir(),'opsmap-migrate-')),path=join(dir,'opsmap.db');
  try {
    const old=new DatabaseSync(path);
    old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,name TEXT,initials TEXT,color TEXT,created_at TEXT,last_seen TEXT,email_verified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ops(seq INTEGER PRIMARY KEY,op_id TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,source TEXT NOT NULL,at TEXT NOT NULL,cmd TEXT NOT NULL,log TEXT NOT NULL,inverse TEXT NOT NULL,undone_by INTEGER,reverts INTEGER,principal TEXT,via TEXT);
      CREATE TABLE snapshots(seq INTEGER PRIMARY KEY,doc TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at TEXT,expires_at TEXT);
      CREATE TABLE tokens(id TEXT PRIMARY KEY,name TEXT,user_id TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT,last_used TEXT,revoked_at TEXT);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO meta VALUES('schema_version','1'),('token_names_v2','1'),('snapshots_v2_reset','1'),('last_turn','2026-11-08');`);
    const p=parse('/new pending "Old item" as OLD',emptyDoc());if(!p.ok)throw new Error(p.error);
    old.prepare("INSERT INTO ops VALUES(1,'old-1','u','web','2026-11-08T12:00:00.000Z',?,'CAPTURE OLD','{\"units\":[],\"orders\":[],\"measures\":[],\"sectors\":[],\"top\":{}}',NULL,NULL,'user:u','web')").run(JSON.stringify(p.cmd));
    old.close();
    const store=new Store(path),maps=new Maps(store);
    try {
      expect(store.maps()).toMatchObject([{id:'main',name:'Main'}]);expect(store.lastTurn('main')).toBe('2026-11-08');
      expect(maps.default.seq).toBe(1);expect(maps.default.doc.units.map(u=>u.designation)).toEqual(['OLD']);
      maps.default.snapshot();expect(store.db.prepare('SELECT map_id FROM snapshots').all()).toEqual([{map_id:'main'}]);
    }finally{store.close();}
    // A second open does not migrate again.
    const again=new Store(path);try{expect(new Maps(again).default.doc.units).toHaveLength(1);}finally{again.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
