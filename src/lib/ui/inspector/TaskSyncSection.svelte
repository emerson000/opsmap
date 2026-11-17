<script lang="ts" module>
  /** The binding whose delivery mode was last asked for, so opening another view does not ask again. */
  let checked = '';
</script>

<script lang="ts">
  // Task sync for the map, from the Situation or a sector view: the sector's container link, how changes arrive (the
  // delivery mode), Sync and Status, one switch per field the service syncs, and Bind / Unbind (which act on the whole
  // map). Shown only when the server has a task service; without a connected account the server verbs are disabled
  // and say how to connect. Names, nouns, fields and links come from the service's descriptor.
  import { SYNC_FIELDS, type Command, type Doc, type Sector, type SyncField } from '../../../core/model/types';
  import { features, taskService } from '../../model/features.svelte';
  import { checkTaskDelivery, live } from '../../sync/sync.svelte';
  import { runCommand, ui } from '../shell.svelte';
  import { slotFor, tryFormat, type ObjKind } from '../verbs';
  import { loadTaskAccount, taskAccounts } from '../taskAccounts.svelte';
  import { containerUrl, rootUrl } from '../taskUrls';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import { echoes } from './echo';

  let { doc, kind, sector }: { doc: Doc; kind: ObjKind; sector?: Sector } = $props();

  const FIELD_LABEL: Record<SyncField, string> = { identity: 'Identity', state: 'State', due: 'Due', note: 'Note', progress: 'Progress' };
  const FIELD_HINT: Record<SyncField, string> = {
    identity: 'friend, hostile and the other identities, as tags or labels',
    state: 'doing and blocked', due: 'the due date', note: 'the note', progress: 'BDA progress',
  };

  const bound = $derived(doc.settings.taskSync);
  /** The bound service, else the first one the server has (the bind form names it). */
  const service = $derived(taskService(bound?.provider) ?? features.taskSync[0]);
  $effect(() => { if (service) loadTaskAccount(service.id); });
  const label = $derived(bound?.label ?? 'Task sync');
  const serviceLabel = $derived(bound?.label ?? service?.label ?? 'the task service');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tasks = (action: string, args: Record<string, unknown> = {}): Command => ({ verb: 'tasks', args: { action, ...args } });
  const slot = (form: string) => slotFor('tasks', form, kind);
  const connected = $derived(service ? taskAccounts[service.id] : null);
  /** Why the server verbs cannot run now, or null. */
  const noAccount = $derived(connected === null || connected === undefined ? `Checking your ${serviceLabel} account…` : connected ? null : `Connect your ${serviceLabel} account: user menu → ${serviceLabel}…`);
  const unboundWhy = $derived(bound ? null : `This map is not bound to ${serviceLabel}: Bind… first`);

  // The delivery mode comes with the /tasks status answer: ask once per binding, quietly.
  const boundKey = $derived(bound && connected ? `${live.mapId}:${bound.provider}:${bound.root}` : '');
  $effect(() => { if (boundKey && (boundKey !== checked || !live.taskDelivery)) { checked = boundKey; checkTaskDelivery(); } });
  const delivery = $derived(bound ? live.taskDelivery : null);

  /** The switches this service has (D21), in SYNC_FIELDS order. */
  const fields = $derived(service ? SYNC_FIELDS.filter(f => service.fields.includes(f)) : []);
  const isOn = (f: SyncField) => !bound?.off?.includes(f);
  const fieldCmd = (f: SyncField) => tasks('field', { field: f, on: !isOn(f) });

  let binding = $state(false);
  let unbinding = $state(false);
  let project = $state('');
  let without = $state<SyncField[]>([]);
  const bindArgs = (name: string) => ({ provider: service?.id, name, ...(without.length ? { off: SYNC_FIELDS.filter(f => without.includes(f)) } : {}) });
  const bindText = $derived(tryFormat(tasks('bind', bindArgs(project.trim() || `‹${service?.rootNoun ?? 'project'}›`)), doc));
  const rootLink = $derived(service && bound ? rootUrl(service, bound.root) : null);
  const containerLink = $derived(service && sector?.remote && bound ? containerUrl(service, bound.root, sector.remote) ?? null : null);

  function go(cmd: Command, why: string | null) { if (!why) runCommand(cmd); }
  function bind(e: SubmitEvent) {
    e.preventDefault();
    if (!project.trim()) return;
    runCommand(tasks('bind', bindArgs(project.trim())));
    binding = false; project = ''; without = [];
  }
  function leaveOut(f: SyncField, out: boolean) { without = out ? [...without, f] : without.filter(x => x !== f); }
</script>

