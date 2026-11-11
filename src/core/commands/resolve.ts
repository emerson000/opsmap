import type { ControlMeasure, Doc, Sector, Unit } from '../model/types';
import { effectiveCondition } from '../model/derive';
import { polarToXY } from '../model/geometry';
import { CommandError } from './tokenize';
const normalized = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]+/g,' ');
function resolve<T extends {id:string}>(text: string, values: T[], labels: (v:T)=>string[], at:number, sectorId?:string):T {
  const key=normalized(text);
  const exact=values.filter(v=>v.id===text.replace(/^#/,'' ) || labels(v).some(s=>normalized(s)===key));
  if (exact.length===1) return exact[0];
  if (text.startsWith('#')) throw new CommandError(`Unknown ID: ${text}`,at);
  let matches=exact.length?exact:values.filter(v=>labels(v).some(s=>normalized(s).startsWith(key)));
  if (!matches.length) matches=values.filter(v=>labels(v).some(s=>normalized(s).includes(key)));
  if (!exact.length && sectorId) {const local=matches.filter(v=>'sectorId' in v && v.sectorId===sectorId);if(local.length)matches=local;}
  if (matches.length===1) return matches[0];
  if (!matches.length) {
    const distance=(a:string,b:string)=>{let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(a[i-1]!==b[j-1]));row=next;}return row[b.length];};
    const nearest=values.map(v=>({label:labels(v)[0],distance:Math.min(...labels(v).map(l=>distance(key,normalized(l))))})).sort((a,b)=>a.distance-b.distance)[0];
    throw new CommandError(`No match for “${text}”${nearest&&nearest.distance<=Math.max(2,key.length/2)?`. Did you mean ${nearest.label}?`:''}`,at);
  }
  throw new CommandError(`Ambiguous “${text}”: ${matches.map(v=>labels(v)[0]).join(', ')}`,at);
}
export function resolveUnit(text:string,doc:Doc,at=0,sectorId?:string):Unit {
  // The designation field has precedence even over an exact title on another unit.
  const designation=doc.units.find(u=>u.designation.toUpperCase()===text.toUpperCase());
  return designation ?? resolve(text,doc.units,u=>[u.designation,u.title],at,sectorId);
}
export function resolveSector(text:string,doc:Doc,at=0):Sector {return resolve(text,doc.sectors,s=>[s.name],at);}
export function resolveMeasure(text:string,doc:Doc,type?:ControlMeasure['type'],at=0):ControlMeasure {
  return resolve(text,doc.measures.filter(m=>!type||m.type===type),m=>[m.name],at);
}
export function resolveTarget(text:string,doc:Doc,at=0,sectorId?:string):Unit|ControlMeasure {
  if (doc.units.some(u=>u.id===text.replace(/^#/,'')||u.designation.toUpperCase()===text.toUpperCase()||normalized(u.title)===normalized(text))) return resolveUnit(text,doc,at,sectorId);
  if (doc.measures.some(m=>m.id===text||normalized(m.name)===normalized(text))) return resolveMeasure(text,doc,undefined,at);
  const candidates=[...doc.units,...doc.measures];
  return resolve(text,candidates,v=>'designation'in v?[v.designation,v.title]:[v.name],at,sectorId);
}
export function unresolved(u:Unit):boolean {return u.lifecycle!=='done'&&u.lifecycle!=='dropped'&&effectiveCondition(u)!=='destroyed';}
export function nearestHostile(doc:Doc,source:Unit):Unit {
  const p=polarToXY(source.pos);
  const candidates=doc.units.filter(u=>u.id!==source.id&&u.sectorId===source.sectorId&&(u.affiliation==='hostile'||u.affiliation==='suspect')&&unresolved(u));
  candidates.sort((a,b)=>{
    const x=polarToXY(a.pos),y=polarToXY(b.pos);
    return Math.hypot(x.x-p.x,x.y-p.y)-Math.hypot(y.x-p.x,y.y-p.y)||a.id.localeCompare(b.id);
  });
  if(!candidates.length)throw new CommandError('No unresolved hostile in this sector');
  return candidates[0];
}
/** A map by id, or by name ignoring case and outer spaces (the server's maps, the browser's map list). */
export function resolveMap<T extends {id:string;name:string}>(ref:string,maps:readonly T[]):T {
  const found=maps.find(m=>m.id===ref)??maps.find(m=>m.name.toLowerCase()===ref.trim().toLowerCase());
  if(!found)throw new Error(`Unknown map: ${ref}`);
  return found;
}
