<script lang="ts">
  // Task sync for the map, from the Situation or a sector view: the sector's container link, Sync and Status, and
  // Bind / Unbind (which act on the whole map). Shown only when the server has a task service; without a connected
  // account every verb is disabled and says how to connect. Names and links come from the service's descriptor.
  import type { Command, Doc, Sector } from '../../../core/model/types';
  import { features, serviceUrl, taskService } from '../../model/features.svelte';
  import { runCommand, ui } from '../shell.svelte';
  import { slotFor, tryFormat, type ObjKind } from '../verbs';
  import { loadTaskAccount, taskAccounts } from '../taskAccounts.svelte';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import { echoes } from './echo';

  let { doc, kind, sector }: { doc: Doc; kind: ObjKind; sector?: Sector } = $props();

  const bound = $derived(doc.settings.taskSync);
  /** The bound service, else the first one the server has (the bind form names it). */
  const service = $derived(taskService(bound?.provider) ?? features.taskSync[0]);
  $effect(() => { if (service) loadTaskAccount(service.id); });
  const label = $derived(bound?.label ?? service?.label ?? 'Task sync');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tasks = (action: string, args: Record<string, unknown> = {}): Command => ({ verb: 'tasks', args: { action, ...args } });
  const slot = (form: string) => slotFor('tasks', form, kind);
  const connected = $derived(service ? taskAccounts[service.id] : null);
  /** Why the verbs cannot run now, or null. */
  const noAccount = $derived(connected === null || connected === undefined ? `Checking your ${label} account…` : connected ? null : `Connect your ${label} account: user menu → ${label}…`);
  const unboundWhy = $derived(bound ? null : `This map is not bound to ${label}: Bind… first`);
  let binding = $state(false);
  let unbinding = $state(false);
  let project = $state('');
  const bindArgs = (name: string) => ({ provider: service?.id, name });
  const bindText = $derived(tryFormat(tasks('bind', bindArgs(project.trim() || `‹${service?.rootNoun ?? 'project'}›`)), doc));
  const containerLink = $derived(service?.urls.container && sector?.remote && bound ? serviceUrl(service.urls.container, { root: bound.root, container: sector.remote }) : null);

  function go(cmd: Command, why: string | null) { if (!why) runCommand(cmd); }
</script>

{#if service}
  <Section {kind} key="tasks" title={label} open={false} summary={bound ? `bound to ${bound.title}` : 'not bound'}>
    {#if containerLink && sector?.remote}
      <a class="container-link" data-testid="tasks-container" href={containerLink} target="_blank" rel="noopener noreferrer">{cap(service.containerNoun)} #{sector.remote} ↗</a>
    {/if}
    <p class="note">Map: {#if bound}bound to <b>{bound.title}</b>{:else}not bound{/if}. Bind and unbind act on the whole map{sector ? ', not only this sector' : ''}: each sector is its own {service.containerNoun}.</p>
    {#if noAccount}
      <p class="why" data-testid="tasks-why">{noAccount} <button class="link" type="button" onclick={() => (ui.taskAccountOpen = service.id)}>{label}…</button></p>
    {/if}
    {#each [['sync', 'Sync now'], ['status', 'Status']] as [form, text] (form)}
      {@const why = noAccount ?? unboundWhy}
      {@const t = tryFormat(tasks(form), doc)}
      <Field label={text} entry={slot(form)} cmd={t}>
        <button class="btn" type="button" data-testid="tasks-{form}" aria-disabled={why ? 'true' : undefined} title={why ?? t ?? undefined} use:echoes={t} onclick={() => go(tasks(form), why)}>{text}</button>
      </Field>
    {/each}
    <Field label="Map link" entry={bound ? slot('unbind') : slot('bind')} cmd={bound ? tryFormat(tasks('unbind'), doc) : bindText}>
      {#if bound}
        {@const t = tryFormat(tasks('unbind'), doc)}
        <button class="btn" type="button" data-testid="tasks-unbind" aria-disabled={noAccount ? 'true' : undefined} aria-expanded={unbinding} title={noAccount ?? t ?? undefined} use:echoes={t}
          onclick={() => { if (!noAccount) unbinding = !unbinding; }}>Unbind…</button>
        {#if unbinding}
          <div class="confirm" role="alertdialog" aria-label="Unbind the map">
            <p>Unbind the whole map from {bound.title}? Sync stops for every sector.</p>
            <button class="btn" type="button" onclick={() => (unbinding = false)}>Keep</button>
            <button class="btn warn" type="button" onclick={() => { unbinding = false; runCommand(tasks('unbind')); }}>Unbind</button>
          </div>
        {/if}
      {:else}
        <button class="btn" type="button" data-testid="tasks-bind" aria-disabled={noAccount ? 'true' : undefined} aria-expanded={binding} title={noAccount ?? bindText ?? undefined} use:echoes={bindText}
          onclick={() => { if (!noAccount) binding = !binding; }}>Bind…</button>
        {#if binding}
          <form class="inline" onsubmit={(e) => { e.preventDefault(); if (project.trim()) { runCommand(tasks('bind', bindArgs(project.trim()))); binding = false; project = ''; } }}>
            <input class="field" bind:value={project} placeholder="{service.label} {service.rootNoun}" aria-label="{service.label} {service.rootNoun}" />
            <button class="btn" type="submit" disabled={!project.trim()}>Bind</button>
          </form>
        {/if}
      {/if}
    </Field>
  </Section>
{/if}

<style>
  .container-link { display: inline-block; margin-bottom: var(--s1); font-size: 12px; color: var(--ink); }
  .note, .why { margin: 0 0 var(--s1); font-size: 12px; color: var(--ink-2); }
  .why { color: var(--ink-3); }
  .btn[aria-disabled='true'] { opacity: 0.45; cursor: default; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: inherit; }
  .inline { display: flex; gap: var(--s1); margin-top: var(--s1); }
  .inline .field { flex: 1; min-width: 0; }
  .confirm { margin-top: var(--s1); padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; }
  .confirm p { margin: 0 0 var(--s1); }
</style>
