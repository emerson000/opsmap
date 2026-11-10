import type { Doc } from './types';
export function cloneDoc(doc:Doc):Doc {return JSON.parse(JSON.stringify(doc)) as Doc;}
