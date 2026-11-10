import type { Doc } from '../../core/model/types';
import { seedDoc } from '../../core/model/seed';
import { importJson, exportJson } from '../../core/model/json';
export { importJson, exportJson } from '../../core/model/json';
export const STORAGE_KEY='opsmap.doc.v1';
let pending:ReturnType<typeof setTimeout>|undefined;
function write(key:string,value:string):void {try {globalThis.localStorage?.setItem(key,value);} catch { /* A full or disabled browser store must not break the map. */ }}
export function save(doc:Doc):void {
  const snapshot=exportJson(doc);
  if(pending!==undefined) clearTimeout(pending);
  pending=setTimeout(()=>{pending=undefined;write(STORAGE_KEY,snapshot);},300);
}
export function load():Doc {
  let raw:string|null=null;
  try {raw=globalThis.localStorage?.getItem(STORAGE_KEY)??null;} catch {return seedDoc(new Date());}
  if(raw===null) return seedDoc(new Date());
  try {return importJson(raw);} catch {
    write(`opsmap.doc.corrupt.${Date.now()}`,raw);
    const doc=seedDoc(new Date());write(STORAGE_KEY,exportJson(doc));return doc;
  }
}
