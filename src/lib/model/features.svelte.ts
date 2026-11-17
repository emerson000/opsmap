import type { ProviderInfo } from '../../core/commands/grammar';
// What this server offers beyond the core map, from the welcome frame.
export const features = $state<{ vikunja: { url: string } | null }>({ vikunja: null });
/** The task services the grammar and autocomplete offer. Built from the Vikunja feature until the server sends
 *  provider descriptors. */
export function taskProviders(): ProviderInfo[] {
  return features.vikunja ? [{ id: 'vikunja', label: 'Vikunja', aliases: ['vk'], rootNoun: 'project' }] : [];
}
