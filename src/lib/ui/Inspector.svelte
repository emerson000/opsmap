<script lang="ts">
  // The sidebar (inspector): a kind strip, the view of whatever is selected (unit, area, phase line, sector, or
  // Situation when nothing is), and the echo bar with the command of the control under the pointer.
  import { tick } from 'svelte';
  import type { Doc } from '../../core/model/types';
  import { radiusForDate, ringForRadius } from '../../core/model/geometry';
  import { selection, select } from '../model/store.svelte';
  import { ui, env, runText, write, setAllSections, type Theme } from './shell.svelte';
  import { RINGS, ringOf } from './words';
  import { tryFormat } from './verbs';
  import UnitView from './inspector/UnitView.svelte';
  import AreaView from './inspector/AreaView.svelte';
  import PhaseLineView from './inspector/PhaseLineView.svelte';
  import SectorView from './inspector/SectorView.svelte';
  import SituationView from './inspector/SituationView.svelte';
  import EchoBar from './inspector/EchoBar.svelte';

  let { doc, now, theme, onfocus }: { doc: Doc; now: Date; theme: Theme; onfocus: (id: string) => void } = $props();

  const sel = $derived(selection.sel);
  const unit = $derived(sel?.kind === 'unit' ? doc.units.find(u => u.id === sel.id) : undefined);
  const measure = $derived(sel?.kind === 'measure' ? doc.measures.find(m => m.id === sel.id) : undefined);
  const sector = $derived(sel?.kind === 'sector' ? doc.sectors.find(s => s.id === sel.id) : undefined);
  /** The view shown; a selection whose object is gone (removed, or undone) shows Situation until it returns. */
  const kind = $derived(unit ? 'unit' : measure ? (measure.type === 'pl' ? 'pl' : 'area') : sector ? 'sector' : 'map');
  const KIND_TAG: Record<string, string> = { unit: 'Unit', pl: 'PL', sector: 'Sector', map: 'Situation' };
  const tag = $derived(kind === 'area' && measure ? measure.type.toUpperCase() : KIND_TAG[kind]);

  // The breadcrumb: the sector (a link to its view), then the ring as a glyph and a short name.
  const SHORT: Record<string, string> = { hq: 'HQ', near: 'Close', mid: 'Deep', far: 'AOI', beyond: 'Beyond' };
  const crumbSector = $derived(unit ? doc.sectors.find(s => s.id === unit.sectorId) : measure?.sectorId ? doc.sectors.find(s => s.id === measure.sectorId) : undefined);
  const crumbRing = $derived.by(() => {
    const key = unit ? ringOf(unit) : measure?.pos ? ringForRadius(measure.pos.r) : measure?.date ? ringForRadius(radiusForDate(measure.date, now, doc.settings.tz)) : null;
    const r = RINGS.find(x => x.key === key);
    return r ? { short: SHORT[r.key], full: `${r.label} ring · ${r.horizon}` } : null;
  });
  const span = $derived(sector ? `${String(Math.round(sector.startDeg) % 360).padStart(3, '0')}°–${String(Math.round(sector.startDeg + sector.widthDeg) % 360).padStart(3, '0')}° · ${Math.round(sector.widthDeg * 10) / 10}°` : '');

  /** Phone sheet at peek (portrait): no kind strip, so the header, status line and one action row fit 124 px. */
  const peek = $derived(env.tier === 'phone' && !env.landscape && ui.sheet === 'peek' && kind !== 'map');
  // Selecting an object closes the Situation view's create form.
  $effect(() => { if (selection.sel) ui.create = null; });

  // Phone at half or full: chips at the top that jump to each section of the open view.
  let bodyEl: HTMLDivElement | undefined = $state();
  let index = $state<{ key: string; title: string; count: string }[]>([]);
  const showIndex = $derived(env.tier === 'phone' && !peek && kind !== 'map');
  $effect(() => {
    const el = bodyEl;
    if (!el || !showIndex) { index = []; return; }
    const read = () => {
      const next = [...el.querySelectorAll<HTMLElement>('section[data-testid^="section-"], [data-testid="manage"]')].map(s => {
        const manage = s.dataset.testid === 'manage';
        return { key: manage ? 'manage' : s.dataset.testid!.slice('section-'.length), title: manage ? 'Manage' : s.querySelector('.title')?.textContent ?? '', count: s.querySelector('.count')?.textContent ?? '' };
      });
      if (JSON.stringify(next) !== JSON.stringify(index)) index = next;
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  });
  /** Another object opens in a fresh body, at its top (also while the phone sheet is hidden behind the command bar). */
  const selKey = $derived(sel ? `${sel.kind}:${sel.id}` : '');
  function jump(key: string) {
    if (key === 'manage') { bodyEl?.querySelector('[data-testid="manage"]')?.scrollIntoView({ block: 'start' }); return; }
    // Opens the section and scrolls to it (set again even when it was the last anchor).
    selection.section = null;
    void tick().then(() => { selection.section = key; });
  }

  function toggleCmd() { ui.cmdOn = !ui.cmdOn; write('opsmap.ui.cmd', ui.cmdOn ? 'on' : 'off'); }
  /** The /find text of what is open, for F and the header symbol. */
  const findText = $derived(unit ? tryFormat({ verb: 'find', args: { unit: unit.id } }, doc) : measure ? tryFormat({ verb: 'find', args: { measure: measure.id } }, doc) : sector ? tryFormat({ verb: 'find', args: { sectorId: sector.id } }, doc) : null);
  /**
   * Single-letter keys, while focus is in the sidebar and not in a field (Legend → Keys turns them off):
   * N gives the open unit an order, F finds the open object, C shows every command, [ and ] collapse and expand all sections.
   */
  function keys(e: KeyboardEvent) {
    if (!ui.singleKeys || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable], [role="combobox"]')) return;
    if (e.key === 'f' || e.key === 'F') { if (findText) { e.preventDefault(); runText(findText); } }
    else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); toggleCmd(); }
    else if ((e.key === 'n' || e.key === 'N') && unit && unit.lifecycle !== 'done' && unit.lifecycle !== 'dropped') { e.preventDefault(); ui.compose = { unit: unit.id }; }
    else if (e.key === '[' || e.key === ']') { e.preventDefault(); setAllSections(e.key === ']'); }
  }

  // Long-press on a control: its command in a bubble, without running it (on a phone this stands in for the tooltip).
  const LONG_PRESS = 500;
  let bubble = $state<{ text: string; x: number; y: number } | null>(null);
  let press: { timer: ReturnType<typeof setTimeout>; id: number; x: number; y: number } | null = null;
  let swallowClick = false;
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  function commandOf(el: Element): string | null {
    const own = el.closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    if (own) return own;
    const title = el.closest<HTMLElement>('[title]')?.title ?? '';
    const m = /(\/[a-z]+(?: [^()]*)?)\)?$/.exec(title);
    return m ? m[1] : null;
  }
  function pressStart(e: PointerEvent) {
    bubble = null;
    swallowClick = false;   // only the click that ends this press can be swallowed
    if (e.button !== 0) return;
    const el = (e.target as Element).closest?.('button, [role="radio"], [role="option"], label');
    const text = el ? commandOf(el) : null;
    if (!el || !text) return;
    endPress();
    const r = el.getBoundingClientRect();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      press = null;
      swallowClick = true;
      bubble = { text, x: Math.max(8, Math.min(r.left + r.width / 2, window.innerWidth - 8)), y: r.top };
      try { navigator.vibrate?.(10); } catch { /* not supported */ }
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => (bubble = null), 3500);
    }, LONG_PRESS) };
  }
  /** A press that travels is a scroll, not a long-press (moves of other pointers do not count). */
  function pressMove(e: PointerEvent) { if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) endPress(); }
  function endPress() { if (press) clearTimeout(press.timer); press = null; }
  /** The click that ends a long-press does not run the control. */
  function clickCapture(e: MouseEvent) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault(); e.stopPropagation();
  }
