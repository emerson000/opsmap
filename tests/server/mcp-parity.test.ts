// Parity between the MCP server and the command bar. The guard fails when a verb is added without syntax, autocomplete
// or MCP handling; the drive runs the same texts through the real command bar path (parse with the selection, client
// dispatch, sync engine, hub) and through opsmap_command, and compares logs, errors and the resulting documents.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Doc } from '../../src/core/model/types';
const state=vi.hoisted(()=>({doc:null as Doc|null,selection:{selectedId:null as string|null,hoveredId:null as string|null,sel:null as unknown,section:null as string|null}}));
vi.mock('../../src/lib/model/store.svelte',()=>({getDoc:()=>state.doc!,setDoc:(d:Doc)=>{state.doc=d;},selection:state.selection}));
import { dispatchText, useRemote, type DispatchResult } from '../../src/lib/commands/dispatch';
import { SyncEngine, type SocketLike } from '../../src/lib/sync/engine';
import { aliases, parse, SYNTAX, VERBS } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { resolveUnit } from '../../src/core/commands/resolve';
import { tokenize } from '../../src/core/commands/tokenize';
import { emptyDoc } from '../../src/core/model/seed';
import { Store, type User } from '../../server/db';
import { Maps } from '../../server/maps';
import { MUTATION_VERBS, type Hub } from '../../server/hub';
import { CLIENT_ONLY, mcpRequest } from '../../server/mcp';

const TZ='America/New_York';
type Answer={ok:true;log:string;[k:string]:unknown}|{ok:false;error:string;[k:string]:unknown};

describe('verb coverage guard',()=>{
  const doc=emptyDoc(TZ);
  it.each([...VERBS])('/%s has syntax, autocomplete and MCP handling',verb=>{
    expect(Object.hasOwn(SYNTAX,verb),'SYNTAX entry').toBe(true);
    expect(suggest('/',1,doc,{vikunja:true}).items.map(s=>s.insert),'offered after /').toContain(verb);
    expect(suggest(`/${verb.slice(0,2)}`,3,doc,{vikunja:true}).items.map(s=>s.insert),'offered by prefix').toContain(verb);
    if(SYNTAX[verb])expect(suggest(`/${verb} `,verb.length+2,doc,{vikunja:true}).ghost,'syntax ghost').toBe(SYNTAX[verb]);
    // Exactly one of: an op the hub accepts from users, or a verb the MCP server answers itself (documented).
    expect(MUTATION_VERBS.has(verb)!==Object.hasOwn(CLIENT_ONLY,verb),'op or CLIENT_ONLY, not both').toBe(true);
    if(Object.hasOwn(CLIENT_ONLY,verb))expect(CLIENT_ONLY[verb].length).toBeGreaterThan(10);
  });
  it('lists nothing that is not a verb',()=>{
    for(const verb of [...MUTATION_VERBS,...Object.keys(CLIENT_ONLY)])expect(VERBS as readonly string[]).toContain(verb);
    for(const target of Object.values(aliases))expect(VERBS as readonly string[]).toContain(target);
  });
});

/** The browser's socket, wired to a real hub as server/app.ts does it. */
class HubSocket implements SocketLike {
  readyState=0;onopen:SocketLike['onopen']=null;onmessage:SocketLike['onmessage']=null;onclose:SocketLike['onclose']=null;onerror:SocketLike['onerror']=null;
  private readonly off:()=>void;
  constructor(readonly hub:Hub,readonly maps:Maps,readonly user:User) {
    const listener=(op:unknown)=>this.deliver({t:'op',op});hub.listeners.add(listener);this.off=()=>hub.listeners.delete(listener);
    queueMicrotask(()=>{this.readyState=1;this.onopen?.({});});
  }
  deliver(msg:unknown){queueMicrotask(()=>{if(this.readyState===1)this.onmessage?.({data:JSON.stringify(msg)});});}
  send(raw:string) {
    const msg=JSON.parse(raw);
    try {
      if(msg.t==='hello')this.deliver({t:'welcome',me:{...this.user,admin:true},users:[this.user],seq:this.hub.seq,map:this.hub.mapId,maps:this.maps.list(),vikunja:null,doc:this.hub.doc});
      else if(msg.t==='op')this.hub.submit(this.user.id,'web',msg.opId,msg.cmd);
      else if(msg.t==='undo'||msg.t==='redo')this.hub.undo(this.user.id,msg.opId,msg.t==='redo');
      else if(msg.t==='ping')this.deliver({t:'pong'});
    }catch(error){this.deliver({t:'reject',opId:msg.opId??'',error:(error as Error).message});}
  }
  close(){this.readyState=3;this.off();}
}

