<script lang="ts">
  // Create a unit, an OBJ / EA / NAI, a phase line or a sector in the sidebar. The form builds the command
  // (`/new …`, `/obj add …`, `/pl add …`, `/sector add …`), shows its text and what the parser makes of it,
  // and Create runs that text exactly as the command bar would.
  import { untrack } from 'svelte';
  import type { Command, Doc, Ring } from '../../../core/model/types';
  import { parseDate } from '../../../core/commands/tokenize';
  import { parse } from '../../commands/grammar';
  import { runCommand, type CreateRequest } from '../shell.svelte';
  import { AFFILIATIONS, RINGS } from '../words';
  import { slotFor, tryFormat } from '../verbs';
  import { AREA_RINGS, plRingNote, ringDate } from './place';
  import { echoes } from './echo';

  let { doc, now, req, fixedSector = false, onclose }: {
    doc: Doc; now: Date;
    /** What to create, and the sector and ring to start from. */
    req: CreateRequest;
    /** The sector is the view's own (a sector view): it shows, but does not change. */
    fixedSector?: boolean;
    onclose: () => void;
  } = $props();

  const TITLE: Record<CreateRequest['kind'], string> = { unit: 'New unit', area: 'New area', pl: 'New phase line', sector: 'New sector' };
  const tz = $derived(doc.settings.tz);
  let name = $state('');
  let type = $state<'obj' | 'ea' | 'nai'>('obj');
  let identity = $state('');
  let sectorId = $state('');
  let ring = $state<Ring | ''>('');
  let date = $state('');
  let due = $state('');
  let first: HTMLInputElement | undefined = $state();
  // A new request (another button, or the capture menu) starts a fresh form.
  $effect(() => {
    const r = req;
    untrack(() => {
      name = ''; identity = ''; due = '';
      sectorId = r.sectorId ?? doc.sectors[0]?.id ?? '';
      ring = r.ring && r.ring !== 'beyond' ? r.ring : '';
      date = r.kind === 'pl' ? ringDate(r.ring, now) : '';
    });
    queueMicrotask(() => first?.focus());
  });

  function day(value: string): string | undefined {
    if (!value) return undefined;
    try { return parseDate(value, now, tz); } catch { return undefined; }
  }
  /** The Command the form describes, or null while a required field is empty. */
  const cmd = $derived.by((): Command | null => {
    const n = name.trim();
    if (!n) return null;
    switch (req.kind) {
      case 'unit': {
        const dueAt = day(due);
        return { verb: 'new', args: { ...(identity ? { affiliation: identity } : {}), title: n, sectorId, ...(ring ? { ring } : {}), ...(dueAt ? { dueAt } : {}) } };
      }
      case 'area': return { verb: type, args: { action: 'add', name: n, sectorId, ...(ring ? { ring } : {}) } };
      case 'pl': { const d = day(date); return d ? { verb: 'pl', args: { action: 'add', name: n, date: d } } : null; }
      case 'sector': return { verb: 'sector', args: { action: 'add', name: n } };
    }
    return null;
  });
  const text = $derived(cmd ? tryFormat(cmd, doc) : null);
  /** What the command bar would say about this text: its log line, or its error. */
  const check = $derived.by(() => {
    if (!text) return null;
    const p = parse(text, doc);
    return p.ok ? { ok: true, text: p.preview } : { ok: false, text: p.error };
  });
  const entry = $derived(req.kind === 'unit' ? slotFor('new', undefined, 'map') : req.kind === 'area' ? slotFor(type, 'add', 'map') : req.kind === 'pl' ? slotFor('pl', 'add', 'map') : slotFor('sector', 'add', 'map'));
  const placeholder = $derived(req.kind === 'unit' ? 'What is it? (title)' : req.kind === 'sector' ? 'Sector name' : 'Name');
  const sectorName = $derived(doc.sectors.find(s => s.id === sectorId)?.name ?? '');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!cmd || !check?.ok) return;
    if (runCommand(cmd).ok) onclose();
  }
</script>

