import { DEFAULT_TZ, parts } from './time';
import ms, { type SymbolOptions } from 'milsymbol';
import type { Condition, Unit, View } from './types';
import { ECHELONS } from './echelon';
import { FUNCTION_BY_KEY, HOSTILE_ENTITIES } from './functions';
import { effectiveCondition } from './derive';
const identities={pending:'0',unknown:'1',assumed:'2',friend:'3',neutral:'4',suspect:'5',hostile:'6'} as const;
const statuses:Record<Condition,string>={none:'0','fully-capable':'2',damaged:'3',destroyed:'4',full:'5'};
export function toSidc(u:Unit):string {
  if(u.sidcOverride) return u.sidcOverride;
  const fn=FUNCTION_BY_KEY[u.fn];
  const condition=effectiveCondition(u);
  const status=u.presence==='planned'?'1':u.condition!=='none'?statuses[u.condition]:u.lifecycle==='blocked'?'3':u.lifecycle==='done'?(u.affiliation==='hostile'?'4':'2'):statuses[condition];
  // A command post is a headquarters, whatever its function.
  const h=(u.fn==='hq'||u.cp?2:0)+(u.taskForce?4:0);
  const echelon=fn.symbolSet==='10' && u.echelon?ECHELONS.find(e=>e.key===u.echelon)?.code??'00':'00';
  const entity=(u.affiliation==='hostile'||u.affiliation==='suspect')?HOSTILE_ENTITIES[u.fn]??fn.entity:fn.entity;
  // A command post shows its type (MAIN, TAC…) in place of the icon, as in standard CP symbols.
  const icon=u.cp&&fn.symbolSet==='10'?'000000':entity;
  return `130${identities[u.affiliation]}${fn.symbolSet}${status}${h}${echelon}${icon}0000`;
}
export function formatDtg(input:string|Date,tz=DEFAULT_TZ):string {
  const p=parts(new Date(input),tz),pad=(n:number)=>String(n).padStart(2,'0');
  const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${p.day}${p.hour}${p.minute}J${months[Number(p.month)-1]}${pad(Number(p.year)%100)}`;
}
export function symbolOptions(u:Unit,view:View):SymbolOptions {
  const options:SymbolOptions={simpleStatusModifier:true,uniqueDesignation:u.designation,civilianColor:u.fn==='person'};
  // Special C2 headquarters (field AA): shown inside the frame in every view.
  if(u.cp)options.specialHeadquarters=u.cp.toUpperCase();
  if(view!=='commander') {
    if(u.strength!==undefined) options.combatEffectiveness=`${u.strength}%`;
    if(u.reinforced) options.reinforcedReduced=`(${u.reinforced})`;
    if(u.dueAt) options.dtg=formatDtg(u.dueAt);
  }
  if(view==='detail') {
    if(u.note) options.staffComments=u.note;
    if(u.rating) options.evaluationRating=u.rating;
    if(u.parentId) options.higherFormation=u.parentId;
    options.type=u.title;
  }
  return options;
}
export interface RenderedSymbol {svg:string;anchor:{x:number;y:number};width:number;height:number;}
const cache=new Map<string,RenderedSymbol>();
const CACHE_LIMIT=256;
export function renderSymbol(u:Unit,view:View='commander',size:number=40):RenderedSymbol {
  const code=toSidc(u),options={...symbolOptions(u,view),size};
  const key=JSON.stringify([code,options]);
  const cached=cache.get(key);
  if(cached) {cache.delete(key);cache.set(key,cached);return cached;}
  const symbol=new ms.Symbol(code,options);
  const result={svg:symbol.asSVG(),anchor:symbol.getAnchor(),...symbol.getSize()};
  cache.set(key,result);
  if(cache.size>CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
