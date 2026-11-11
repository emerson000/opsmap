import type { Doc } from './types';
import { emptyDoc } from './seed';
// v2: the server owns the document. The sync client (src/lib/sync) writes the presented doc here;
// nothing is persisted from this module (the v1 key opsmap.doc.v1 stays untouched for "Import my local map").
let doc=$state<Doc>(emptyDoc());
/** What the inspector shows: a unit, a control measure (OBJ, EA, NAI or PL) or a sector. */
export type SelKind='unit'|'measure'|'sector';
export interface Sel {kind:SelKind;id:string}
class Selection {
 sel=$state<Sel|null>(null);
 hoveredId=$state<string|null>(null);
 /** A section of the open view to scroll to and open (for example 'beyond' in a sector); null for none. */
 section=$state<string|null>(null);
 /** The selected unit; null when nothing or another kind is selected. Presence, the parser and the map read this. */
 get selectedId():string|null {return this.sel?.kind==='unit'?this.sel.id:null;}
 set selectedId(id:string|null) {this.sel=id?{kind:'unit',id}:null;this.section=null;}
}
export const selection=new Selection();
/** Select an object (null clears), optionally at one of its sections. */
export function select(sel:Sel|null,section:string|null=null):void {selection.sel=sel;selection.section=section;}
export function getDoc():Doc {return doc;}
export function setDoc(next:Doc):void {doc=next;}
