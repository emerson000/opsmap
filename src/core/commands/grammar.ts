import type { Command, Doc, Unit } from '../model/types';
import { apply, functions, identities, sizes } from './apply';
import { AO_SIZES, AREA_SIZES } from '../model/geometry';
import { nearestHostile, resolveMeasure, resolveSector, resolveTarget, resolveUnit } from './resolve';
import { CommandError, parseDate, tokenize, type Token } from './tokenize';
export type ParseResult={ok:true;cmd:Command;preview:string}|{ok:false;error:string;at:number};
export const VERBS=['new','id','size','fn','rename','move','attack','moving','axis','advancing','bda','block','unblock','unpin','done','drop','reinforce','reduce','attach','detach','link','due','note','rate','key','cp','halt','support','sector','pl','obj','ea','nai','find','sitrep','intent','turn','view','undo','redo','export','import','sidc','help'] as const;
export const aliases:Record<string,string>={n:'new','+':'new',aff:'id',ech:'size',mv:'move',atk:'attack',mov:'moving',adv:'advancing',str:'bda',x:'done',reinf:'reinforce',dtg:'due',g:'note',ao:'sector',commandpost:'cp',stop:'halt',cancel:'halt',spt:'support'};
export const SYNTAX:Record<string,string>={
 new:'[identity] [size] [function] "‹title›" [in ‹sector›] [ring] [due ‹date›] [as ‹designation›]',
 id:'‹unit› ‹identity› [confirm]',size:'‹unit› ‹echelon›',fn:'‹unit› ‹function›',rename:'‹unit› "‹title›" [as ‹designation›]',
 move:'‹unit› [to ‹sector›] ‹ring› | ‹unit› near ‹unit›',attack:'‹unit› ‹target› [main|support] [planned]',moving:'‹unit› to ‹target|nearest hostile|hq|sector hq|‹sector› hq›',axis:'‹unit› to OBJ ‹name› [via PL ‹name›, ...]',advancing:'‹hostile› on ‹hq|sector hq|‹sector› hq|unit›',
 cp:'‹unit› ‹main|tac|alt|rear|none›',halt:'‹unit› [advance|move|attack|axis|link|support]',support:'‹friendly› ‹friendly› (any sector)',bda:'‹unit› ‹0–100%|fc|dmg|des|full›',block:'‹unit› [by "‹reason›"]',unblock:'‹unit›',unpin:'‹pinned unit›',done:'‹unit›',drop:'‹unit› [bypassed]',reinforce:'‹unit› [with ‹unit›]',reduce:'‹unit› ["‹scope cut›"]',attach:'‹unit› to ‹task force›',detach:'‹unit›',link:'‹unit› ‹unit› [as dependency|handoff]',due:'‹unit› ‹date|none›',note:'‹unit› "‹text›"',rate:'‹unit› ‹A–F›‹1–6›',key:'‹unit›',sector:'add ‹name› | rename ‹name› ‹new name› | remove ‹name› [reassign ‹sector›] | width ‹name› ‹degrees› | size ‹small|medium|large|xl›',pl:'add "‹name›" ‹date› | date ‹name› ‹date› | remove ‹name›',obj:'add "‹name›" in ‹sector› [ring] | move ‹name› [to ‹sector›] ‹ring› | move ‹name› near ‹unit› | join ‹name› ‹unit›… | leave ‹name› ‹unit›… | size ‹name› ‹small|medium|large|xl› | remove ‹name›',ea:'add "‹name›" in ‹sector› [ring] | move ‹name› [to ‹sector›] ‹ring› | move ‹name› near ‹unit› | join ‹name› ‹unit›… | leave ‹name› ‹unit›… | size ‹name› ‹small|medium|large|xl› | remove ‹name›',nai:'add "‹name›" in ‹sector› [ring] | move ‹name› [to ‹sector›] ‹ring› | move ‹name› near ‹unit› | join ‹name› ‹unit›… | leave ‹name› ‹unit›… | size ‹name› ‹small|medium|large|xl› | remove ‹name›',find:'‹unit›',sitrep:'[copy]',intent:'"‹one line›"',turn:'',view:'commander|staff|detail',undo:'',redo:'',export:'',import:'',sidc:'‹unit› ‹20 digits›',help:'',
};
const rings=['hq','near','mid','far','beyond'];
/** The inspector's plain ring words, accepted as aliases. */
export const ringAliases:Record<string,string>={close:'near',deep:'mid',aoi:'far'};
const ringWord=(v:string)=>ringAliases[v.toLowerCase()]??v.toLowerCase();
const RING_HELP='hq, near (close), mid (deep), far (aoi) or beyond';
export interface ParseContext { selectedId?:string|null; now?:Date; }
export function parse(input:string,doc:Doc,context:ParseContext={}):ParseResult {
 const now=context.now??new Date();
 let at=0;
 try {
  if(!input.trimStart().startsWith('/'))throw new CommandError('Start commands with /',0);
  const tokens=tokenize(input);let i=0;
  const first=tokens[i++];if(!first)throw new CommandError('Enter a command',input.length);
  const typed=first.value.slice(1).toLowerCase(),verb=aliases[typed]??typed;
  if(!(VERBS as readonly string[]).includes(verb))throw new CommandError(`Unknown command: ${typed}`,first.start+1);
  const a:Record<string,unknown>={};
  const peek=()=>tokens[i];
  const take=(label:string):Token=>{const token=tokens[i++];at=token?.start??input.length;if(!token)throw new CommandError(`Expected ${label}`,input.length);return token;};
  const is=(value:string)=>peek()?.quoted===false&&peek().value.toLowerCase()===value;
  const eat=(value:string)=>{if(is(value)){take(value);return true;}return false;};
  const expect=(value:string)=>{if(!eat(value))throw new CommandError(`Expected ${value}`,peek()?.start??input.length);};
  const selected=doc.units.find(u=>u.id===context.selectedId);
  const subject=():Unit=>{const t=take('unit');const u=resolveUnit(t.value,doc,t.start,selected?.sectorId);a.unit=u.id;return u;};
  const sector=()=>{eat('sector');const t=take('sector');return resolveSector(t.value,doc,t.start).id;};
  /** `hq` (the center), `sector hq` (the source's own sector HQ) or `<sector> hq` (that sector's HQ, as `hq:<id>`). */
  const sectorHq=(source?:Unit):string|undefined=>{
   const t=peek(),next=tokens[i+1];
   if(!t||!next||next.value.toLowerCase()!=='hq')return;
   if(t.value.toLowerCase()==='sector'){const owner=source??selected;if(!owner)throw new CommandError('Name the sector: ‹sector› hq',t.start);take('sector');take('hq');return `hq:${owner.sectorId}`;}
   const sec=doc.sectors.find(s=>s.name.toLowerCase()===t.value.toLowerCase()||s.id===t.value.toLowerCase());
   if(!sec)return;take('sector');take('hq');return `hq:${sec.id}`;
  };
  const target=(source?:Unit)=>{const shq=sectorHq(source);if(shq)return shq;if(eat('hq'))return 'hq';const type=peek()?.value.toLowerCase();if(['obj','ea','nai','pl'].includes(type??'')){take('type');const t=take('control measure');return resolveMeasure(t.value,doc,type as 'obj',t.start).id;}const t=take('target');return resolveTarget(t.value,doc,t.start,source?.sectorId??selected?.sectorId).id;};
  const date=()=>{const t=take('date');try{return parseDate(t.value,now,doc.settings.tz);}catch(e){throw new CommandError((e as Error).message,t.start);}};
  const quoted=(label:string)=>{const t=take(label);if(!t.quoted)throw new CommandError(`Quote the ${label}`,t.start);return t.value;};
  switch(verb){
   case 'new': {
    let title=false,identity=false,size=false,fn=false;
    while(peek()){
     const t=peek(),key=t.value.toLowerCase();
     if(t.quoted&&!title){a.title=take('title').value;title=true;}
     else if(eat('in')){if(a.sectorId)throw new CommandError('Sector already specified',t.start);a.sectorId=sector();}
     else if(eat('due')){if(a.dueAt)throw new CommandError('Date already specified',t.start);a.dueAt=date();}
     else if(eat('as')){a.designation=take('designation').value;}
     else if(eat('confirm'))a.confirm=true;
     else if(!title&&!identity&&Object.hasOwn(identities,key)){a.affiliation=identities[key];identity=true;take('identity');}
     else if(eat('unit')){ /* optional noise after identity */ }
     else if(!title&&!size&&Object.hasOwn(sizes,key)){a.echelon=sizes[key];size=true;take('echelon');}
     else if(!title&&!fn&&Object.hasOwn(functions,key)&&a.sectorId===undefined&&a.dueAt===undefined){a.fn=functions[key];fn=true;take('function');}
     else if(!t.quoted&&rings.includes(ringWord(key))){if(a.ring)throw new CommandError('Ring already specified',t.start);a.ring=ringWord(take('ring').value);}
     else throw new CommandError(`Unexpected token: ${t.value}`,t.start);
    }
    if(!title&&!identity&&!size&&!fn)throw new CommandError('Expected a title or identity',input.length);
    a.sectorId??=selected?.sectorId??doc.sectors.find(s=>s.name.toLowerCase()==='household')?.id??doc.sectors[0]?.id;
    break;
   }
   case 'id':subject();{const t=take('identity');a.affiliation=identities[t.value.toLowerCase()];if(!a.affiliation)throw new CommandError('Unknown identity',t.start);a.confirm=eat('confirm');}break;
   case 'size':subject();{const t=take('echelon');a.echelon=sizes[t.value.toLowerCase()];if(!a.echelon)throw new CommandError('Unknown echelon',t.start);}break;
   case 'fn':subject();{const t=take('function');a.fn=functions[t.value.toLowerCase()];if(!a.fn)throw new CommandError('Unknown function',t.start);a.confirm=eat('confirm');}break;
   case 'rename':subject();a.title=quoted('title');if(eat('as'))a.designation=take('designation').value;break;
   case 'move': {
    subject();if(eat('to'))a.sectorId=sector();
    const t=take('ring');if(!rings.includes(ringWord(t.value)))throw new CommandError(`Expected ${RING_HELP}`,t.start);
    if(t.value.toLowerCase()==='near'&&peek()){const ref=take('unit');a.nearUnit=resolveUnit(ref.value,doc,ref.start,selected?.sectorId).id;}else a.ring=ringWord(t.value);break;
   }
   case 'attack': {const u=subject();a.target=target(u);a.role='main';if(is('main')||is('support'))a.role=take('role').value.toLowerCase();a.planned=eat('planned');break;}
   case 'moving': {const u=subject();expect('to');if(eat('nearest')){expect('hostile');a.target=nearestHostile(doc,u).id;}else a.target=target(u);if(doc.units.some(x=>x.id===a.target&&(x.affiliation==='hostile'||x.affiliation==='suspect'))){const hasMain=doc.orders.some(o=>o.type==='attack'&&o.role==='main'&&doc.units.find(x=>x.id===o.from)?.sectorId===u.sectorId);a.role=hasMain?'support':'main';}break;}
   case 'axis': {subject();expect('to');eat('obj');const t=take('objective');a.target=resolveMeasure(t.value,doc,'obj',t.start).id;const via:string[]=[];if(eat('via')){do{eat('pl');const p=take('phase line');via.push(resolveMeasure(p.value,doc,'pl',p.start).id);}while(eat(','));}a.via=via;break;}
   case 'advancing':{const u=subject();expect('on');a.target=target(u);break;}
   case 'bda': {subject();const t=take('strength or condition'),key=t.value.toLowerCase();if(/^\d+(?:\.\d+)?%$/.test(key))a.strength=Number(key.slice(0,-1));else{const conditions:Record<string,string>={fc:'fully-capable',dmg:'damaged',des:'destroyed',full:'full',ftc:'full',none:'none',destroyed:'destroyed',damaged:'damaged','fully-capable':'fully-capable'};a.condition=conditions[key];if(!a.condition)throw new CommandError('Expected 0–100%, fc, dmg, des, or full',t.start);}break;}
   case 'block':subject();if(eat('by'))a.note=quoted('reason');break;
   case 'unblock':case 'unpin':case 'done':case 'detach':case 'key':case 'find':subject();break;
   case 'drop':subject();a.bypassed=eat('bypassed');break;
   case 'reinforce':subject();if(eat('with')){const t=take('unit');a.with=resolveUnit(t.value,doc,t.start,selected?.sectorId).id;}break;
   case 'reduce':subject();if(peek())a.note=quoted('scope cut');break;
   case 'attach':subject();expect('to');{const t=take('task force');a.parent=resolveUnit(t.value,doc,t.start,selected?.sectorId).id;}break;
   case 'link':subject();{const t=take('unit');a.target=resolveUnit(t.value,doc,t.start,selected?.sectorId).id;}if(eat('as'))a.kind=take('dependency or handoff').value.toLowerCase();break;
   case 'due':subject();a.dueAt=eat('none')?null:date();break;
   case 'note':subject();a.note=quoted('text');break;
   case 'rate':subject();a.rating=take('rating').value;break;
   case 'support':subject();{const t=take('supported unit');a.target=resolveUnit(t.value,doc,t.start).id;}break;
   case 'halt':subject();if(peek()){const t=take('order kind');const k=({advancing:'advance',moving:'move'} as Record<string,string>)[t.value.toLowerCase()]??t.value.toLowerCase();if(!['advance','move','attack','axis','link','support'].includes(k))throw new CommandError('Expected advance, move, attack, axis, link or support',t.start);a.kind=k;}break;
   case 'cp':subject();{const t=take('command post');const v=t.value.toLowerCase();if(!['main','tac','alt','rear','none'].includes(v))throw new CommandError('Expected main, tac, alt, rear or none',t.start);a.cp=v==='none'?null:v;}break;
   case 'sector': {
    const action=take('sector action').value.toLowerCase();a.action=action;
    if(action==='add')a.name=take('sector name').value;
    else if(action==='size'){const t=take('AO size');const v=t.value.toLowerCase();if(!(v in AO_SIZES))throw new CommandError('Expected small, medium, large or xl',t.start);a.size=v;}
    else {a.sectorId=sector();if(action==='rename'){eat('to');a.name=take('new sector name').value;}else if(action==='width')a.degrees=Number(take('degrees').value);else if(action==='remove'){if(eat('reassign'))a.reassign=sector();}else throw new CommandError('Expected add, rename, remove, width, or size',at);}
    break;
   }
   case 'pl':case 'obj':case 'ea':case 'nai': {
    const actions=verb==='pl'?'add, date, or remove':'add, move, join, leave, size, or remove';
    const action=take(actions).value.toLowerCase();a.action=action;
    if(action==='remove'){const t=take('name');a.measure=resolveMeasure(t.value,doc,verb,t.start).id;}
    else if(action==='add'){a.name=take('name').value;if(verb==='pl')a.date=date();else{expect('in');a.sectorId=sector();if(peek())a.ring=ringWord(take('ring').value);}}
    else if((action==='join'||action==='leave')&&verb!=='pl'){
     const t=take('name');a.measure=resolveMeasure(t.value,doc,verb,t.start).id;
     const units:string[]=[];
     do{const u=take('unit');const id=resolveUnit(u.value,doc,u.start,selected?.sectorId).id;if(!units.includes(id))units.push(id);}while(peek());
     a.units=units;
    }
    else if(action==='size'&&verb!=='pl'){
     const t=take('name');a.measure=resolveMeasure(t.value,doc,verb,t.start).id;
     const z=take('size');const key=z.value.toLowerCase();
     if(!Object.hasOwn(AREA_SIZES,key))throw new CommandError('Expected small, medium, large or xl',z.start);
     a.size=key;
    }
    else if(action==='date'&&verb==='pl'){const t=take('name');a.measure=resolveMeasure(t.value,doc,'pl',t.start).id;a.date=date();}
    else if(action==='move'&&verb!=='pl'){
     const t=take('name');a.measure=resolveMeasure(t.value,doc,verb,t.start).id;
     if(eat('to'))a.sectorId=sector();
     const r=take('ring');const ring=ringWord(r.value);
     if(!['hq','near','mid','far'].includes(ring))throw new CommandError('Expected hq, near (close), mid (deep) or far (aoi)',r.start);
     if(ring==='near'&&peek()&&a.sectorId===undefined){const ref=take('unit');a.nearUnit=resolveUnit(ref.value,doc,ref.start,selected?.sectorId).id;}else a.ring=ring;
    }
    else throw new CommandError(`Expected ${actions}`,at);break;
   }
   case 'intent':a.text=quoted('intent');break;
   case 'view':a.view=take('view').value.toLowerCase();break;
   case 'sidc':subject();a.sidc=take('20-digit SIDC').value;break;
   case 'sitrep':a.copy=eat('copy');break;
   case 'turn':case 'undo':case 'redo':case 'export':case 'import':case 'help':break;
  }
  if(peek())throw new CommandError(`Unexpected token: ${peek().value}`,peek().start);
  // Normalize moving sugar before execution, preserving the chosen default role.
  let canonical=verb;
  if(verb==='moving'&&doc.units.some(u=>u.id===a.target&&(u.affiliation==='hostile'||u.affiliation==='suspect')))canonical='attack';
  const cmd:Command={verb:canonical,args:a,raw:input};
  const validation=apply(doc,cmd,now);
  if('error'in validation)throw new CommandError(validation.error,at);
  return {ok:true,cmd,preview:validation.log};
 }catch(error){return {ok:false,error:error instanceof Error?error.message:'Invalid command',at:error instanceof CommandError?error.at:at};}
}
