import type { Doc } from '../../core/model/types';
import { parse as parseCore, type ParseContext } from '../../core/commands/grammar';
import { selection } from '../model/store.svelte';
import { features } from '../model/features.svelte';
export * from '../../core/commands/grammar';
export function parse(input:string,doc:Doc,context:ParseContext={} ) {
 return parseCore(input,doc,{selectedId:selection.selectedId,vikunja:features.vikunja!==null,...context});
}
