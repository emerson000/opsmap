import { writable } from 'svelte/store';
import type { Command } from '../model/types';
import { getDoc, setDoc, selection } from '../model/store.svelte';
import { exportJson } from '../model/persist';
import { apply } from './apply';
import { parse, VK_REQUESTS } from './grammar';
import { undo, redo, record, cloneDoc, undoLabel } from './undo';
import { sitrepText } from './sitrep';
import { turnDetails, turnState } from './turn';
import { noteCommand } from './recent.svelte';
import { resolveMap } from './resolve';
export type DispatchResult={ok:true;log:string}|{ok:false;error:string;at?:number};
export interface CommandEvent {sequence:number;cmd:Command;text?:string;unitId?:string;}
/** Shell actions (copy, file picker, pan, help, SITREP) are handled by the UI subscriber. */
export const commandEvents=writable<CommandEvent|null>(null);
let sequence=0;
/** v2: when a remote (the sync client) is installed, doc changes go to the server instead of local undo. */
export interface Remote {
 submit(cmd:Command):{ok:true;log:string;local:boolean}|{ok:false;error:string};
 request(kind:'undo'|'redo'):{ok:true;log:string}|{ok:false;error:string};
 setView(view:string):void;
 /** /vk bind, sync, status: answered later; the remote shows the answer. */
 vk?(args:Record<string,unknown>):void;
 /** /map: the server's maps, and opening one (false when it cannot switch now; it says why). */
 maps?():readonly {id:string;name:string}[];
 openMap?(id:string):boolean;
}
/** /find selects what it found: a unit, a control measure or a sector. */
function found(a:Record<string,unknown>):void {selection.sel=a.measure!==undefined?{kind:'measure',id:String(a.measure)}:a.sectorId!==undefined?{kind:'sector',id:String(a.sectorId)}:{kind:'unit',id:String(a.unit)};selection.section=null;}
let remote:Remote|null=null;
export function useRemote(next:Remote|null):void {remote=next;}
function dispatchRemote(r:Remote,cmd:Command):DispatchResult {
 const emit=(text?:string)=>commandEvents.set({sequence:++sequence,cmd,text,unitId:typeof cmd.args.unit==='string'?cmd.args.unit:undefined});
 if(cmd.verb==='undo'||cmd.verb==='redo'){const res=r.request(cmd.verb);if(res.ok)emit();return res;}
 if(cmd.verb==='view'){
  if(!['commander','staff','detail'].includes(String(cmd.args.view)))return {ok:false,error:'Invalid view'};
  r.setView(String(cmd.args.view));emit();return {ok:true,log:`VIEW ${String(cmd.args.view).toUpperCase()}`};
 }
 if(cmd.verb==='vk'&&(VK_REQUESTS as readonly string[]).includes(String(cmd.args.action))){
  if(!r.vk)return {ok:false,error:'Vikunja sync is not configured on this server'};
  r.vk(cmd.args);emit();
  return {ok:true,log:`VIKUNJA ${String(cmd.args.action).toUpperCase()}${cmd.args.name?` ${String(cmd.args.name).toUpperCase()}`:''} — asking Vikunja…`};
 }
 if(cmd.verb==='map'){
  if(!r.maps||!r.openMap)return {ok:false,error:'/map is not available here'};
  const all=r.maps();if(cmd.args.name===undefined){emit();return {ok:true,log:`MAPS: ${all.map(m=>m.name).join(', ')}`};}
  const found=resolveMap(String(cmd.args.name),all);if(!r.openMap(found.id))return {ok:false,error:'Map not opened'};
  emit();return {ok:true,log:`MAP ${found.name.toUpperCase()}`};
 }
 // Import is an admin HTTP call (POST /api/import); the shell handles both forms.
 if(cmd.verb==='import'){emit();return {ok:true,log:'IMPORT'};}
 const res=r.submit(cmd);
 if(!res.ok)return res;
 const now=new Date();
  if(cmd.verb==='find')found(cmd.args);
 emit(cmd.verb==='export'?exportJson(getDoc()):cmd.verb==='sitrep'?sitrepText(getDoc(),now):undefined);
 return {ok:true,log:res.log};
}
export function dispatch(cmd:Command):DispatchResult {
 const res=dispatchAny(cmd);
 if(res.ok&&cmd.verb!=='undo'&&cmd.verb!=='redo')noteCommand(cmd,res.log);
 return res;
}
function dispatchAny(cmd:Command):DispatchResult {
 if(remote){try {return dispatchRemote(remote,cmd);}catch(error){return {ok:false,error:error instanceof Error?error.message:'Command failed'};}}
 try {
  if(cmd.verb==='undo'||cmd.verb==='redo'){
   const previous=undoLabel()??getDoc().log.at(-1)?.text;
   const ok=cmd.verb==='undo'?undo():redo();
   if(!ok)return {ok:false,error:`Nothing to ${cmd.verb}`};
   Object.assign(turnState,turnDetails(getDoc()));
   commandEvents.set({sequence:++sequence,cmd,text:previous});return {ok:true,log:cmd.verb==='undo'?`UNDONE: ${previous??'last change'}`:`REDONE: ${getDoc().log.at(-1)?.text??'last change'}`};
  }
  if(cmd.verb==='map')return {ok:false,error:'/map is not available here'};
  const now=cmd.verb==='turn'&&typeof cmd.args.now==='string'?new Date(cmd.args.now):new Date();
  const before=getDoc(),result=apply(before,cmd,now);
  if('error'in result)return {ok:false,error:result.error};
  if(result.doc!==before){record(before,result.doc,result.log);setDoc(cloneDoc(result.doc));}
  if(cmd.verb==='find')found(cmd.args);
  if(cmd.verb==='turn')Object.assign(turnState,turnDetails(getDoc()));
  const text=cmd.verb==='export'?exportJson(getDoc()):cmd.verb==='sitrep'?sitrepText(getDoc(),now):undefined;
  commandEvents.set({sequence:++sequence,cmd,text,unitId:typeof cmd.args.unit==='string'?cmd.args.unit:undefined});
  return {ok:true,log:result.log};
 }catch(error){return {ok:false,error:error instanceof Error?error.message:'Command failed'};}
}
export function dispatchText(input:string):DispatchResult {
 const result=parse(input,getDoc());return result.ok?dispatch(result.cmd):result;
}