<form class="create" data-testid="new-{req.kind}" aria-label={TITLE[req.kind]} onsubmit={submit} use:echoes={text}>
  <div class="cap head"><span>{TITLE[req.kind]}</span>{#if entry}<code class="code">/{entry.verb}{entry.form ? ` ${entry.form}` : ''}</code>{/if}</div>
  {#if req.kind === 'area'}
    <div class="seg" role="radiogroup" aria-label="Type">
      {#each [['obj', 'OBJ', 'Objective'], ['ea', 'EA', 'Engagement area'], ['nai', 'NAI', 'Named area of interest']] as [k, short, long] (k)}
        <button type="button" class="btn" role="radio" aria-checked={type === k} class:on={type === k} title={long} onclick={() => (type = k as typeof type)}>{short}</button>
      {/each}
    </div>
  {/if}
  <label class="row"><span class="lab">{req.kind === 'unit' ? 'Title' : 'Name'}</span>
    <input class="field" bind:this={first} bind:value={name} {placeholder} aria-label={req.kind === 'unit' ? 'Title' : 'Name'} />
  </label>
  {#if req.kind === 'unit'}
    <label class="row"><span class="lab">Identity</span>
      <select class="field" bind:value={identity} aria-label="Identity">
        <option value="">Pending (decide later)</option>
        {#each AFFILIATIONS.filter(a => a.key !== 'pending') as a (a.key)}<option value={a.key}>{a.label}</option>{/each}
      </select>
    </label>
  {/if}
  {#if req.kind === 'unit' || req.kind === 'area'}
    <label class="row"><span class="lab">Sector</span>
      {#if fixedSector}<span class="fixed">{sectorName}</span>
      {:else}
        <select class="field" bind:value={sectorId} aria-label="Sector">
          {#each doc.sectors as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
        </select>
      {/if}
    </label>
    <label class="row"><span class="lab">Ring</span>
      <select class="field" bind:value={ring} aria-label="Ring">
        <option value="">{req.kind === 'unit' ? 'From the due date' : 'Default (close)'}</option>
        {#each (req.kind === 'unit' ? RINGS : AREA_RINGS) as r (r.key)}<option value={r.key}>{r.label} · {r.horizon}</option>{/each}
      </select>
    </label>
  {/if}
  {#if req.kind === 'unit'}
    <label class="row"><span class="lab">Due</span><input class="field" type="date" bind:value={due} aria-label="Due date" /></label>
  {/if}
  {#if req.kind === 'pl'}
    <label class="row"><span class="lab">Date</span><input class="field" type="date" bind:value={date} aria-label="Phase line date" /></label>
    <p class="note" data-testid="new-pl-ring">{plRingNote(day(date), now, tz)}</p>
  {/if}
  <code class="preview" aria-live="polite">{#if text}› {text}{:else}› Fill in the {req.kind === 'unit' ? 'title' : 'name'}{/if}</code>
  {#if check}<p class="check" class:bad={!check.ok}>{check.ok ? '✓' : '✕'} {check.text}</p>{/if}
  <div class="buttons">
    <button class="btn primary" type="submit" disabled={!check?.ok}>Create</button>
    <button class="btn" type="button" onclick={onclose}>Cancel</button>
  </div>
</form>

<style>
  .create { display: flex; flex-direction: column; gap: var(--s1); margin: 0 0 var(--s2); padding: var(--s2); border: 1px solid var(--rule-strong); background: var(--panel); }
  .head { display: flex; justify-content: space-between; align-items: baseline; }
  .code { font: 400 11px/1.3 var(--font-mono); letter-spacing: 0; text-transform: none; color: var(--ink-3); }
  .seg { display: flex; }
  .seg .btn { flex: 1; justify-content: center; }
  .seg .btn + .btn { margin-left: -1px; }
  .row { display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; gap: var(--s2); }
  .lab { font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
  .fixed { font-size: 13px; }
  .note { margin: 0 0 0 80px; font-size: 12px; color: var(--ink-2); }
  .preview { font: 400 11px/1.4 var(--font-mono); color: var(--ink-2); overflow-wrap: anywhere; }
  .check { margin: 0; font-size: 12px; color: var(--ok); overflow-wrap: anywhere; }
  .check.bad { color: var(--hostile); }
  .buttons { display: flex; gap: var(--s1); }
  .buttons .btn { flex: 1; justify-content: center; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .btn.primary:disabled { opacity: 0.45; }
  :global([data-tier='phone']) .row { grid-template-columns: 1fr; gap: 2px; }
  :global([data-tier='phone']) .note { margin-left: 0; }
</style>
