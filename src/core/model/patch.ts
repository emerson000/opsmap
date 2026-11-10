import type { Doc, EntityCollection, InversePatch, TopField, Touched } from './types';
import { cloneDoc } from './clone';
import { importJson } from './json';

const collections = ['units','orders','measures','sectors'] as const;
const topFields = ['version','intent','lastTurn','settings'] as const;
const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);

/** Compare the whole result to include indirect changes (demotions, boundary moves, turns). */
export function touchedEntities(before:Doc,after:Doc):Touched {
  const touched:Touched={units:[],orders:[],measures:[],sectors:[],top:[]};
  for(const key of collections) {
    const old=new Map<string,unknown>(before[key].map(value=>[value.id,value]));
    const next=new Map<string,unknown>(after[key].map(value=>[value.id,value]));
    touched[key]=[...new Set([...old.keys(),...next.keys()])].filter(id=>!same(old.get(id),next.get(id)));
  }
  touched.top=topFields.filter(key=>!same(before[key],after[key]));
  return touched;
}

/** JSON-safe before-images; null means the entity or optional top field was absent. */
export function createInverse(before:Doc,touched:Touched):InversePatch {
  const source=cloneDoc(before);
  const images=<K extends EntityCollection>(key:K)=>touched[key].map(id=>{
    const index=source[key].findIndex(value=>value.id===id);
    return {id,index,value:index<0?null:source[key][index]};
  });
  const top:InversePatch['top']={};
  for(const key of touched.top) {
    if(!topFields.includes(key as TopField))throw new Error(`Invalid top field: ${key}`);
    top[key as TopField]=source[key as TopField]??null;
  }
  return {units:images('units'),orders:images('orders'),measures:images('measures'),sectors:images('sectors'),top} as InversePatch;
}

/** The hub resolves a revert's seq to a trusted inverse before calling apply. */
export function restoreInverse(original:Doc,input:unknown):Doc {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid inverse patch');
  const patch=input as InversePatch;
  const doc=cloneDoc(original);
  for(const key of collections) {
    if(!Array.isArray(patch[key]))throw new Error(`Invalid inverse ${key}`);
    const images=patch[key];
    const seen=new Set<string>();
    for(const image of images) {
      if(!image||typeof image.id!=='string'||seen.has(image.id)||!Number.isSafeInteger(image.index)||
        (image.value===null?image.index!==-1:image.index<0||!image.value||image.value.id!==image.id))throw new Error(`Invalid inverse ${key} image`);
      seen.add(image.id);
    }
    // Remove all touched entities, then put before-images back at their original positions.
    const restored=doc[key].filter(value=>!seen.has(value.id));
    for(const image of [...images].sort((a,b)=>a.index-b.index))if(image.value!==null)restored.splice(image.index,0,image.value);
    (doc[key] as typeof restored)=restored;
  }
  if(!patch.top||typeof patch.top!=='object'||Array.isArray(patch.top))throw new Error('Invalid inverse top');
  for(const [key,value] of Object.entries(patch.top)) {
    if(!topFields.includes(key as TopField))throw new Error(`Invalid inverse top field: ${key}`);
    if(value===null)delete (doc as unknown as Record<string,unknown>)[key];
    else (doc as unknown as Record<string,unknown>)[key]=value;
  }
  // Validate all references and types, and detach restored values from the inverse object.
  return importJson(JSON.stringify(doc));
}
