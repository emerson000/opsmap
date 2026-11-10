import type { Doc } from './types';
import { emptyDoc } from './seed';
// v2: the server owns the document. The sync client (src/lib/sync) writes the presented doc here;
// nothing is persisted from this module (the v1 key opsmap.doc.v1 stays untouched for "Import my local map").
let doc=$state<Doc>(emptyDoc());
export const selection=$state<{selectedId:string|null;hoveredId:string|null}>({selectedId:null,hoveredId:null});
export function getDoc():Doc {return doc;}
export function setDoc(next:Doc):void {doc=next;}
