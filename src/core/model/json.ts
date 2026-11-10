import ms from 'milsymbol';
import type { Doc } from './types';
import { ECHELONS } from './echelon';
import { FUNCTION_BY_KEY } from './functions';
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object' && value!==null && !Array.isArray(value);
const string=(value:unknown):value is string=>typeof value==='string';
const finite=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value);
const oneOf=(value:unknown,choices:readonly unknown[])=>choices.includes(value);
const date=(value:unknown)=>string(value)&&Number.isFinite(Date.parse(value));
function requireValid(valid:unknown,message:string):asserts valid {if(!valid) throw new Error(`Invalid document: ${message}`);}
function optional(obj:Record<string,unknown>,key:string,test:(value:unknown)=>boolean):void {
  requireValid(obj[key]===undefined||test(obj[key]),key);
}
function position(p:unknown):boolean {return object(p)&&finite(p.r)&&p.r>=0&&finite(p.theta);}
function records(value:unknown,label:string):Record<string,unknown>[] {
  requireValid(Array.isArray(value),label);
  const ids=new Set<string>();
  for(const item of value) {
    requireValid(object(item)&&string(item.id)&&item.id.length>0&&!ids.has(item.id),`${label} IDs`);
    ids.add(item.id);
  }
  return value as Record<string,unknown>[];
}
export function importJson(text:string):Doc {
  const value:unknown=JSON.parse(text);
  requireValid(object(value),'object');
  requireValid(value.version===1,'unsupported version');
  const sectors=records(value.sectors,'sectors'),units=records(value.units,'units'),orders=records(value.orders,'orders'),measures=records(value.measures,'measures'),log=records(value.log,'log');
  requireValid(sectors.length>0,'at least one sector');
  const sectorIds=new Set(sectors.map(s=>s.id)),unitIds=new Set(units.map(u=>u.id)),measureIds=new Set(measures.map(m=>m.id));
  for(const s of sectors) {
    requireValid(string(s.name)&&s.name.trim().length>0&&finite(s.startDeg)&&finite(s.widthDeg)&&s.widthDeg>0&&s.widthDeg<=360,'sector');
    optional(s,'color',string);
  }
  const designations=new Set<string>();
  for(const u of units) {
    requireValid(string(u.designation)&&/^[A-Z0-9][A-Z0-9_-]*$/.test(u.designation)&&!designations.has(u.designation),'unique uppercase designation');
    designations.add(u.designation);
    requireValid(string(u.title)&&oneOf(u.kind,['unit','person','place','event'])&&oneOf(u.affiliation,['pending','unknown','assumed','friend','neutral','suspect','hostile']),'unit identity');
    requireValid(string(u.fn)&&Object.hasOwn(FUNCTION_BY_KEY,u.fn),'unit function');
    requireValid(oneOf(u.lifecycle,['todo','active','blocked','done','dropped'])&&oneOf(u.presence,['present','planned'])&&oneOf(u.condition,['none','fully-capable','damaged','destroyed','full']),'unit status');
    requireValid(sectorIds.has(u.sectorId)&&position(u.pos)&&date(u.createdAt)&&date(u.updatedAt),'unit position and dates');
    optional(u,'echelon',v=>ECHELONS.some(e=>e.key===v));
    optional(u,'strength',v=>finite(v)&&v>=0&&v<=100);
    optional(u,'reinforced',v=>oneOf(v,['+','-','±']));
    for(const key of ['taskForce','posOverride','keyTerrain']) optional(u,key,v=>typeof v==='boolean');
    optional(u,'cp',v=>oneOf(v,['main','tac','alt','rear']));
    for(const key of ['note','rating','createdBy','updatedBy']) optional(u,key,string);
    optional(u,'dueAt',date);
    optional(u,'parentId',v=>string(v)&&unitIds.has(v)&&v!==u.id);
    optional(u,'sidcOverride',v=>string(v)&&/^\d{20}$/.test(v)&&Boolean(new ms.Symbol(v).isValid()));
  }
  const byId=new Map(units.map(u=>[u.id,u]));
  for(const u of units) {
    const seen=new Set<unknown>([u.id]); let parent=u.parentId;
    while(parent!==undefined) {
      requireValid(!seen.has(parent),'cyclic parent references');seen.add(parent);parent=byId.get(parent)?.parentId;
    }
  }
  for(const m of measures) {
    requireValid(oneOf(m.type,['obj','ea','nai','pl'])&&string(m.name),'control measure');
    optional(m,'sectorId',v=>sectorIds.has(v));optional(m,'pos',position);optional(m,'size',v=>finite(v)&&v>0);optional(m,'members',v=>Array.isArray(v)&&v.every(id=>typeof id==='string'&&unitIds.has(id))&&new Set(v).size===v.length);optional(m,'date',date);
  }
  const placed=new Set<string>();
  for(const m of measures)for(const id of (m.members as string[]|undefined)??[]){requireValid(m.type!=='pl'&&!placed.has(id),'area members: a unit belongs to at most one area');placed.add(id);}
  for(const o of orders) {
    if(o.type==='link') requireValid(unitIds.has(o.from)&&unitIds.has(o.to),'link endpoints must be unit IDs');
    optional(o,'kind',v=>oneOf(v,['dependency','handoff']));
    requireValid(oneOf(o.type,['attack','axis','advance','move','link'])&&unitIds.has(o.from)&&(o.to==='hq'||typeof o.to==='string'&&o.to.startsWith('hq:')&&sectorIds.has(o.to.slice(3))||unitIds.has(o.to)||measureIds.has(o.to))&&date(o.createdAt),'order');
    optional(o,'role',v=>oneOf(v,['main','support']));optional(o,'planned',v=>typeof v==='boolean');
    optional(o,'via',v=>Array.isArray(v)&&v.every(id=>measures.some(m=>m.id===id&&m.type==='pl')));
  }
  for(const entry of log) {requireValid(date(entry.at)&&string(entry.text),'log entry');optional(entry,'cmd',string);optional(entry,'by',string);optional(entry,'via',string);}
  requireValid(object(value.settings)&&oneOf(value.settings.view,['commander','staff','detail'])&&oneOf(value.settings.theme,['light','dark'])&&typeof value.settings.autoAdvance==='boolean','settings');
  optional(value.settings,'tz',v=>{try {if(!string(v))return false;new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
  optional(value,'lastTurn',date);
  optional(value,'intent',v=>object(v)&&date(v.date)&&string(v.text));
  return value as unknown as Doc;
}
export function exportJson(doc:Doc):string {return JSON.stringify(doc,null,2);}
