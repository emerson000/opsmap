import type { ProviderInfo } from '../../core/commands/grammar';
import type { ProviderDescriptor } from '../sync/protocol';
// What this server offers beyond the core map, from the welcome frame: the task services it syncs with.
export const features = $state<{ taskSync: ProviderDescriptor[] }>({ taskSync: [] });
/** The task services as the grammar and autocomplete see them (ids, labels, aliases). */
export function taskProviders(): ProviderInfo[] {
  return features.taskSync.map(d => ({ id: d.id, label: d.label, aliases: d.aliases, rootNoun: d.rootNoun }));
}
/** The descriptor of a task service, by id. */
export function taskService(id: string | undefined): ProviderDescriptor | undefined {
  return id === undefined ? undefined : features.taskSync.find(d => d.id === id);
}
/** A descriptor URL template with {root}, {container} and {id} filled in. */
export function serviceUrl(template: string, values: { root?: string; container?: string; id?: string }): string {
  return template.replace(/\{(root|container|id)\}/g, (_, key: 'root' | 'container' | 'id') => encodeURIComponent(values[key] ?? ''));
}
