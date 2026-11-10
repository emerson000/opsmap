import type { Doc } from '../model/types';
import { getDoc, setDoc } from '../model/store.svelte';
interface Entry {before:Doc;after:Doc;label?:string;}
const past:Entry[]=[],future:Entry[]=[];
import { cloneDoc } from '../../core/model/clone';
export { cloneDoc } from '../../core/model/clone';
export function record(before:Doc,after:Doc,label?:string):void {
  past.push({before:cloneDoc(before),after:cloneDoc(after),label});
  if(past.length>100)past.shift();
  future.length=0;
}
export function undo():boolean {
  const entry=past.at(-1);if(!entry)return false;
  // A reset or import made outside dispatch must never restore an unrelated document.
  if(JSON.stringify(getDoc())!==JSON.stringify(entry.after)){clearHistory();return false;}
  past.pop();future.push(entry);setDoc(cloneDoc(entry.before));return true;
}
export function redo():boolean {
  const entry=future.at(-1);if(!entry)return false;
  if(JSON.stringify(getDoc())!==JSON.stringify(entry.before)){clearHistory();return false;}
  future.pop();past.push(entry);setDoc(cloneDoc(entry.after));return true;
}
export function clearHistory():void {past.length=0;future.length=0;}

export function undoLabel():string|undefined {return past.at(-1)?.label;}