{#if service}
  <Section {kind} key="tasks" title={label} open={false} summary={bound ? delivery?.summary ?? `bound to ${bound.title}` : 'not bound'}>
    {#if containerLink && sector}
      <a class="ext" data-testid="tasks-container" href={containerLink} target="_blank" rel="noopener noreferrer" title="{sector.name} in {serviceLabel}">{cap(service.containerNoun)} ↗</a>
    {/if}
    <p class="note">
      Map: {#if bound}bound to {#if rootLink}<a href={rootLink} target="_blank" rel="noopener noreferrer"><b>{bound.title}</b> ↗</a>{:else}<b>{bound.title}</b>{/if}{:else}not bound{/if}.
      Bind and unbind act on the whole map{sector ? ', not only this sector' : ''}: each sector is its own {service.containerNoun}.
    </p>
    {#if bound && delivery}
      <p class="delivery" class:live={delivery.mode === 'live'} data-testid="tasks-delivery" data-mode={delivery.mode} title={delivery.reason}>{delivery.summary}</p>
    {/if}
    {#if noAccount}
      <p class="why" data-testid="tasks-why">{noAccount} <button class="link" type="button" data-opens="task-account" title="Open your {serviceLabel} account: paste a token" onclick={() => (ui.taskAccountOpen = service.id)}>{serviceLabel}…</button></p>
    {/if}
    {#each [['sync', 'Sync now'], ['status', 'Status']] as [form, text] (form)}
      {@const why = noAccount ?? unboundWhy}
      {@const t = tryFormat(tasks(form), doc)}
      <Field label={text} entry={slot(form)} cmd={t}>
        <button class="btn" type="button" data-testid="tasks-{form}" aria-disabled={why ? 'true' : undefined} title={why ?? t ?? undefined} use:echoes={t} onclick={() => go(tasks(form), why)}>{text}</button>
      </Field>
    {/each}
    {#if bound && fields.length}
      <Field label="Sync fields" entry={slot('field')} wide cmd={null}>
        <div class="switches" role="group" aria-label="Fields synced with {bound.label}">
          {#each fields as f (f)}
            {@const on = isOn(f)}
            {@const t = tryFormat(fieldCmd(f), doc)}
            <button class="btn switch" class:on type="button" role="switch" aria-checked={on} data-testid="tasks-field-{f}" data-field={f}
              title={t ?? undefined} aria-label="{FIELD_LABEL[f]}: {FIELD_HINT[f]}" use:echoes={t} onclick={() => runCommand(fieldCmd(f))}>
              <span class="mark" aria-hidden="true">{on ? '✓' : '–'}</span>{FIELD_LABEL[f]}
            </button>
          {/each}
        </div>
        {#if bound.off?.length}<span class="hint">Not synced: {bound.off.join(', ')}. Opsmap keeps its own values.</span>{/if}
      </Field>
    {/if}
    <Field label="Map link" entry={bound ? slot('unbind') : slot('bind')} cmd={bound ? tryFormat(tasks('unbind'), doc) : bindText}>
      {#if bound}
        {@const t = tryFormat(tasks('unbind'), doc)}
        <button class="btn" type="button" data-testid="tasks-unbind" aria-disabled={noAccount ? 'true' : undefined} aria-expanded={unbinding} title={noAccount ?? t ?? undefined} use:echoes={t}
          onclick={() => { if (!noAccount) unbinding = !unbinding; }}>Unbind…</button>
        {#if unbinding}
          <div class="confirm" role="alertdialog" aria-label="Unbind the map">
            <p>Unbind the whole map from {bound.title}? Sync stops for every sector.</p>
            <button class="btn" type="button" onclick={() => (unbinding = false)}>Keep</button>
            <button class="btn warn" type="button" title={t ?? undefined} onclick={() => { unbinding = false; runCommand(tasks('unbind')); }}>Unbind</button>
          </div>
        {/if}
      {:else}
        <button class="btn" type="button" data-testid="tasks-bind" aria-disabled={noAccount ? 'true' : undefined} aria-expanded={binding} title={noAccount ?? bindText ?? undefined} use:echoes={bindText}
          onclick={() => { if (!noAccount) binding = !binding; }}>Bind…</button>
        {#if binding}
          <form class="bind" data-testid="tasks-bind-form" onsubmit={bind}>
            <div class="inline">
              <input class="field" bind:value={project} placeholder="{service.label} {service.rootNoun}" aria-label="{service.label} {service.rootNoun}" />
              <button class="btn" type="submit" disabled={!project.trim()} title={bindText ?? undefined} use:echoes={bindText}>Bind</button>
            </div>
            {#if service.fields.length}
              <fieldset class="without">
                <legend>Leave out <code>without</code></legend>
                {#each fields as f (f)}
                  <label title="{FIELD_LABEL[f]}: {FIELD_HINT[f]}"><input type="checkbox" checked={without.includes(f)} onchange={(e) => leaveOut(f, e.currentTarget.checked)} />{FIELD_LABEL[f]}</label>
                {/each}
              </fieldset>
            {/if}
          </form>
        {/if}
      {/if}
    </Field>
  </Section>
{/if}

<style>
  .ext { display: inline-block; margin-bottom: var(--s1); font-size: 12px; color: var(--ink); }
  .note, .why, .delivery { margin: 0 0 var(--s1); font-size: 12px; color: var(--ink-2); }
  .note a { color: inherit; }
  .why { color: var(--ink-3); }
  .delivery { font-family: var(--font-mono); color: var(--ink-2); }
  .delivery::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; border: 1px solid var(--ink-3); vertical-align: 1px; }
  .delivery.live::before { background: var(--friend); border-color: var(--friend); }
  .btn[aria-disabled='true'] { opacity: 0.45; cursor: default; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: inherit; }
  .switches { display: flex; flex-wrap: wrap; gap: var(--s1); }
  .switch { gap: 4px; }
  .switch:not(.on) { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-3); }
  .mark { display: inline-block; width: 1em; text-align: center; font-family: var(--font-mono); }
  .hint { display: block; margin-top: var(--s1); font-size: 12px; color: var(--ink-3); }
  .bind { margin-top: var(--s1); }
  .inline { display: flex; gap: var(--s1); }
  .inline .field { flex: 1; min-width: 0; }
  .without { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s2); margin: var(--s1) 0 0; padding: 0; border: 0; font-size: 12px; color: var(--ink-2); }
  .without legend { padding: 0; margin-bottom: 2px; font-size: 12px; color: var(--ink-3); }
  .without label { display: inline-flex; align-items: center; gap: 4px; }
  :global([data-tier='phone']) .without label { min-height: 44px; }
  :global([data-tier='phone']) .switch { min-height: 44px; }
  .confirm { margin-top: var(--s1); padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; }
  .confirm p { margin: 0 0 var(--s1); }
</style>
