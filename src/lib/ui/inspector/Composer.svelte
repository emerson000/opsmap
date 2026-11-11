<script lang="ts">
  // The order composer: an order verb (a 3 × 2 radio grid; verbs that do not apply are struck through with the
  // reason), its target (a combobox ranked like the command bar, or ⌖ Map), the verb's options, and the command
  // it builds, slot by slot. Run sends that text through the command bar's own parse and dispatch.
  import { onMount, tick, untrack } from 'svelte';
  import type { Doc, Unit } from '../../../core/model/types';
  import { parse } from '../../commands/grammar';
  import { recentIds } from '../../commands/recent.svelte';
  import { prefill, runText, ui, type Compose, type PickSlot } from '../shell.svelte';
  import { enabledFor, slotFor } from '../verbs';
  import { dayMonth } from '../words';
  import { ORDER_VERBS, SLOT_HINT, draftSlots, draftText, isOrderVerb, optionFor, targetOptions, type Draft, type Option, type OrderVerb, type SlotKey } from '../compose';
  import Picker from './Picker.svelte';

  let { doc, unit, init }: { doc: Doc; unit: Unit; init: Compose } = $props();

  const LABEL: Record<OrderVerb, string> = { attack: 'Attack', moving: 'Moving', axis: 'Axis', support: 'Support', link: 'Link', advancing: 'Advancing' };
  const why = (v: OrderVerb): true | string => { const e = slotFor(v, undefined, 'unit'); return e ? enabledFor(e, { kind: 'unit', unit }, doc) : true; };

  const start = untrack(() => init);
  /** The verb asked for, else the usual one: a friendly attacks, a threat advances, anything else moves. */
  const usual: OrderVerb = untrack(() => unit.affiliation === 'hostile' || unit.affiliation === 'suspect' ? 'advancing' : unit.affiliation === 'friend' || unit.affiliation === 'assumed' ? 'attack' : 'moving');
  let verb = $state<OrderVerb>(untrack(() => [start.verb, usual, ...ORDER_VERBS].find((v): v is OrderVerb => isOrderVerb(v) && why(v) === true) ?? 'moving'));
  const options = $derived(targetOptions(verb, unit, doc, recentIds(doc)));
  let chosen = $state<Option | null>(null);
  let query = $state('');
  let role = $state<'' | 'main' | 'support'>('');
  let planned = $state(false);
  let via = $state<string[]>(untrack(() => start.via?.filter(id => doc.measures.some(m => m.id === id && m.type === 'pl')) ?? []));
  let kind = $state<'' | 'dependency' | 'handoff'>('');
  let focusSlot = $state<SlotKey | null>(null);
  let runError = $state('');
  let reason = $state('');
  let el: HTMLDivElement | undefined = $state();
  let targetInput: HTMLInputElement | undefined = $state();

  untrack(() => {
    if (!start.target) return;
    const o = optionFor(start.target, targetOptions(verb, unit, doc, recentIds(doc)));
    if (o) { chosen = o; query = o.label; }
  });
  // A verb change keeps the target when the new verb offers it too.
  $effect(() => {
    const opts = options;
    untrack(() => { if (chosen && !opts.some(o => o.key === chosen!.key)) { chosen = null; query = ''; } });
  });
  $effect(() => { void verb; void chosen; void query; void role; void planned; void via; void kind; runError = ''; });

  const target = $derived(chosen ? chosen.text : query.trim());
  const draft = $derived<Draft>({ verb, unit, target, role, planned, via, kind });
  const slots = $derived(draftSlots(draft, doc));
  const text = $derived(draftText(draft, doc));
  /** The slot to underline: the focused one, else the first required slot still empty. */
  const activeSlot = $derived(focusSlot ?? (target ? null : 'target'));
  const result = $derived(target ? parse(text, doc) : null);
  const pickSlots = (): PickSlot[] => slots.map(s => ({ text: s.text, state: s.key === 'target' ? 'active' : s.filled ? 'filled' : 'empty' }));
  const pls = $derived(doc.measures.filter(m => m.type === 'pl'));

  function close() { ui.compose = null; }
  function chooseVerb(v: OrderVerb) {
    const w = why(v);
    if (w !== true) { reason = w; return; }
    reason = ''; verb = v;
  }
  function runIt() {
    if (!target) { runError = 'Choose a target first.'; targetInput?.focus(); return; }
    const res = runText(text, true);
    if (res.ok) close(); else runError = res.error;
  }
  function toBar() { prefill(text); close(); }
  function keys(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Enter') return;
    const t = e.target as HTMLElement;
    if (!(e.ctrlKey || e.metaKey) && t.closest('button, select, a')) return;
    e.preventDefault();
    if (e.shiftKey) toBar(); else runIt();
  }
  function radioKeys(e: KeyboardEvent, list: readonly string[], at: number, set: (i: number) => void) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = (at + step + list.length) % list.length;
    set(i);
    void tick().then(() => (e.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus());
  }
  function moveVia(i: number, step: number) {
    const j = i + step;
    if (j < 0 || j >= via.length) return;
    const next = [...via];
    [next[i], next[j]] = [next[j], next[i]];
    via = next;
    void tick().then(() => el?.querySelectorAll<HTMLElement>('[data-testid="composer-via"] li')[j]?.focus());
  }
  onMount(() => {
    // After the Orders section has opened and the target list has rendered: the composer's top at the top of the sidebar.
    // (Scroll the sidebar itself: scrollIntoView would also scroll the fixed app shell.)
    requestAnimationFrame(() => { const box = el?.closest<HTMLElement>('.scroll'); if (el && box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8; });
    if (!chosen) targetInput?.focus({ preventScroll: true });
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="composer" data-testid="composer" role="group" aria-label="New order for {unit.designation}" bind:this={el} onkeydown={keys}>
  <div class="ch">
    <span class="cap">New order · {unit.designation}</span>
    <button class="x" type="button" aria-label="Close the order composer" title="Cancel (Esc)" onclick={close}>✕</button>
  </div>

  <div class="verbs" role="radiogroup" aria-label="Order">
    {#each ORDER_VERBS as v, i (v)}
      {@const w = why(v)}
      <button type="button" role="radio" class="btn verb" class:on={verb === v} class:off={w !== true} aria-checked={verb === v}
        aria-disabled={w !== true ? 'true' : undefined} title={w === true ? `/${v} ${slotFor(v, undefined, 'unit')?.slots.join(' ')}` : w}
        tabindex={verb === v ? 0 : -1} data-testid="composer-verb" data-verb={v}
        onclick={() => chooseVerb(v)} onkeydown={(e) => radioKeys(e, ORDER_VERBS, i, (j) => chooseVerb(ORDER_VERBS[j]))}>{LABEL[v]}{#if w !== true}<span class="sr-only">: {w}</span>{/if}</button>
    {/each}
  </div>
  {#if reason}<p class="reason" role="status">{reason}</p>{/if}

  <div class="row">
    <span class="lab" class:act={activeSlot === 'target'}>Target</span>
    <div class="ctl">
      <Picker items={options} bind:value={query} chosen={chosen?.key ?? null} bind:input={targetInput} label="Target" placeholder="hq, a unit…"
        testid="composer-target" mapTestid="composer-pick-map" pickLabel="Pick target" {pickSlots}
        onchoose={(o) => { chosen = o; query = o.label; }} oninput={() => (chosen = null)}
        onfocus={() => (focusSlot = 'target')} />
    </div>
  </div>

  {#if verb === 'attack'}
    {@const roles = ['', 'main', 'support'] as const}
    <div class="row">
      <span class="lab" class:act={activeSlot === 'role'}>Role</span>
      <div class="seg" role="radiogroup" aria-label="Attack role" data-testid="composer-role">
        {#each roles as r, i (r)}
          <button type="button" role="radio" class="btn" class:on={role === r} aria-checked={role === r} tabindex={role === r ? 0 : -1}
            title={r ? `${r === 'main' ? 'Main attack: the old main in this sector becomes support' : 'Supporting attack'} (${r})` : 'Leave it out: the bar makes it the main attack'}
            onfocus={() => (focusSlot = 'role')} onblur={() => (focusSlot = null)}
            onclick={() => (role = r)} onkeydown={(e) => radioKeys(e, roles, i, (j) => (role = roles[j]))}>{r === '' ? 'Auto' : r === 'main' ? 'Main' : 'Support'}</button>
        {/each}
      </div>
    </div>
    <div class="row">
      <span class="lab" class:act={activeSlot === 'planned'}>Flags</span>
      <label class="check"><input type="checkbox" bind:checked={planned} data-testid="composer-planned" onfocus={() => (focusSlot = 'planned')} onblur={() => (focusSlot = null)} /> Planned (dashed)</label>
    </div>
  {:else if verb === 'axis'}
    <div class="row">
      <span class="lab" class:act={activeSlot === 'via'}>Via</span>
      <div class="ctl">
        {#if via.length}
          <ol class="via" data-testid="composer-via" aria-label="Phase lines in order (Alt+↑ or Alt+↓ to reorder)">
            {#each via as id, i (id)}
              {@const m = doc.measures.find(x => x.id === id)}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <li tabindex="0" onfocus={() => (focusSlot = 'via')} onblur={() => (focusSlot = null)}
                onkeydown={(e) => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveVia(i, e.key === 'ArrowUp' ? -1 : 1); } }}>
                <span class="n">{i + 1}</span><span class="name">PL {m?.name ?? id}</span>{#if m?.date}<span class="detail">{dayMonth(m.date)}</span>{/if}
                <button type="button" class="x" aria-label="Earlier: PL {m?.name}" title="Earlier (Alt+↑)" disabled={i === 0} onclick={() => moveVia(i, -1)}>↑</button>
                <button type="button" class="x" aria-label="Later: PL {m?.name}" title="Later (Alt+↓)" disabled={i === via.length - 1} onclick={() => moveVia(i, 1)}>↓</button>
                <button type="button" class="x" aria-label="Remove from via: PL {m?.name}" onclick={() => (via = via.filter(x => x !== id))}>✕</button>
              </li>
            {/each}
          </ol>
        {/if}
        {#if pls.some(m => !via.includes(m.id))}
          <select class="field" aria-label="Add a phase line to via" data-testid="composer-via-add" value=""
            onfocus={() => (focusSlot = 'via')} onblur={() => (focusSlot = null)}
            onchange={(e) => { const id = e.currentTarget.value; e.currentTarget.value = ''; if (id) via = [...via, id]; }}>
            <option value="">+ Phase line…</option>
            {#each pls.filter(m => !via.includes(m.id)) as m (m.id)}<option value={m.id}>PL {m.name}{m.date ? ` · ${dayMonth(m.date)}` : ''}</option>{/each}
          </select>
        {:else if !pls.length}<span class="muted">No phase lines on this map.</span>{/if}
      </div>
    </div>
  {:else if verb === 'link'}
    {@const kinds = ['', 'dependency', 'handoff'] as const}
    <div class="row">
      <span class="lab" class:act={activeSlot === 'kind'}>As</span>
      <div class="seg" role="radiogroup" aria-label="Link kind" data-testid="composer-kind">
        {#each kinds as k, i (k)}
          <button type="button" role="radio" class="btn" class:on={kind === k} aria-checked={kind === k} tabindex={kind === k ? 0 : -1}
            onfocus={() => (focusSlot = 'kind')} onblur={() => (focusSlot = null)}
            onclick={() => (kind = k)} onkeydown={(e) => radioKeys(e, kinds, i, (j) => (kind = kinds[j]))}>{k === '' ? 'Linkup' : k === 'dependency' ? 'Dependency' : 'Handoff'}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="foot">
    <div class="preview" data-testid="composer-preview" aria-live="polite">
      <code class="slots">{#each slots as s, i (i)}{i ? ' ' : ''}<span class="slot" class:verb={s.key === 'verb'} class:empty={!s.filled} class:active={s.key === activeSlot}>{s.text}</span>{/each}</code>
      {#if runError}<div class="effect err">✕ {runError}</div>
      {:else if result?.ok}<div class="effect ok">✓ {result.preview}</div>
      {:else if result}<div class="effect err">✕ {result.error}</div>
      {:else}<div class="effect hint">{SLOT_HINT[verb]}</div>{/if}
    </div>
    <div class="actions">
      <button type="button" class="btn primary" data-testid="composer-run" title="Run it (Enter)" onclick={runIt}>Run <span class="k" aria-hidden="true">⏎</span></button>
      <button type="button" class="btn" data-testid="composer-to-bar" title="Put it in the command bar to edit (Shift+Enter)" onclick={toBar}>To bar <span class="k" aria-hidden="true">⇧⏎</span></button>
      <button type="button" class="btn" onclick={close}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .composer { margin-top: var(--s2); border: 1px solid var(--rule-strong); border-left: 3px solid var(--accent); background: var(--panel); }
  .ch { display: flex; align-items: center; justify-content: space-between; padding: var(--s1) var(--s2); border-bottom: 1px solid var(--rule); }
  .cap { font: 700 12px/1.3 var(--font-cond); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }
  .x { flex: none; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .x:hover:not(:disabled) { color: var(--ink); border-color: var(--ink); }
  .x:disabled { opacity: 0.35; }
  .verbs { display: grid; grid-template-columns: repeat(3, 1fr); margin: var(--s2); }
  .verb { justify-content: center; margin: 0 -1px -1px 0; padding: 0 2px; letter-spacing: 0.06em; }
  .verb.off { text-decoration: line-through; color: var(--ink-3); cursor: not-allowed; }
  .verb.on { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .reason { margin: 0 var(--s2) var(--s2); font-size: 12px; color: var(--ink-2); }
  .row { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: var(--s2); align-items: start; padding: 2px var(--s2); }
  .lab { padding-top: 5px; font: 600 12px/1.2 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
  .lab.act { color: var(--accent-ink, var(--ink)); text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 3px; }
  .ctl { min-width: 0; }
  .seg { display: flex; }
  .seg .btn { flex: 1; justify-content: center; margin-right: -1px; padding: 0 4px; }
  .check { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: 12px; }
  .muted { color: var(--ink-3); font-size: 12px; }
  .via { margin: 0 0 var(--s1); padding: 0; list-style: none; }
  .via li { display: flex; align-items: center; gap: var(--s1); padding: 2px 0; border-bottom: 1px dotted var(--rule); font-size: 12px; }
  .via li:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .via .n { font: 700 11px/1 var(--font-mono); color: var(--ink-3); width: 12px; }
  .via .name { flex: 1; font: 600 12px/1.2 var(--font-mono); color: var(--pl, var(--ink)); }
  .via .detail { color: var(--ink-3); font-family: var(--font-mono); }
  :global([data-tier='tablet']) .via .detail { display: none; }
  .via .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .foot { margin-top: var(--s2); padding: var(--s2); border-top: 1px solid var(--rule); background: var(--panel-2); }
  .preview { font: 400 12px/1.45 var(--font-mono); }
  .slots { display: block; overflow-wrap: anywhere; color: var(--ink); }
  .slot.verb { font-weight: 700; color: var(--accent-ink, var(--ink)); }
  .slot.empty { color: var(--ink-3); }
  .slot.active { text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 3px; }
  .effect { margin-top: 2px; overflow-wrap: anywhere; }
  .effect.ok { color: var(--ok); }
  .effect.err { color: var(--hostile); }
  .effect.hint { color: var(--ink-2); font-family: var(--font-sans, inherit); }
  .actions { display: flex; gap: var(--s1); margin-top: var(--s2); }
  .actions .btn { flex: 1; justify-content: center; padding: 0 4px; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .k { margin-left: 4px; opacity: 0.7; font-family: var(--font-mono); letter-spacing: 0; }
  /* Phone: 44 px targets, and the preview with Run / To bar / Cancel stays pinned at the bottom of the sheet. */
  :global([data-tier='phone']) .composer .btn { min-height: 44px; }
  :global([data-tier='phone']) .composer .x { width: 44px; height: 44px; }
  :global([data-tier='phone']) .row { grid-template-columns: 1fr; gap: 2px; }
  /* The sidebar body has 12 px of padding at the bottom: the foot pins to its very edge. */
  :global([data-tier='phone']) .foot { position: sticky; bottom: calc(-1 * var(--s3)); z-index: 1; box-shadow: 0 -4px 10px rgba(0, 0, 0, 0.12); }
  :global([data-tier='phone']) .slots { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  :global([data-tier='phone']) .check { min-height: 44px; font-size: 16px; }
</style>
