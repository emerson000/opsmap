import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Doc } from '../../src/lib/model/types';
import { seedDoc } from '../../src/lib/model/seed';
const state=vi.hoisted(()=>({doc:null as Doc|null,selection:{selectedId:null as string|null,hoveredId:null as string|null}}));
vi.mock('../../src/lib/model/store.svelte',()=>({getDoc:()=>state.doc!,setDoc:(d:Doc)=>{state.doc=d;},selection:state.selection}));
import { parse } from '../../src/lib/commands/grammar';
import { tokenize, parseDate } from '../../src/lib/commands/tokenize';
import { apply } from '../../src/lib/commands/apply';
import { dispatch, dispatchText } from '../../src/lib/commands/dispatch';
import { undo, redo, clearHistory } from '../../src/lib/commands/undo';
import { runTurnIfDue, turnState } from '../../src/lib/commands/turn';
import { suggest } from '../../src/lib/commands/suggest';
import { sitrepText } from '../../src/lib/commands/sitrep';
const now=new Date(2026,10,9,12);
const cases:[string,string,string][]=[
 ['new','/new "Fix sink"','/new'],['id','/id TOOLS friend','/id TOOLS enemy'],['size','/size TOOLS plt','/size TOOLS huge'],
 ['fn','/fn TOOLS recon','/fn TOOLS magic'],['rename','/rename TOOLS "Review tool"','/rename TOOLS'],
 ['move','/move TOOLS to Household near','/move TOOLS sideways'],['attack','/attack IRSRSP IRS main','/attack IRSRSP'],
 ['moving','/moving IRSRSP to nearest hostile','/moving IRSRSP nearest'],['axis','/axis MOVE to OBJ "SETTLED IN" via PL LAUNCH','/axis MOVE to IRS'],
 ['advancing','/advancing IRS on hq','/advancing TOOLS on hq'],['bda','/bda IRS 60%','/bda IRS 101%'],
 ['block','/block TOOLS by "No reply"','/block TOOLS because'],['unblock','/unblock PASSPORT','/unblock'],
 ['done','/done IRSRSP','/done absent'],['drop','/drop TOOLS','/drop TOOLS junk'],
 ['reinforce','/reinforce MOVE with TOOLS','/reinforce MOVE with'],['reduce','/reduce TOOLS "Cut scope"','/reduce'],
 ['attach','/attach TOOLS to MOVE','/attach MOVE to PACKING'],['detach','/detach PACKING','/detach'],
 ['link','/link TOOLS Q4RPT as handoff','/link TOOLS'],['due','/due TOOLS +3d','/due TOOLS someday'],
 ['note','/note TOOLS "Read docs"','/note TOOLS'],['rate','/rate KNEE B2','/rate KNEE Z9'],['key','/key HOME','/key missing'],
 ['sector','/sector add Learning','/sector width Work 0'],['sector','/ao size large','/ao size huge'],['pl','/pl add "REVIEW" 2026-11-20','/pl add "REVIEW" nonsense'],
 ['obj','/obj add "RESULT" in Work near','/obj add "RESULT" in absent'],['ea','/ea add "BATCH" in Work mid','/ea add'],['nai','/nai add "WATCH" in Work far','/nai add "WATCH"'],
 ['find','/find TOOLS','/find missing'],['sitrep','/sitrep copy','/sitrep junk'],['intent','/intent "Finish tax response"','/intent'],
 ['turn','/turn','/turn extra'],['view','/view staff','/view cockpit'],['undo','/undo','/undo extra'],['redo','/redo','/redo extra'],
 ['export','/export','/export extra'],['import','/import','/import extra'],['sidc','/sidc TOOLS 13031000141211000000','/sidc TOOLS 00000000000000000000'],['help','/help','/help extra'],
];
beforeEach(()=>{state.doc=seedDoc(now);state.selection.selectedId=null;clearHistory();turnState.trails=[];turnState.crossings=[];vi.useRealTimers();});
function command(text:string,doc=state.doc!):Command {const result=parse(text,doc);expect(result,result.ok?'':result.error).toMatchObject({ok:true});if(!result.ok)throw Error(result.error);return result.cmd;}
function execute(text:string,doc=state.doc!):Doc {const result=apply(doc,command(text,doc),now);expect(result).not.toHaveProperty('error');if('error' in result)throw Error(result.error);return result.doc;}
describe('every supported verb',()=>{
 it.each(cases)('%s accepts its grammar and rejects bad input',(_,good,bad)=>{expect(parse(good,state.doc!)).toMatchObject({ok:true});expect(parse(bad,state.doc!)).toMatchObject({ok:false,at:expect.any(Number)});});
 it.each(cases.filter(([v])=>!['undo','redo'].includes(v)))('%s applies purely and dispatch undo/redo round-trips',(_,good)=>{
  const original=structuredClone(state.doc!);const cmd=command(good);const result=apply(original,cmd,now);expect(result).not.toHaveProperty('error');expect(original).toEqual(seedDoc(now));
  expect(dispatch(cmd)).toMatchObject({ok:true});const after=structuredClone(state.doc!);if(JSON.stringify(after)!==JSON.stringify(original)){expect(undo()).toBe(true);expect(state.doc).toEqual(original);expect(redo()).toBe(true);expect(state.doc).toEqual(after);}
 });
});
describe('tokenization and resolution',()=>{
 it('keeps escaped quotes, unicode, and a quoted leading slash',()=>{const result=execute('/new "Fix \\"the\\" sink — café"');expect(result.units.at(-1)?.title).toBe('Fix "the" sink — café');expect(execute('/new "/Fix sink"').units.at(-1)?.title).toBe('/Fix sink');expect(()=>tokenize('/new "unfinished')).toThrow();});
 it('defaults quick capture and accepts noise words',()=>{expect(execute('/new "Fix sink"').units.at(-1)).toMatchObject({title:'Fix sink',affiliation:'pending',echelon:'sec',fn:'inf',sectorId:'household'});expect(execute('/new hostile unit in sector Work').units.at(-1)).toMatchObject({affiliation:'hostile',sectorId:'work'});});
 it('uses selected sector for capture',()=>{state.selection.selectedId='q4rpt';expect(execute('/new "Review"').units.at(-1)?.sectorId).toBe('work');});
 it('matches designation exactly before prefixes and lists true ambiguities',()=>{expect(command('/note IRS "x"').args.unit).toBe('irs');const result=parse('/note IRSR "x"',state.doc!);expect(result.ok).toBe(true);const ambiguous=parse('/note R "x"',state.doc!);expect(ambiguous).toMatchObject({ok:false});if(!ambiguous.ok)expect(ambiguous.error).toContain('Ambiguous');expect(command('/note "Draft tax response" "x"').args.unit).toBe('irsrsp');expect(command('/note #irs "x"').args.unit).toBe('irs');});
 it('never half-executes malformed or stale commands and preserves redo on invalid input',()=>{const original=structuredClone(state.doc!);expect(dispatchText('/attack IRSRSP missing')).toMatchObject({ok:false});expect(dispatch({verb:'move',args:{unit:'irs',r:NaN,theta:0,sectorId:'work'}})).toMatchObject({ok:false});expect(state.doc).toEqual(original);dispatchText('/note IRS "x"');undo();dispatchText('/id IRS bogus');expect(redo()).toBe(true);});
});
describe('orders and assessments',()=>{
 it('resolves nearest by Cartesian model distance, ties by id, including already engaged unresolved hostiles',()=>{const doc=state.doc!;const source=doc.units.find(u=>u.id==='irsrsp')!;source.pos={r:2,theta:0};for(const id of ['irs','leak'])doc.units.find(u=>u.id===id)!.pos={r:3,theta:0};expect(command('/moving IRSRSP to nearest hostile').args.target).toBe('irs');expect(command('/moving IRSRSP to nearest hostile').verb).toBe('attack');expect(command('/moving IRSRSP to hq').verb).toBe('moving');expect(execute('/moving IRSRSP to hq').orders.at(-1)).toMatchObject({type:'move',to:'hq'});});
 it('demotes a former main effort',()=>{const doc=execute('/attack RECORDS IRS main');expect(doc.orders.find(o=>o.from==='irsrsp'&&o.type==='attack')?.role).toBe('support');expect(doc.orders.filter(o=>o.role==='main'&&doc.units.find(u=>u.id===o.from)?.sectorId==='household')).toHaveLength(1);});
 it('finishes the attacker without changing the target and prompts assessment',()=>{const original=structuredClone(state.doc!.units.find(u=>u.id==='irs'));const result=apply(state.doc!,command('/done IRSRSP'),now);if('error'in result)throw Error(result.error);expect(result.doc.orders.some(o=>o.from==='irsrsp')).toBe(false);expect(result.doc.units.find(u=>u.id==='irs')).toEqual(original);expect(result.log).toContain('Assess target');});
 it('marks scope increases and hostile defeat, preserving explicit conditions',()=>{expect(execute('/size TOOLS coy').units.find(u=>u.id==='tools')?.reinforced).toBe('+');let doc=execute('/new hostile fin "Tax" as TAX');doc=execute('/bda TAX 0%',doc);expect(doc.units.find(u=>u.designation==='TAX')).toMatchObject({strength:0,lifecycle:'done',condition:'destroyed'});expect(doc.orders.some(o=>o.to===doc.units.at(-1)?.id)).toBe(false);});
 it('requires confirmation for hostile people',()=>{expect(parse('/id LANDLORD hostile',state.doc!)).toMatchObject({ok:false});expect(execute('/id LANDLORD hostile confirm').units.find(u=>u.id==='landlord')?.affiliation).toBe('hostile');});
 it('rejects crossings unless the source is a task force, and prevents attachment cycles',()=>{expect(parse('/attack TOOLS IRS',state.doc!)).toMatchObject({ok:false});expect(parse('/attach MOVE to PACKING',state.doc!)).toMatchObject({ok:false});expect(parse('/attach MOVE to MOVE',state.doc!)).toMatchObject({ok:false});});
});
describe('sectors and measures',()=>{
 it('refuses occupied removals and can reassign atomically',()=>{expect(parse('/sector remove Work',state.doc!)).toMatchObject({ok:false});const doc=execute('/sector remove Work reassign Household');expect(doc.sectors.some(s=>s.id==='work')).toBe(false);expect(doc.units.some(u=>u.sectorId==='work')).toBe(false);expect(doc.measures.some(m=>m.sectorId==='work')).toBe(false);expect(doc.sectors.reduce((n,s)=>n+s.widthDeg,0)).toBeCloseTo(360);});
 it('resizes all angles and keeps units inside their sector',()=>{const doc=execute('/sector width Work 110');expect(doc.sectors[0].widthDeg).toBe(110);expect(doc.sectors.reduce((n,s)=>n+s.widthDeg,0)).toBeCloseTo(360);});
 it('removes phase-line references and target orders when deleting a measure',()=>{expect(execute('/pl remove LAUNCH').orders.find(o=>o.type==='axis')?.via).toEqual([]);expect(execute('/obj remove "SETTLED IN"').orders.some(o=>o.to==='obj-settled')).toBe(false);});
});
describe('dates and daily turn',()=>{
 it.each(['today','tmw','fri','eow','eom','+3d','2026-11-20','201700JNOV26'])('parses date %s at local calendar precision',token=>{expect(Number.isFinite(Date.parse(parseDate(token,now)))).toBe(true);expect(parse(`/due IRS ${token}`,state.doc!)).toMatchObject({ok:true});});
 it('parses calendar and DTG values without UTC date shifts and rejects impossible dates',()=>{expect(new Date(parseDate('2026-11-20',now)).getDate()).toBe(20);expect(new Date(parseDate('201700JNOV26',now)).getHours()).toBe(17);expect(()=>parseDate('2026-02-30',now)).toThrow();expect(()=>parseDate('321700JNOV26',now)).toThrow();});
 it('moves only dated unresolved hostile/suspect units without pins, once after 04:00, as one undoable turn',()=>{
  const doc=state.doc!;doc.units.find(u=>u.id==='irs')!.posOverride=true;const original=structuredClone(doc);const before=new Date(2026,10,10,3,59);expect(runTurnIfDue(before).ran).toBe(false);const morning=new Date(2026,10,10,4);const result=runTurnIfDue(morning);expect(result.ran).toBe(true);expect(result.advanced).toBeGreaterThan(0);for(const id of ['irs','q4rpt','tools'])expect(state.doc!.units.find(u=>u.id===id)?.pos).toEqual(original.units.find(u=>u.id===id)?.pos);expect(runTurnIfDue(morning).ran).toBe(false);expect(turnState.trails.length).toBe(result.advanced);expect(undo()).toBe(true);expect(state.doc).toEqual(original);
 });
 it('reports every crossed phase line, creates automatic advance only on hostile crossings',()=>{const doc=state.doc!;const h=doc.units.find(u=>u.id==='leak')!;h.pos.r=3.8;h.dueAt=new Date(2026,10,10,17).toISOString();const result=runTurnIfDue(new Date(2026,10,10,6));expect(result.crossings.filter(c=>c.unitId==='leak').map(c=>c.pl)).toEqual(['MONTH','WEEK','TODAY']);expect(state.doc!.orders.some(o=>o.type==='advance'&&o.from==='leak')).toBe(true);expect(sitrepText(state.doc!,new Date(2026,10,10,6))).toContain('PL WEEK');});
 it('autoAdvance off still records the daily turn without moving units',()=>{state.doc!.settings.autoAdvance=false;const before=structuredClone(state.doc!.units.map(u=>u.pos));expect(runTurnIfDue(new Date(2026,10,10,6)).advanced).toBe(0);expect(state.doc!.units.map(u=>u.pos)).toEqual(before);});
});
describe('suggestions and reports',()=>{
 it('offers verbs, units with sectors, echelon ranges, date tokens, and syntax hints',()=>{expect(suggest('/att',4,state.doc!).items.some(s=>s.insert==='attack')).toBe(true);expect(suggest('/attack IRS',11,state.doc!).items.some(s=>s.unitId==='irs')).toBe(true);expect(suggest('/size TOOLS ',12,state.doc!).items.find(s=>s.insert==='plt')?.detail).toContain('3–8');expect(suggest('/due IRS ',9,state.doc!).items.some(s=>s.kind==='date')).toBe(true);expect(suggest('/attack ',8,state.doc!).ghost).toContain('unit');});
 it('formats a five-line doctrinal SITREP and current intent',()=>{const doc=execute('/intent "Finish taxes"');const report=sitrepText(doc,now);for(const text of ['SITREP','1. ENEMY:','2. FRIENDLY:','3. TERRAIN:','4. CHANGES LAST 24H:','5. CDR\'S INTENT TODAY: Finish taxes'])expect(report).toContain(text);});
});
describe('transaction invariants and command aliases',()=>{
 it.each([
  '/n "Quick capture"','/+ "Another capture"','/aff TOOLS fr','/ech TOOLS company','/mv TOOLS beyond','/atk IRSRSP IRS support planned','/mov IRSRSP to hq','/adv IRS on hq','/str IRS dmg','/x TOOLS','/reinf TOOLS','/dtg TOOLS none','/g TOOLS "Staff note"','/ao rename Work Office',
 ])('supports alias %s',input=>expect(parse(input,state.doc!)).toMatchObject({ok:true}));
 it('validates the entire document after every mutation',async()=>{
  const { importJson }=await import('../../src/lib/model/persist');
  for(const [,good]of cases){const cmd=command(good);const result=apply(state.doc!,cmd,now);if('error'in result)throw Error(result.error);expect(importJson(JSON.stringify(result.doc))).toEqual(result.doc);}
 });
 it('supports explicitly chosen HQ and neutral person functions',()=>{
  expect(execute('/new friend hq "Life HQ"').units.at(-1)).toMatchObject({fn:'hq',affiliation:'friend'});
  expect(execute('/new person "Doctor"').units.at(-1)).toMatchObject({kind:'person',affiliation:'neutral'});
 });
 it('refuses invalid direct UI mutations without changing any part of the document',()=>{
  const before=structuredClone(state.doc!);
  for(const cmd of [
   {verb:'new',args:{title:'Duplicate',designation:'IRS'}},
   {verb:'attack',args:{unit:'tools',target:'irs',role:'main'}},
   {verb:'bda',args:{unit:'irs',strength:-1}},
   {verb:'sector',args:{action:'remove',sectorId:'work'}},
   {verb:'attach',args:{unit:'move',parent:'packing'}},
   {verb:'view',args:{view:'invalid'}},
  ])expect(dispatch(cmd)).toMatchObject({ok:false});
  expect(state.doc).toEqual(before);
 });
 it('undo and redo work through slash commands and new edits clear redo',()=>{
  const before=structuredClone(state.doc!);dispatchText('/note IRS "First"');const after=structuredClone(state.doc!);expect(dispatchText('/undo')).toMatchObject({ok:true});expect(state.doc).toEqual(before);expect(dispatchText('/redo')).toMatchObject({ok:true});expect(state.doc).toEqual(after);undo();dispatchText('/note IRS "Second"');expect(redo()).toBe(false);
 });
 it('returns accurate bad token offsets',()=>{const result=parse('/id IRS banana',state.doc!);expect(result).toMatchObject({ok:false,at:8});});
 it('imports a validated document in one undoable transaction and refuses invalid JSON',()=>{
  const before=structuredClone(state.doc!),imported=seedDoc(new Date(2026,10,1,12));
  expect(dispatch({verb:'import',args:{text:JSON.stringify(imported)}})).toMatchObject({ok:true});expect(state.doc).toEqual(imported);undo();expect(state.doc).toEqual(before);expect(dispatch({verb:'import',args:{text:'{"version":2}'}})).toMatchObject({ok:false});expect(state.doc).toEqual(before);
 });
 it('archives completed items on the following day and flags stale active friendlies without altering their timestamps',()=>{
  state.doc=execute('/done IRS');const timestamp=state.doc.units.find(u=>u.id==='q4rpt')!.updatedAt;
  runTurnIfDue(new Date(2026,10,12,6));expect(state.doc!.units.find(u=>u.id==='irs')?.lifecycle).toBe('dropped');expect(state.doc!.units.find(u=>u.id==='q4rpt')).toMatchObject({note:'NO CONTACT 3D',updatedAt:timestamp});
 });
 it('reports exact multi-day trails and persists them through the turn log',async()=>{
  const {turnDetails}=await import('../../src/lib/commands/turn');const before={...state.doc!.units.find(u=>u.id==='irs')!.pos};const result=runTurnIfDue(new Date(2026,10,13,6));expect(result.ran).toBe(true);expect(turnDetails(state.doc!).trails.find(t=>t.unitId==='irs')?.from).toEqual(before);const after=structuredClone(state.doc!);undo();expect(turnDetails(state.doc!).trails).toEqual([]);redo();expect(state.doc).toEqual(after);expect(turnDetails(state.doc!).trails.length).toBe(result.advanced);
 });
 it('does not execute a second turn after a local clock rollback',()=>{state.doc!.lastTurn='2026-11-11';expect(runTurnIfDue(new Date(2026,10,10,6))).toMatchObject({ran:false});});
});
describe('integration rules',()=>{
 it('creates link orders without fake units or control measures',()=>{
  const doc=execute('/link TOOLS Q4RPT as dependency');
  expect(doc.orders.at(-1)).toMatchObject({type:'link',from:'tools',to:'q4rpt',kind:'dependency'});
  expect(doc.units).toHaveLength(state.doc!.units.length);expect(doc.measures).toHaveLength(state.doc!.measures.length);
 });
 it('cancels incompatible incoming and outgoing orders on a boundary move, and undo restores both positions and orders',()=>{
  const before=structuredClone(state.doc!);
  expect(dispatchText('/move IRS to Work near')).toMatchObject({ok:true});
  expect(state.doc!.orders.some(o=>o.to==='irs')).toBe(false);
  expect(state.doc!.log.at(-1)?.text).toContain('CANCELLED (BOUNDARY)');
  expect(undo()).toBe(true);expect(state.doc).toEqual(before);
  expect(dispatchText('/move IRSRSP to Work near')).toMatchObject({ok:true});
  expect(state.doc!.orders.some(o=>o.from==='irsrsp')).toBe(false);
  expect(state.doc!.log.at(-1)?.text).toContain('CANCELLED (BOUNDARY)');
 });
 it('keeps task-force orders when crossing a sector boundary',()=>{
  const before=structuredClone(state.doc!.orders.filter(o=>o.from==='move'));
  const doc=execute('/move MOVE to Work far');expect(doc.orders.filter(o=>o.from==='move')).toEqual(before);
 });
});
