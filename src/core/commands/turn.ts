import type { Doc, Unit } from '../model/types';
import { normalizeDeg, radiusForDate, resolvePlacement } from '../model/geometry';
import { cloneDoc } from '../model/clone';
import { localDay, parts, calendarDay } from '../model/time';
import { unresolved } from './resolve';
export interface Crossing {unitId:string;pl:string;}
export interface Trail {unitId:string;from:{r:number;theta:number};to:{r:number;theta:number};}
export interface TurnResult {doc:Doc;log:string;advanced:number;crossings:Crossing[];trails:Trail[];}
/** Also serialized in the turn log's cmd field, so reload/undo retain trail evidence. */
export function turnDetails(doc:Doc):{trails:Trail[];crossings:Crossing[]} {
 const entry=[...doc.log].reverse().find(l=>l.cmd?.startsWith('{"verb":"turn"'));
 if(!entry||localDay(new Date(entry.at),doc.settings.tz)!==doc.lastTurn)return {trails:[],crossings:[]};
 try {return JSON.parse(entry.cmd!).args;}catch{return {trails:[],crossings:[]};}
}
const thresholds=[{r:4,pl:'QUARTER'},{r:3,pl:'MONTH'},{r:2,pl:'WEEK'},{r:1,pl:'TODAY'}];
export function advanceDay(original:Doc,now:Date):TurnResult {
 const tz=original.settings.tz;
 const day=localDay(now,tz);
 if(Number(parts(now,tz).hour)<4||Boolean(original.lastTurn&&original.lastTurn>=day))return {doc:original,log:Number(parts(now,tz).hour)<4?'Morning turn is available after 0400 local':'Morning turn already ran today',advanced:0,crossings:[],trails:[]};
 const doc=cloneDoc(original),at=now.toISOString(),crossings:Crossing[]=[],trails:Trail[]=[];
 const id=(prefix:string,values:{id:string}[])=>{let n=1;const ids=new Set(values.map(x=>x.id));while(ids.has(`${prefix}${n}`))n++;return `${prefix}${n}`;};
 for(const u of doc.units){
  // Done units stay visible through their completion day, then remain in the archive.
  if(u.lifecycle==='done'&&localDay(new Date(u.updatedAt),tz)<day){u.lifecycle='dropped';doc.orders=doc.orders.filter(o=>o.from!==u.id&&o.to!==u.id);continue;}
  if(u.affiliation==='friend'&&u.lifecycle==='active'){
   const elapsed=(calendarDay(now,tz)-calendarDay(new Date(u.updatedAt),tz))/86400000;
   if(elapsed>=3&&!u.note?.includes('NO CONTACT 3D'))u.note=[u.note,'NO CONTACT 3D'].filter(Boolean).join(' — ');
  }
  if(!doc.settings.autoAdvance||!u.dueAt||u.posOverride||!['hostile','suspect'].includes(u.affiliation)||!unresolved(u))continue;
  const radius=radiusForDate(u.dueAt,now,tz);if(radius>=u.pos.r-1e-9)continue;
  const previous={...u.pos};u.pos=resolvePlacement(doc,u.sectorId,{r:radius,theta:normalizeDeg(u.pos.theta)},u.id);
  if(Math.abs(previous.r-u.pos.r)<1e-9&&Math.abs(previous.theta-u.pos.theta)<1e-9)continue;
  trails.push({unitId:u.id,from:previous,to:{...u.pos}});
  const crossed=thresholds.filter(t=>previous.r>t.r&&radius<=t.r);
  for(const t of crossed)crossings.push({unitId:u.id,pl:t.pl});
  if(crossed.length&&u.affiliation==='hostile'&&!doc.orders.some(o=>o.type==='advance'&&o.from===u.id))doc.orders.push({id:id('o',doc.orders),type:'advance',from:u.id,to:'hq',createdAt:at});
 }
 doc.lastTurn=day;
 const log=`${trails.length} hostiles/suspects advanced${crossings.length?`, ${crossings.length} crossed ${[...new Set(crossings.map(c=>`PL ${c.pl}`))].join(', ')}`:''}`;
 if(trails.length||crossings.length)doc.log.push({id:`log${1+Math.max(0,...doc.log.map(l=>Number(l.id.replace(/^log/,''))||0))}`,at,text:log,cmd:JSON.stringify({verb:'turn',args:{trails,crossings}})});
 return {doc,log,advanced:trails.length,crossings,trails};
}
export function staleFriendly(u:Unit,now:Date):boolean {return u.affiliation==='friend'&&u.lifecycle==='active'&&now.getTime()-Date.parse(u.updatedAt)>=3*86400000;}
