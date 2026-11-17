// The neutral fields opsmap and a task service share, and their three-way merge against the values both sides last
// agreed on (ts_links.base): a field changed on one side is copied across; changed on both, the newer side wins.
import type { Affiliation, Doc, SyncField, Unit } from '../../src/core/model/types';
import { localDay, zonedTime } from '../../src/core/model/time';
import type { FieldKey, RemoteStatus, RemoteTask } from './contract';
export interface Fields { title:string; due:string|null; note:string; progress:number|null; status:RemoteStatus|null; sector:string|null; affiliation:Affiliation|null }
export type Field=keyof Fields;
export const FIELDS=['title','due','note','progress','status','sector','affiliation'] as const satisfies readonly Field[];
/** Each merged field and the capability that declares it. */
export const FIELD_KEY:Record<Field,FieldKey>={title:'title',due:'due',note:'note',progress:'progress',status:'status',sector:'container',affiliation:'affiliation'};
/** Each per-map switch (D21) and the field it stops. */
export const SWITCHED:Record<SyncField,Field>={identity:'affiliation',state:'status',due:'due',note:'note',progress:'progress'};
/** opsmap's longest note in one op. */
export const NOTE_LIMIT=16000;
export const threat=(u:{affiliation:Affiliation})=>u.affiliation==='hostile'||u.affiliation==='suspect';
/** Units that live in a task service: tasks and events, not people or places. */
export const syncable=(u:Unit)=>u.kind==='unit'||u.kind==='event';
/** A day without a time is due at 17:00 in the map's zone, as a typed date is. */
export const dayInstant=(day:string,tz:string)=>zonedTime(new Date(`${day}T17:00:00Z`),tz).toISOString();
export interface Limits { maxTitle:number; maxNote:number }

export function unitFields(u:Unit,doc:Doc,limits:Limits):Fields {
  return {
    // Compared at the service's length, so a longer opsmap title does not count as a difference every cycle.
    title:u.title.slice(0,limits.maxTitle),
    due:u.dueAt?localDay(new Date(u.dueAt),doc.settings.tz):null,
    note:(u.note??'').slice(0,limits.maxNote).trim(),
    progress:threat(u)?Math.round(100-(u.strength??100)):null,
    status:u.lifecycle==='done'||u.lifecycle==='dropped'?'done':u.lifecycle,
    sector:u.sectorId,
    affiliation:u.affiliation,
  };
}
/** The sector a task's container stands for, or null when it is in none of the map's. */
export const sectorOf=(doc:Doc,container:string|null)=>container===null?null:doc.sectors.find(s=>s.remote===container)?.id??null;
/** A remote task's fields as opsmap reads them. `u`: its linked unit, when it has one. */
export function taskFields(t:RemoteTask,u:Unit|undefined,doc:Doc,limits:Limits):Fields {
  return {
    title:t.title,due:t.due,
    // Compared at opsmap's length: a longer description is not a difference once its start is on the unit.
    note:t.note.slice(0,limits.maxNote).trim(),
    progress:u&&threat(u)?Math.round((t.progress??0)*100):null,
    status:t.status,
    // A subtask the service keeps under its parent, not in a container, has no opinion on the sector.
    sector:t.container===null&&t.parent!==null&&u?u.sectorId:sectorOf(doc,t.container),
    // No identity, or several: no opinion (the unit's identity is written back as the one).
    affiliation:t.affiliations.length===1?t.affiliations[0]:null,
  };
}
export interface Merge { merged:Fields; pull:Partial<Fields>; push:boolean }
/** Merges one linked unit (U) with its task (T) against the agreed values (B). Only `declared` fields merge; the others
 *  keep the unit's value. `remoteProgress`: the task's progress (0–1), read as BDA when the winning identity is a threat.
 *  `completion`: status is not declared only because the map switched state off, so completion still merges. */
export function mergeFields(U:Fields,T:Fields,B:Fields|undefined,unitNewer:boolean,remoteProgress:number|null,declared:ReadonlySet<Field>,completion=false):Merge {
  // State switched off (D21) on a service that has it: only open against done merges; to do, active and blocked are all open.
  if(completion&&!declared.has('status')) {
    const fold=(f:Fields):Fields=>({...f,status:f.status==='done'?'done':'todo'});
    const r=mergeFields(fold(U),fold(T),B&&fold(B),unitNewer,remoteProgress,new Set([...declared,'status']));
    if(r.pull.status===undefined)r.merged.status=U.status;
    return r;
  }
  T={...T};
  // A task in a state opsmap does not track has no opinion on it, except that it is open (reopened into a column of the user's own).
  if(T.status===null){const fallback=B?.status??U.status;T.status=fallback==='done'?'todo':fallback;}
  if(T.affiliation===null)T.affiliation=B?.affiliation??U.affiliation;
  let push=false;
  // A task outside the map's containers goes back to its unit's sector.
  if(T.sector===null){T.sector=U.sector;if(declared.has('sector'))push=true;}
  for(const key of FIELDS)if(!declared.has(key))(T as unknown as Record<string,unknown>)[key]=U[key];
  // No agreed values yet (a task just linked by its title): a filled-in value beats an empty one, so nothing is
  // wiped; otherwise, and when both sides changed, the newer side wins.
  const blank=(v:unknown)=>v===null||v===''||v===0;
  const choose=(key:Field):'ours'|'theirs'=>{
    const ours=U[key],theirs=T[key];
    if(B){if(ours===B[key])return 'theirs';if(theirs===B[key])return 'ours';}
    else if(blank(ours)!==blank(theirs))return blank(ours)?'theirs':'ours';
    return unitNewer?'ours':'theirs';
  };
  // Identity first: whether the task's progress counts as BDA depends on the identity that wins.
  const identity=U.affiliation===T.affiliation?U.affiliation:choose('affiliation')==='ours'?U.affiliation:T.affiliation;
  if(identity!==U.affiliation&&declared.has('progress'))T.progress=identity==='hostile'||identity==='suspect'?Math.round((remoteProgress??0)*100):null;
  const merged={...U},pull:Partial<Fields>={};
  for(const key of FIELDS) {
    if(U[key]===T[key])continue;
    if(choose(key)==='ours'){if(key!=='affiliation')push=true;}
    else{(merged as unknown as Record<string,unknown>)[key]=T[key];(pull as Record<string,unknown>)[key]=T[key];}
  }
  return {merged,pull,push};
}
