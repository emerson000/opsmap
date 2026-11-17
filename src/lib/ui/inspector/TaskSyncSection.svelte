<script lang="ts">
  // Task sync for the map, from the Situation or a sector view. Bound: the project (root) link and how changes arrive
  // (the delivery mode) come first, then the sector's container link, Sync now and Status, one switch per field the
  // service syncs, and Unbind. Not bound: Bind…, with the fields to sync. Bind and Unbind act on the whole map. Shown
  // only when the server has a task service; without a connected account the server verbs say how to connect.
  // Names, nouns, fields and links come from the service's descriptor.
  import { SYNC_FIELDS, type Command, type Doc, type Sector, type SyncField } from '../../../core/model/types';
  import { features, taskService } from '../../model/features.svelte';
  import { checkTaskDelivery, live } from '../../sync/sync.svelte';
  import { runCommand, ui } from '../shell.svelte';
  import { slotFor, tryFormat, type ObjKind } from '../verbs';
  import { loadTaskAccount, taskAccountWhy, taskSyncWhy } from '../taskAccounts.svelte';
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
  const serviceLabel = $derived(bound?.label ?? service?.label ?? 'the task service');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tasks = (action: string, args: Record<string, unknown> = {}): Command => ({ verb: 'tasks', args: { action, ...args } });
  const slot = (form: string) => slotFor('tasks', form, kind);
  /** Why Bind and Unbind cannot run now (no account), and why Sync and Status cannot (no account, or not bound). */
  const noAccount = $derived(taskAccountWhy(service?.id, serviceLabel));
  const syncWhy = $derived(taskSyncWhy(service?.id, serviceLabel, Boolean(bound)));

  // The delivery mode comes with the /tasks status answer: asked quietly when the view opens, when the binding
  // changes and when the section body opens (deliveryLine), so it does not go stale.
  const boundKey = $derived(bound && !noAccount ? `${live.mapId}:${bound.provider}:${bound.root}` : '');
  $effect(() => { if (boundKey) checkTaskDelivery(); });
  const deliveryLine = (_node: HTMLElement) => { if (boundKey) checkTaskDelivery(); };
  const delivery = $derived(bound ? live.taskDelivery : null);

  /** The switches this service has (D21), in SYNC_FIELDS order. */
  const fields = $derived(service ? SYNC_FIELDS.filter(f => service.fields.includes(f)) : []);
  const isOn = (f: SyncField) => !bound?.off?.includes(f);
  const fieldCmd = (f: SyncField) => tasks('field', { field: f, on: !isOn(f) });

  let binding = $state(false);
  let unbinding = $state(false);
  let project = $state('');
  /** Fields to sync in the bind form: all checked at first; an unchecked one goes into `without`. */
  let unchecked = $state<SyncField[]>([]);
  const without = $derived(fields.filter(f => unchecked.includes(f)));
  const bindArgs = (name: string) => ({ provider: service?.id, name, ...(without.length ? { off: without } : {}) });
  const bindText = $derived(tryFormat(tasks('bind', bindArgs(project.trim() || `‹${service?.rootNoun ?? 'project'}›`)), doc));
  const rootLink = $derived(service && bound ? rootUrl(service, bound.root) : null);
  const containerLink = $derived(service && sector?.remote && bound ? containerUrl(service, bound.root, sector.remote) ?? null : null);

  function go(cmd: Command, why: string | null) { if (!why) runCommand(cmd); }
  function openBind() {
    if (noAccount) return;
    binding = !binding;
    unchecked = [];
  }
  function bind(e: SubmitEvent) {
    e.preventDefault();
    if (!project.trim()) return;
    runCommand(tasks('bind', bindArgs(project.trim())));
    binding = false; project = ''; unchecked = [];
  }
  function keep(f: SyncField, on: boolean) { unchecked = on ? unchecked.filter(x => x !== f) : [...unchecked, f]; }
</script>