describe('opsmap_command matches the command bar',()=>{
  let dir:string,store:Store,maps:Maps,user:User,bar:Hub,field:Hub,engine:SyncEngine,rejected:string[],opened:string[];
  beforeEach(async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-10T15:00:00Z'));
    dir=mkdtempSync(join(tmpdir(),'opsmap-parity-'));store=new Store(join(dir,'opsmap.db'));maps=new Maps(store,TZ);
    user=store.upsertUser('dev:alice','alice@dev.local','Alice',true);
    bar=maps.get(maps.create(user.id,'Bar').id)!;field=maps.get(maps.create(user.id,'Field').id)!;
    rejected=[];opened=[];state.selection.selectedId=null;
    engine=new SyncEngine({connect:()=>new HubSocket(bar,maps,user),uuid:randomUUID,map:bar.mapId,onChange:()=>{state.doc=engine.doc;},onReject:error=>rejected.push(error)});
    // The remote as src/lib/sync/sync.svelte.ts installs it.
    useRemote({submit:cmd=>engine.submit(cmd),request:kind=>{engine.request(kind);return {ok:true,log:`${kind.toUpperCase()} SENT`};},setView:()=>{},maps:()=>maps.list(),openMap:id=>{opened.push(id);return true;}});
    state.doc=engine.doc;engine.start();await settle();expect(engine.status).toBe('live');
  });
  afterEach(()=>{engine.stop();useRemote(null);vi.useRealTimers();store.close();rmSync(dir,{recursive:true,force:true});});
  const settle=async()=>{for(let i=0;i<100&&(engine.pendingCount||engine.status!=='live');i++)await new Promise(r=>setTimeout(r,2));await new Promise(r=>setTimeout(r,2));};
  const call=async(name:string,args:Record<string,unknown>,admin=false):Promise<any>=>{
    const response=await mcpRequest(new Request('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),maps,user,undefined,undefined,admin);
    return JSON.parse(((await response.json()) as any).result.content[0].text);
  };
  /** The command bar: select the unit (as a click does), type the text, Enter. Server rejections count as errors. */
  const viaBar=async(text:string,selected?:string):Promise<DispatchResult>=>{
    state.selection.selectedId=selected?resolveUnit(selected,engine.doc).id:null;rejected=[];
    const res=dispatchText(text);await settle();
    return res.ok&&rejected.length?{ok:false,error:rejected[0]}:res;
  };
  const viaMcp=(text:string,selected?:string,admin=true):Promise<Answer>=>call('opsmap_command',{text,map:'field',...(selected?{selected}:{})},admin);
  /** The document without who sent what (the bar's log entries say web, MCP's say mcp). */
  const plain=(doc:Doc)=>({...doc,log:doc.log.map(({via:_via,...entry})=>entry)});
  // Every verb at least once, in an order that keeps each command valid. [text, selected unit?]
  const STEPS:[string,string?][]=[
    ['/new friend inf "Response team" in Household near as RSP'],['/new hostile "Leaky sink" in Household near as SINK'],['/new hostile "Sink in garage" in Work near as GSINK'],
    ['/new pending "Paperwork" as PAPER','GSINK'],['/new "Groceries"','RSP'],
    ['/bda sin 50%'],['/bda sin 50%','RSP'],['/bda sin 40%','GSINK'],
    ['/id PAPER friend'],['/size RSP plt'],['/fn PAPER recon'],['/rename PAPER "Tax papers" as TAX'],['/move TAX to Household mid'],
    ['/attack RSP SINK main'],['/moving RSP to nearest hostile'],['/obj add "GOAL" in Household near'],['/pl add "LAUNCH" 2026-12-24'],['/axis RSP to OBJ GOAL via PL LAUNCH'],['/obj rename GOAL "FINAL GOAL"'],['/pl rename LAUNCH "LIFTOFF"'],['/pl rename LIFTOFF "LIFTOFF"'],['/ea rename GOAL "X"'],
    ['/advancing SINK on sector hq'],['/advancing SINK on Household hq'],['/moving RSP to sector hq'],
    ['/block TAX by "Waiting"'],['/unblock TAX'],['/due TAX 2026-11-20'],['/move TAX near'],['/unpin TAX'],['/note TAX "Call the office"'],['/rate TAX B2'],['/key TAX'],['/cp RSP main'],
    ['/support TAX RSP'],['/attach TAX to RSP'],['/collapse RSP'],['/collapse RSP'],['/collapse TAX'],['/expand all'],['/collapse all'],['/expand RSP'],['/expand RSP'],['/detach TAX'],['/support TAX RSP'],['/halt TAX support'],['/reinforce RSP with TAX'],['/reinforce RSP TAX'],['/reduce RSP "Less scope"'],['/detach TAX'],['/attach TAX to RSP'],['/link TAX RSP as handoff'],
    ['/sector add Learning'],['/ea add "BATCH" in Work mid'],['/ea join BATCH GSINK'],['/nai add "WATCH" in Work far'],['/intent "Finish the taxes"'],['/sidc TAX 13031000141211000000'],
    ['/drop GSINK bypassed'],['/reopen GSINK'],['/done SINK'],['/note MISSING "x"'],['/attack TAX GSINK'],
    ['/find RSP'],['/find OBJ "FINAL GOAL"'],['/find pl liftoff'],['/find sector Work'],['/find obj NOWHERE'],['/sitrep'],['/sitrep copy'],['/export'],['/help'],['/help mv'],['/help nonsense'],['/map'],['/map field'],['/map nowhere'],
    ['/turn'],['/vk status'],['/view staff'],['/import'],['/undo'],['/redo'],['/undo'],
  ];
  /** Where the two differ by design (see CLIENT_ONLY in server/mcp.ts); everything else must be identical. */
  const DIFFERENT:Record<string,(bar:DispatchResult,mcp:Answer)=>void>={
    view:(b,m)=>{expect(b).toMatchObject({ok:true,log:'VIEW STAFF'});expect(m).toMatchObject({ok:false,error:'/view changes only the browser display: it has no effect over MCP'});},
    import:(b,m)=>{expect(b).toMatchObject({ok:true,log:'IMPORT'});expect(m).toMatchObject({ok:false,error:'Use opsmap_import with the document'});},
    undo:(b,m)=>{expect(b).toMatchObject({ok:true,log:'UNDO SENT'});expect(m).toMatchObject({ok:true,log:expect.stringMatching(/^REVERT OP \d+$/)});},
    redo:(b,m)=>{expect(b).toMatchObject({ok:true,log:'REDO SENT'});expect(m).toMatchObject({ok:true,log:expect.stringMatching(/^REVERT OP \d+$/)});},
  };
  it('gives the same log, error and document for every verb',async()=>{
    const seen=new Set<string>();
    for(const [text,selected] of STEPS) {
      const typed=tokenize(text)[0].value.slice(1).toLowerCase(),verb=aliases[typed]??typed;seen.add(verb);
      const b=await viaBar(text,selected),m=await viaMcp(text,selected);
      const label=`${text}${selected?` (selected ${selected})`:''}`;
      if(DIFFERENT[verb])DIFFERENT[verb](b,m);
      else if(b.ok)expect(m,label).toMatchObject({ok:true,log:b.log});
      else expect(m,label).toMatchObject({ok:false,error:b.error,...(b.at!==undefined?{at:b.at}:{})});
      expect(plain(field.doc),label).toEqual(plain(bar.doc));
    }
    expect([...seen].sort()).toEqual([...VERBS].sort());
    expect(opened).toEqual([field.mapId]);
  });
  it('answers the shell verbs with their content',async()=>{
    await viaMcp('/new friend "Response team" as RSP');
    expect(await viaMcp('/find RSP')).toMatchObject({ok:true,log:'LOCATE RSP',unit:{designation:'RSP',title:'Response team',affiliation:'friend'}});
    await viaMcp('/obj add "GOAL" in Household near');
    expect(await viaMcp('/find obj goal')).toMatchObject({ok:true,log:'LOCATE OBJ GOAL',measure:{type:'obj',name:'GOAL',sector:'household',ring:'near'}});
    expect(await viaMcp('/find sector household')).toMatchObject({ok:true,log:'LOCATE SECTOR HOUSEHOLD',sector:{name:'Household',width:72,units:['RSP']}});
    expect(await viaMcp('/sitrep copy')).toMatchObject({ok:true,log:'SITREP',text:expect.stringContaining('SITREP')});
    expect(await viaMcp('/export')).toMatchObject({ok:true,log:'EXPORT',doc:{units:[{designation:'RSP'}]}});
    expect(await viaMcp('/help atk')).toMatchObject({ok:true,log:`/attack ${SYNTAX.attack}`,syntax:SYNTAX.attack});
    expect((await viaMcp('/help')).syntax).toEqual(SYNTAX);
    expect(await viaMcp('/map')).toMatchObject({ok:true,log:'MAPS: Main, Bar, Field',maps:[{name:'Main',default:true},{name:'Bar'},{name:'Field'}]});
    expect(await viaMcp('/map BAR')).toMatchObject({ok:true,log:'MAP BAR',map:{id:bar.mapId,name:'Bar',units:0}});
    expect(await viaMcp('/import',undefined,false)).toMatchObject({ok:false,error:'Only the administrator can import a map'});
    expect(await call('opsmap_help',{verb:'/mv'})).toEqual({verb:'move',syntax:SYNTAX.move,help:`/move ${SYNTAX.move}`});
    expect(await call('opsmap_help',{verb:'bogus'})).toEqual({verb:'bogus',syntax:'Unknown verb'});
    expect(await viaMcp('/new "x"','NOBODY')).toMatchObject({ok:false,error:expect.stringMatching(/^Selected unit: No match for/)});
  });
  it('manages maps with the HTTP rules: anyone creates, duplicates and renames; only an administrator deletes or imports',async()=>{
    await viaMcp('/new friend "Response team" as RSP');
    const empty=await call('opsmap_map_create',{name:'  Garden   plot '});expect(empty).toMatchObject({ok:true,map:{name:'Garden plot',default:false,units:0}});
    expect(maps.get(empty.map.id)!.doc.sectors.map(s=>s.name)).toEqual(['Work','Household','Family','Wellness','Productivity']);
    expect(await call('opsmap_map_create',{name:'garden plot'})).toMatchObject({ok:false,error:'A map named garden plot already exists'});
    expect(await call('opsmap_map_create',{})).toMatchObject({ok:false,error:'Map name required'});
    const copy=await call('opsmap_map_create',{from:'Field'});expect(copy).toMatchObject({ok:true,map:{name:'Field copy',units:1}});
    expect((await call('opsmap_map_create',{from:'Field'})).map.name).toBe('Field copy 2');
    expect(maps.get(copy.map.id)!.doc.units).toEqual(field.doc.units);
    expect(maps.get(copy.map.id)!.since(0)).toMatchObject([{source:'mcp',cmd:{verb:'import'}}]);
    const fromDoc=await call('opsmap_map_create',{name:'Restored',doc:field.doc});expect(fromDoc).toMatchObject({ok:true,map:{name:'Restored',units:1}});
    expect(await call('opsmap_map_create',{name:'Bad',doc:{units:'no'}})).toMatchObject({ok:false});
    expect(await call('opsmap_map_create',{name:'Both',from:'Field',doc:field.doc})).toMatchObject({ok:false,error:'Pass from or doc, not both'});
    expect(await call('opsmap_map_rename',{map:'restored',name:'Archive'})).toMatchObject({ok:true,map:{id:fromDoc.map.id,name:'Archive'}});
    expect(await call('opsmap_map_rename',{map:'Archive',name:'Field'})).toMatchObject({ok:false,error:'A map named Field already exists'});
    expect(await call('opsmap_map_delete',{map:'Archive'})).toMatchObject({ok:false,error:'Administrator required'});
    expect(await call('opsmap_map_delete',{map:'Archive'},true)).toEqual({ok:true,deleted:{id:fromDoc.map.id,name:'Archive'}});
    expect(maps.get(fromDoc.map.id)).toBeUndefined();
    expect(await call('opsmap_import',{map:'Bar',doc:field.doc})).toMatchObject({ok:false,error:'Only the administrator can import a map'});
    expect(await call('opsmap_import',{map:'Bar',doc:field.doc},true)).toEqual({ok:true,log:'DOCUMENT IMPORTED'});
    expect(bar.doc.units.map(u=>u.designation)).toEqual(['RSP']);
    expect(await call('opsmap_command',{text:'/undo',map:'Bar'})).toMatchObject({ok:true});expect(bar.doc.units).toEqual([]);
    for(const m of maps.list().slice(1))await call('opsmap_map_delete',{map:m.id},true);
    expect(await call('opsmap_map_delete',{map:'Main'},true)).toMatchObject({ok:false,error:'The last map cannot be deleted'});
  });
});

it('parses /help and /map in the shared grammar',()=>{
  const doc=emptyDoc(TZ);
  expect(parse('/help ATK',doc)).toMatchObject({ok:true,cmd:{verb:'help',args:{verb:'attack'}},preview:`/attack ${SYNTAX.attack}`});
  expect(parse('/help /turn',doc)).toMatchObject({ok:true,preview:'/turn'});
  expect(parse('/help nope',doc)).toMatchObject({ok:false,error:'Unknown command: nope',at:6});
  expect(parse('/map "Garden plot"',doc)).toMatchObject({ok:true,cmd:{verb:'map',args:{name:'Garden plot'}},preview:'MAP GARDEN PLOT'});
  expect(parse('/map a b',doc)).toMatchObject({ok:false,error:'Unexpected token: b'});
  expect(suggest('/map ',5,doc,{maps:['Main','Garden plot']}).items.map(s=>s.insert)).toEqual(['Main','"Garden plot"']);
  expect(suggest('/help at',8,doc).items.map(s=>s.insert)).toContain('attack');
});
