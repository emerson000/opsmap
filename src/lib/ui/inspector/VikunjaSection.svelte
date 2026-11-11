<script lang="ts">
  // Vikunja sync for the map, from the Situation or a sector view: the sector's project link, Sync and Status,
  // and Bind / Unbind (which act on the whole map). Shown only when the server has Vikunja; without a connected
  // account every verb is disabled and says how to connect.
  import type { Command, Doc, Sector } from '../../../core/model/types';
  import { features } from '../../model/features.svelte';
  import { runCommand, ui } from '../shell.svelte';
  import { slotFor, tryFormat, type ObjKind } from '../verbs';
  import { loadVkAccount, vkAccount } from '../vikunja.svelte';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import { echoes } from './echo';

  let { doc, kind, sector }: { doc: Doc; kind: ObjKind; sector?: Sector } = $props();

  $effect(() => { if (features.vikunja) loadVkAccount(); });
  const bound = $derived(doc.settings.vikunja);
  const vk = (action: string, args: Record<string, unknown> = {}): Command => ({ verb: 'vk', args: { action, ...args } });
  const slot = (form: string) => slotFor('vk', form, kind);
  /** Why the verbs cannot run now, or null. */
  const noAccount = $derived(vkAccount.connected === null ? 'Checking your Vikunja account…' : vkAccount.connected ? null : 'Connect your Vikunja account: user menu → Vikunja…');
  const unboundWhy = $derived(bound ? null : 'This map is not bound to Vikunja: Bind… first');
  let binding = $state(false);
  let unbinding = $state(false);
  let project = $state('');
  const bindText = $derived(tryFormat(vk('bind', { name: project.trim() || '‹project›' }), doc));

  function go(cmd: Command, why: string | null) { if (!why) runCommand(cmd); }
</script>

{#if features.vikunja}
  <Section {kind} key="vikunja" title="Vikunja" open={false} summary={bound ? `bound to ${bound.title}` : 'not bound'}>
    {#if sector?.vk}
      <a class="vk-project" data-testid="vk-project" href="{features.vikunja.url}/projects/{sector.vk}" target="_blank" rel="noopener noreferrer">Project #{sector.vk} ↗</a>
    {/if}
    <p class="note">Map: {#if bound}bound to <b>{bound.title}</b>{:else}not bound{/if}. Bind and unbind act on the whole map{sector ? ', not only this sector' : ''}: each sector is one child project.</p>
    {#if noAccount}
      <p class="why" data-testid="vk-why">{noAccount} <button class="link" type="button" onclick={() => (ui.vikunjaOpen = true)}>Vikunja…</button></p>
    {/if}
    {#each [['sync', 'Sync now'], ['status', 'Status']] as [form, label] (form)}
      {@const why = noAccount ?? unboundWhy}
      {@const t = tryFormat(vk(form), doc)}
      <Field label={label} entry={slot(form)} cmd={t}>
        <button class="btn" type="button" data-testid="vk-{form}" aria-disabled={why ? 'true' : undefined} title={why ?? t ?? undefined} use:echoes={t} onclick={() => go(vk(form), why)}>{label}</button>
      </Field>
    {/each}
    <Field label="Map link" entry={bound ? slot('unbind') : slot('bind')} cmd={bound ? tryFormat(vk('unbind'), doc) : bindText}>
      {#if bound}
        {@const t = tryFormat(vk('unbind'), doc)}
        <button class="btn" type="button" data-testid="vk-unbind" aria-disabled={noAccount ? 'true' : undefined} aria-expanded={unbinding} title={noAccount ?? t ?? undefined} use:echoes={t}
          onclick={() => { if (!noAccount) unbinding = !unbinding; }}>Unbind…</button>
        {#if unbinding}
          <div class="confirm" role="alertdialog" aria-label="Unbind the map">
            <p>Unbind the whole map from {bound.title}? Sync stops for every sector.</p>
            <button class="btn" type="button" onclick={() => (unbinding = false)}>Keep</button>
            <button class="btn warn" type="button" onclick={() => { unbinding = false; runCommand(vk('unbind')); }}>Unbind</button>
          </div>
        {/if}
      {:else}
        <button class="btn" type="button" data-testid="vk-bind" aria-disabled={noAccount ? 'true' : undefined} aria-expanded={binding} title={noAccount ?? bindText ?? undefined} use:echoes={bindText}
          onclick={() => { if (!noAccount) binding = !binding; }}>Bind…</button>
        {#if binding}
          <form class="inline" onsubmit={(e) => { e.preventDefault(); if (project.trim()) { runCommand(vk('bind', { name: project.trim() })); binding = false; project = ''; } }}>
            <input class="field" bind:value={project} placeholder="Vikunja project" aria-label="Vikunja project" />
            <button class="btn" type="submit" disabled={!project.trim()}>Bind</button>
          </form>
        {/if}
      {/if}
    </Field>
  </Section>
{/if}

<style>
  .vk-project { display: inline-block; margin-bottom: var(--s1); font-size: 12px; color: var(--ink); }
  .note, .why { margin: 0 0 var(--s1); font-size: 12px; color: var(--ink-2); }
  .why { color: var(--ink-3); }
  .btn[aria-disabled='true'] { opacity: 0.45; cursor: default; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: inherit; }
  .inline { display: flex; gap: var(--s1); margin-top: var(--s1); }
  .inline .field { flex: 1; min-width: 0; }
  .confirm { margin-top: var(--s1); padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; }
  .confirm p { margin: 0 0 var(--s1); }
</style>