{#if service}
  <Section {kind} key="tasks" title="Task sync" open={false} summary={bound ? `${bound.label}: ${bound.title}` : 'not bound'}>
    {#if bound}
      <Field label={cap(service.rootNoun)} cmd={null}>
        <span class="bound">
          {#if rootLink}<a class="ext" data-testid="tasks-root" href={rootLink} target="_blank" rel="noopener noreferrer" title="Open {bound.title} in {bound.label}">{bound.title} ↗</a>{:else}<b>{bound.title}</b>{/if}
          <span class="via">in {bound.label}</span>
        </span>
      </Field>
      {#if delivery}
        <p class="delivery" class:live={delivery.mode === 'live'} data-testid="tasks-delivery" data-mode={delivery.mode} title={delivery.reason} use:deliveryLine>{delivery.summary}</p>
      {:else}
        <p class="delivery pending" data-testid="tasks-delivery" data-mode="" use:deliveryLine>Checking delivery…</p>
      {/if}
      {#if containerLink && sector}
        <Field label={cap(service.containerNoun)} cmd={null}>
          <a class="ext" data-testid="tasks-container" href={containerLink} target="_blank" rel="noopener noreferrer" title="Open the {sector.name} {service.containerNoun} in {bound.label}">{sector.name} ↗</a>
        </Field>
      {/if}
    {/if}
    {#if noAccount}
      <p class="why" data-testid="tasks-why">{noAccount} <button class="link" type="button" data-opens="task-account" title="Open your {serviceLabel} account: paste a token" onclick={() => (ui.taskAccountOpen = service.id)}>{serviceLabel}…</button></p>
    {/if}
    {#if bound}
      {@const ts = tryFormat(tasks('sync'), doc)}
      {@const tt = tryFormat(tasks('status'), doc)}
      <Field label="Sync" entry={slot('sync')} cmd={ts}>
        <div class="pair">
          <button class="btn" type="button" data-testid="tasks-sync" aria-disabled={syncWhy ? 'true' : undefined} title={syncWhy ?? ts ?? undefined} use:echoes={ts} onclick={() => go(tasks('sync'), syncWhy)}>Sync now</button>
          <button class="btn" type="button" data-testid="tasks-status" aria-disabled={syncWhy ? 'true' : undefined} title={syncWhy ?? tt ?? undefined} use:echoes={tt} onclick={() => go(tasks('status'), syncWhy)}>Status</button>
        </div>
      </Field>
      {#if fields.length}
        <Field label="Sync fields" entry={slot('field')} wide cmd={null}>
          <div class="switches" role="group" aria-label="Fields synced with {bound.label}">
            {#each fields as f (f)}
              {@const on = isOn(f)}
              {@const t = tryFormat(fieldCmd(f), doc)}
              <div class="sw-row" title={t ?? undefined} use:echoes={t}>
                <span class="sw-label" id="tasks-field-{kind}-{f}">{FIELD_LABEL[f]}<span class="sw-hint">{FIELD_HINT[f]}</span></span>
                <button class="knob-btn" type="button" role="switch" aria-checked={on} aria-labelledby="tasks-field-{kind}-{f}" data-testid="tasks-field-{f}" data-field={f}
                  title={t ?? undefined} onclick={() => runCommand(fieldCmd(f))}><span class="knob"></span></button>
              </div>
            {/each}
          </div>
          {#if bound.off?.length}<span class="hint">Not synced: {bound.off.map(f => FIELD_LABEL[f]).join(', ')}. Opsmap keeps its own values.</span>{/if}
        </Field>
      {/if}
    {/if}
    <Field label="Map link" entry={bound ? slot('unbind') : slot('bind')} cmd={bound ? tryFormat(tasks('unbind'), doc) : bindText}>
      {#if bound}
        {@const t = tryFormat(tasks('unbind'), doc)}
        <button class="btn" type="button" data-testid="tasks-unbind" class:on={unbinding} aria-disabled={noAccount ? 'true' : undefined} aria-expanded={unbinding} title={noAccount ?? t ?? undefined} use:echoes={t}
          onclick={() => { if (!noAccount) unbinding = !unbinding; }}>Unbind…</button>
        {#if unbinding}
          <div class="confirm" role="alertdialog" aria-label="Unbind the map">
            <p>Unbind the whole map from {bound.title}? Sync stops for every sector.</p>
            <button class="btn" type="button" onclick={() => (unbinding = false)}>Keep</button>
            <button class="btn warn" type="button" title={t ?? undefined} onclick={() => { unbinding = false; runCommand(tasks('unbind')); }}>Unbind</button>
          </div>
        {/if}
      {:else}
        <button class="btn" type="button" data-testid="tasks-bind" class:on={binding} aria-disabled={noAccount ? 'true' : undefined} aria-expanded={binding} title={noAccount ?? bindText ?? undefined} use:echoes={bindText}
          onclick={openBind}>Bind…</button>
        {#if binding}
          <form class="bind" data-testid="tasks-bind-form" onsubmit={bind}>
            <div class="inline">
              <input class="field" bind:value={project} placeholder="{service.label} {service.rootNoun}" aria-label="{service.label} {service.rootNoun}" />
              <button class="btn" type="submit" disabled={!project.trim()} title={bindText ?? undefined} use:echoes={bindText}>Bind</button>
            </div>
            {#if fields.length}
              <fieldset class="synced" title="An unchecked field is left out: {bindText}">
                <legend>Fields to sync</legend>
                {#each fields as f (f)}
                  <label title="{FIELD_LABEL[f]}: {FIELD_HINT[f]}"><input type="checkbox" checked={!unchecked.includes(f)} onchange={(e) => keep(f, e.currentTarget.checked)} />{FIELD_LABEL[f]}</label>
                {/each}
              </fieldset>
            {/if}
          </form>
        {/if}
      {/if}
      <span class="hint">Bind and unbind act on the whole map{sector ? ', not only this sector' : ''}: each sector is its own {service.containerNoun}.</span>
    </Field>
  </Section>
{/if}

<style>
  .bound { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s1); font-size: 13px; }
  .via { font-size: 12px; color: var(--ink-3); }
  .ext { color: var(--ink); font-weight: 600; text-underline-offset: 2px; }
  .delivery { margin: 0 0 var(--s2); font-size: 12px; color: var(--ink); }
  .delivery.pending { color: var(--ink-3); }
  .delivery::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; border: 1px solid var(--ink-2); vertical-align: 1px; }
  .delivery.pending::before { border-color: var(--ink-3); }
  .delivery.live::before { background: var(--friend); border-color: var(--friend); }
  .why { margin: 0 0 var(--s1); font-size: 12px; color: var(--ink-3); }
  .btn[aria-disabled='true'] { opacity: 0.45; cursor: default; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: inherit; }
  .pair { display: flex; flex-wrap: wrap; gap: var(--s1); }
  .switches { display: flex; flex-direction: column; }
  .sw-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); min-height: 32px; border-bottom: 1px dotted var(--rule); }
  .sw-row:last-child { border-bottom: 0; }
  .sw-label { display: flex; flex-direction: column; font-size: 13px; font-weight: 600; color: var(--ink); }
  .sw-hint { font-size: 11px; font-weight: 400; color: var(--ink-3); }
  /* The knob switch, as the Legend's single-key switch. */
  .knob-btn { position: relative; flex: none; width: 36px; height: 20px; padding: 0; border: 1px solid var(--rule-strong); border-radius: 10px; background: var(--panel-2); }
  .knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--ink-3); transition: left 120ms ease-out; }
  .knob-btn[aria-checked='true'] { background: var(--accent-bg); border-color: var(--accent); }
  .knob-btn[aria-checked='true'] .knob { left: 18px; background: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .knob { transition: none; } }
  .hint { display: block; margin-top: var(--s1); font-size: 12px; color: var(--ink-3); }
  .bind { margin-top: var(--s1); }
  .inline { display: flex; gap: var(--s1); }
  .inline .field { flex: 1; min-width: 0; }
  .synced { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 2px var(--s2); margin: var(--s1) 0 0; padding: 0; border: 0; font-size: 12px; color: var(--ink-2); }
  .synced legend { padding: 0; margin-bottom: 2px; font-size: 12px; color: var(--ink-3); }
  .synced label { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; }
  .synced input { accent-color: var(--ink); }
  .confirm { margin-top: var(--s1); padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; }
  .confirm p { margin: 0 0 var(--s1); }
  :global([data-tier='phone']) .synced label, :global([data-tier='phone']) .sw-row { min-height: 44px; }
  :global([data-tier='phone']) .knob-btn { width: 52px; height: 32px; border-radius: 16px; }
  :global([data-tier='phone']) .knob { width: 24px; height: 24px; top: 3px; left: 3px; }
  :global([data-tier='phone']) .knob-btn[aria-checked='true'] .knob { left: 23px; }
  :global([data-tier='phone']) .ext, :global([data-tier='phone']) .link { display: inline-flex; align-items: center; min-height: 44px; }
</style>
