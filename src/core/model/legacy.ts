// Before task sync was provider-neutral, maps were bound to Vikunja only: verb `vk` with numeric ids, and documents
// with settings.vikunja, Sector.vk and Unit.vk. The journal still holds those ops and replays them; this file is the
// only place in the core that knows the old shape.
import type { Command } from './types';
/** The verb the journal's old task sync ops carry. */
export const LEGACY_VERB='vk';
/** A positive integer becomes its decimal string; anything else is left as is, so apply() refuses it as before. */
const id=(v:unknown):unknown=>Number.isSafeInteger(v)&&(v as number)>0?String(v):v;
const ids=(v:unknown):unknown=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,x===null?null:id(x)])):v;
/** A recorded `vk` command as the `tasks` command it means today; other commands are returned unchanged. */
export function legacyCommand(cmd:Command):Command {
  if(cmd.verb!==LEGACY_VERB)return cmd;
  const {action,project,sectors,links,task,...rest}=cmd.args,args:Record<string,unknown>={action,...rest};
  if(action==='bound'){Object.assign(args,{provider:'vikunja',label:'Vikunja',root:id(project)});if(sectors!==undefined)args.containers=ids(sectors);}
  else if(action==='sectors'){args.action='containers';args.containers=ids(sectors);}
  if(links!==undefined)args.links=ids(links);
  if(task!==undefined)args.task=id(task);
  return {verb:'tasks',args,...(cmd.raw!==undefined?{raw:cmd.raw}:{})};
}
/** Removes the old Vikunja fields from a raw document before validation: a document never carries a binding in. */
export function stripLegacy(raw:Record<string,unknown>):void {
  const settings=raw.settings;if(settings&&typeof settings==='object')delete (settings as Record<string,unknown>).vikunja;
  for(const key of ['sectors','units'])if(Array.isArray(raw[key]))for(const x of raw[key] as unknown[])if(x&&typeof x==='object')delete (x as Record<string,unknown>).vk;
}
/** Before-images recorded with the old fields (in undo inverses and replayed reverts) get the neutral names: the
 *  map they belong to was bound to Vikunja then. */
export function upgradeLegacy(raw:Record<string,unknown>):void {
  const settings=raw.settings as Record<string,unknown>|undefined,old=settings?.vikunja as Record<string,unknown>|undefined;
  if(settings&&typeof settings==='object'&&old&&typeof old==='object'&&settings.taskSync===undefined)settings.taskSync={provider:'vikunja',label:'Vikunja',root:id(old.project),title:old.title,...(old.by!==undefined?{by:old.by}:{})};
  for(const key of ['sectors','units'])if(Array.isArray(raw[key]))for(const x of raw[key] as Record<string,unknown>[])if(x&&typeof x==='object'&&x.vk!==undefined&&x.remote===undefined)x.remote=id(x.vk);
  stripLegacy(raw);
}