</script>

<svelte:window onpointerdown={(e) => { if (bubble && !(e.target as Element).closest?.('.inspector')) bubble = null; }} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
<aside class="inspector" class:peek aria-label="Inspector" data-testid="inspector" data-kind={kind} tabindex="-1" onkeydown={keys}
  onpointerdown={pressStart} onpointermove={pressMove} onpointerup={() => { endPress(); setTimeout(() => (swallowClick = false), 0); }} onpointercancel={endPress}
  onclickcapture={clickCapture} oncontextmenu={(e) => { if (press || bubble) e.preventDefault(); }}>
  {#if bubble}
    <div class="bubble" role="status" data-testid="cmd-bubble" style="left:{bubble.x}px; top:{bubble.y}px"><code>{bubble.text}</code></div>
  {/if}
  {#if peek}
    <button class="btn close peek-close" onclick={() => select(null)} aria-label="Close inspector">✕</button>
  {:else}
  <div class="strip">
    <span class="kind">{tag}</span>
    {#if kind === 'sector' && sector}
      <span class="crumbs"><span class="span">{span}</span></span>
    {:else if kind !== 'map'}
      <span class="crumbs">
        {#if crumbSector}<button class="crumb" onclick={() => select({ kind: 'sector', id: crumbSector.id })} title="Open sector {crumbSector.name}: {tryFormat({ verb: 'find', args: { sectorId: crumbSector.id } }, doc)}">{crumbSector.name}</button><span class="sep" aria-hidden="true">›</span>{/if}
        {#if crumbRing}<span class="ring" title={crumbRing.full} aria-label={crumbRing.full}><span aria-hidden="true">○</span><span class="ring-name" aria-hidden="true">{crumbRing.short}{#if env.tier === 'desktop'}{' ring'}{/if}</span></span>{/if}
      </span>
    {:else}
      <span class="crumbs"></span>
      {#if env.tier === 'phone'}<button class="btn" onclick={() => (ui.sitrepOpen = true)} data-testid="situation-sitrep">SITREP</button>{/if}
    {/if}
    <button class="btn cmd" class:on={ui.cmdOn} aria-pressed={ui.cmdOn} onclick={toggleCmd} data-testid="cmd-toggle" title="Show the command of every control (C)">/CMD</button>
    {#if kind !== 'map'}<button class="btn close" onclick={() => select(null)} aria-label="Close inspector">✕</button>{/if}
  </div>
  {/if}
  {#if index.length}
    <div class="index-row"><nav class="index" aria-label="Sections" data-testid="section-index">
      {#each index as s (s.key)}<button type="button" class="chip" onclick={() => jump(s.key)}>{s.title}{#if s.count && s.count !== '0'} <b>{s.count}</b>{/if}</button>{/each}
    </nav></div>
  {/if}
  {#key selKey}
  <div class="body scroll" bind:this={bodyEl}>
    {#if unit}
      <UnitView {doc} {unit} {now} {theme} {onfocus} />
    {:else if measure && measure.type === 'pl'}
      <PhaseLineView {doc} {measure} {now} {onfocus} />
    {:else if measure}
      <AreaView {doc} {measure} {now} {onfocus} />
    {:else if sector}
      <SectorView {doc} {sector} {now} {theme} {onfocus} />
    {:else}
      <SituationView {doc} {now} {theme} {onfocus} />
    {/if}
  </div>
  {/key}
  <!-- Portrait phone: only at full; at peek and half the command bar's own result line is enough. -->
  {#if !(env.tier === 'phone' && !env.landscape && ui.sheet !== 'full')}<EchoBar />{/if}
</aside>

<style>
  .inspector { height: 100%; display: flex; flex-direction: column; background: var(--panel-glass); border-left: 2px solid var(--rule-strong); }
  .inspector:focus { outline: none; }
  .inspector:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
  /* A long-press shows the command bubble, not the browser's callout or a text selection. */
  .inspector :global(button), .inspector :global([role='radio']) { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  .bubble {
    position: fixed; z-index: 40; transform: translate(-50%, calc(-100% - 8px)); max-width: min(320px, calc(100vw - 16px));
    padding: var(--s1) var(--s2); background: var(--ink); color: var(--panel); box-shadow: var(--shadow); pointer-events: none;
    font: 400 12px/1.4 var(--font-mono); overflow-wrap: anywhere;
  }
  .bubble code { color: inherit; }
  .strip { flex: none; display: flex; align-items: center; gap: 6px; min-height: 36px; padding: var(--s1) var(--s3); border-bottom: 1px solid var(--rule); }
  .kind { flex: none; padding: 1px 4px; border: 1px solid var(--rule-strong); font: 700 11px/14px var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink); }
  .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 3px; white-space: nowrap; font: 600 12px/1.2 var(--font-cond); letter-spacing: 0.02em; text-transform: uppercase; color: var(--ink-2); }
  .crumb { min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 0; border: 0; background: none; font: inherit; letter-spacing: inherit; text-transform: inherit; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; }
  .sep { flex: none; color: var(--ink-3); }
  .ring { flex: none; display: inline-flex; gap: 3px; }
  .span { font-family: var(--font-mono); letter-spacing: 0; text-transform: none; }
  /* Tablet (280 px column): the ring glyph alone, with its full name in the tooltip and accessible name. */
  :global([data-tier='tablet']) .ring-name { display: none; }
  /* Desktop: the breadcrumb in sentence case, "Household › ○ Close ring", so the ring does not read as a Close button beside ✕. */
  :global([data-tier='desktop']) .crumbs { text-transform: none; letter-spacing: 0; }
  .btn { flex: none; }
  .cmd { padding: 0 6px; font-family: var(--font-mono); letter-spacing: 0; text-transform: none; }
  .close { padding: 0 6px; }
  :global([data-tier='phone']) .close { width: 44px; height: 44px; justify-content: center; padding: 0; }
  /* The only scroll container; positioned, so visually hidden text inside it cannot stretch the shell. */
  .body { position: relative; flex: 1; min-height: 0; padding: var(--s3); }
  .inspector.peek { position: relative; }
  .inspector.peek .body { padding-top: var(--s2); }
  .peek-close { position: absolute; top: var(--s2); right: var(--s3); z-index: 1; background: var(--panel); }
  /* Room for the ✕ beside the header (a view's own header, or the unit's). */
  .inspector.peek :global(.head) { padding-right: 52px; }
  .index-row { flex: none; border-bottom: 1px solid var(--rule); }
  /* The row scrolls sideways: a fade at the right edge shows there is more (the end padding clears it at the end). */
  .index {
    display: flex; gap: var(--s1); overflow-x: auto; padding: var(--s1) var(--s5) var(--s1) var(--s3); scrollbar-width: none; touch-action: pan-x;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
  }
  .index::-webkit-scrollbar { display: none; }
  .chip {
    flex: none; display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 0 var(--s2); border: 1px solid var(--rule-strong); background: none;
    font: 600 12px/1 var(--font-cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap;
  }
  .chip b { font: 700 12px/1 var(--font-mono); color: var(--ink); letter-spacing: 0; }
  :global([data-tier='phone']) .body { overscroll-behavior: contain; touch-action: pan-y; }
</style>
