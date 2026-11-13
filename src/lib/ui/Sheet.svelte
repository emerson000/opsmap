<script lang="ts">
  // Phone tier: the inspector (or situation summary) and the order log share one bottom sheet.
  // Three heights: peek, half, full. One tap on the open tab or the grab bar opens the sheet from peek
  // (to the height it last had open, half at first) or closes it to peek; tapping the other tab switches
  // to it. Or drag the header and let go: it snaps to the nearest height (a flick goes one step in its direction). Landscape phones get `side`: a full-height right-hand column, so the
  // map keeps the whole height; there the tabs only switch.
  // At peek the body does not scroll: a swipe up on it opens the sheet. While a text field in the sheet has focus
  // with the keyboard up (ui.sheetTyping), the sheet takes all the height above the keyboard and drops its chrome.
  import type { Doc } from '../../core/model/types';
  import { selection } from '../model/store.svelte';
  import { isArchived } from '../map/scene';
  import { miniSymbol } from './mini';
  import { ui, pick, env, type SheetSize, type Theme } from './shell.svelte';
  import Inspector from './Inspector.svelte';
  import PickBanner from './PickBanner.svelte';
  import OrderLog from './OrderLog.svelte';
  import { reveal, revealAgain, settle } from './inspector/reveal';

  let { doc, now, theme, avail, onfocus, shown = $bindable(0), fieldFocus = $bindable(false), side = false, sideW = 320 }: { doc: Doc; now: Date; theme: Theme; avail: number; onfocus: (id: string) => void; shown?: number; fieldFocus?: boolean; side?: boolean; sideW?: number } = $props();

  const HEAD = 52;
  const unit = $derived(doc.units.find(u => u.id === selection.selectedId));
  const unopposed = $derived.by(() => {
    const attacked = new Set(doc.orders.filter(o => o.type === 'attack').map(o => o.to));
    return doc.units.filter(u => !isArchived(u, now, doc.lastTurn) && u.lifecycle !== 'done' && (u.affiliation === 'hostile' || u.affiliation === 'suspect') && u.pos.r < 2 && !attacked.has(u.id)).length;
  });
  /** Peek shows the tabs; with a unit selected it also shows the unit card and quick actions. */
  /** A pending or unknown unit's card adds the identity and effort chips. */
  const triage = $derived(unit !== undefined && (unit.affiliation === 'pending' || unit.affiliation === 'unknown') && unit.lifecycle !== 'done' && unit.lifecycle !== 'dropped');
  const measure = $derived(selection.sel?.kind === 'measure' ? doc.measures.find(m => m.id === selection.sel?.id) : undefined);
  const sector = $derived(selection.sel?.kind === 'sector' ? doc.sectors.find(s => s.id === selection.sel?.id) : undefined);
  /** Peek: the header, a status line and one action row, 52 + 124 = 176 px for every kind (plus 108 for the triage chips). */
  const PEEK_BODY = 124, TRIAGE = 108;
  /** What half adds above the view at peek: the kind strip and the section chips. */
  const CHROME = 96;
  /** The pick banner's own height: during a pick, peek shows all of it. */
  let bannerH = $state(0);
  const peekH = $derived(pick.current && !side ? Math.min(HEAD + Math.max(PEEK_BODY, bannerH), avail) : ui.sheetTab === 'info' && (unit || measure || sector) ? Math.min(HEAD + PEEK_BODY + (triage ? TRIAGE : 0), avail) : HEAD);
  // Full stops short of the top so a strip of map (with the selected unit) stays visible. Half shows at least what
  // peek shows, below the strip and chips it adds.
  const fullH = $derived(Math.max(peekH, Math.round(avail * 0.85)));
  const heights = $derived({ peek: peekH, half: Math.min(fullH, Math.max(peekH + CHROME, Math.round(avail * 0.55))), full: fullH });
  let liveH = $state<number | null>(null);
  const typing = $derived(ui.sheetTyping && !side);
  const height = $derived(typing ? avail : liveH ?? heights[ui.sheet]);
  $effect(() => { shown = ui.barFocused || side ? 0 : typing ? avail : heights[ui.sheet]; });

  // A text field in the sheet has focus. Leaving it waits a moment, so a tap that blurs the field lands on the
  // layout it started on (the sheet's chrome comes back after the click).
  const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, [contenteditable="true"]';
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let sheetEl: HTMLElement | undefined = $state();
  function focusIn(e: FocusEvent) {
    if (!(e.target as Element).matches?.(TEXT)) return;
    clearTimeout(blurTimer);
    fieldFocus = true;
    const t = e.target as Element;
    if (env.tier === 'phone' && !side) settle(() => reveal(t));
  }
  function focusOut() {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { const a = document.activeElement; fieldFocus = !!a && !!sheetEl?.contains(a) && a.matches(TEXT); }, 250);
  }
  // The keyboard came up (or went): keep the focused field in view.
  // Up: the focused field. Down: whatever was last brought into view (the next slot after a choice).
  let wasTyping = false;
  $effect(() => {
    const t = typing;
    if (t) settle(() => { const a = document.activeElement; if (a && sheetEl?.contains(a)) reveal(a); });
    else if (wasTyping) settle(revealAgain);
    wasTyping = t;
  });

  /** The open height to come back to: whatever it last had open (by tap or drag), half at first. */
  let lastOpen: 'half' | 'full' = 'half';
  $effect(() => { if (ui.sheet !== 'peek') lastOpen = ui.sheet; });
  function toggle() { ui.sheet = ui.sheet === 'peek' ? lastOpen : 'peek'; }
  function open(tab: 'info' | 'log') {
    if (side) { ui.sheetTab = tab; return; }
    if (ui.sheetTab !== tab) { ui.sheetTab = tab; if (ui.sheet === 'peek') ui.sheet = lastOpen; return; }
    toggle();
  }

  // Header drag. A press that moves under 6 px stays a tap, so the tab buttons keep working.
  let drag: { id: number; y: number; h: number; t: number; lastY: number; lastT: number; moved: boolean } | null = null;
  let swallow = false;
  function down(e: PointerEvent) {
    if (e.button !== 0 || side) return;
    drag = { id: e.pointerId, y: e.clientY, h: height, t: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp, moved: false };
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > 6) { drag.moved = true; try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } }
    if (drag.moved) {
      liveH = Math.max(HEAD, Math.min(heights.full, drag.h - dy));
      drag.lastY = e.clientY; drag.lastT = e.timeStamp;
    }
  }
  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved || liveH === null) { liveH = null; return; }
    const h = liveH, v = (e.clientY - d.lastY) / Math.max(1, e.timeStamp - d.lastT); // px/ms, down is positive
    const order: SheetSize[] = ['peek', 'half', 'full'];
    let pick: SheetSize = order.reduce((a, b) => (Math.abs(heights[b] - h) < Math.abs(heights[a] - h) ? b : a));
    if (Math.abs(v) > 0.5) {
      const i = order.indexOf(pick), hereH = heights[pick];
      if (v < 0 && hereH <= h && i < 2) pick = order[i + 1];
      if (v > 0 && hereH >= h && i > 0) pick = order[i - 1];
    }
    ui.sheet = pick; liveH = null; swallow = true;
    setTimeout(() => (swallow = false), 0);
  }
  function cancel() { drag = null; liveH = null; }

  // Peek: the body does not scroll; a swipe up on it opens the sheet (a tap still reaches the buttons).
  let swipe: { id: number; y: number } | null = null;
  function bodyDown(e: PointerEvent) { swipe = locked ? { id: e.pointerId, y: e.clientY } : null; }
  function bodyMove(e: PointerEvent) {
    if (!swipe || e.pointerId !== swipe.id) return;
    if (swipe.y - e.clientY > 24) { swipe = null; ui.sheet = lastOpen; }
  }
  const locked = $derived(!side && ui.sheet === 'peek' && liveH === null);
  const guard = (fn: () => void) => () => { if (!swallow) fn(); };
  const sym = $derived(unit ? miniSymbol(unit, theme, 12) : null);
  /** Portrait: map pick shows its banner in the sheet (landscape shows it over the map). */
  const picking = $derived(pick.current !== null && !side);
</script>

<section class="sheet {ui.sheet}" class:side class:typing class:dragging={liveH !== null} class:hidden={ui.barFocused && !side} bind:this={sheetEl} onfocusin={focusIn} onfocusout={focusOut} style={side ? `width:${sideW}px` : `height:${height}px`} aria-label="Details sheet" data-testid="sheet" data-size={ui.sheet} data-tab={ui.sheetTab}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="head" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel}>
    <button class="grab" aria-label={ui.sheet === 'peek' ? 'Open the sheet' : 'Close the sheet'} aria-expanded={ui.sheet !== 'peek'} data-testid="sheet-grab" onclick={guard(toggle)}><span></span></button>
    <div class="tabs" role="tablist">
      <button role="tab" class="tab" aria-selected={ui.sheetTab === 'info'} class:on={ui.sheetTab === 'info'} onclick={guard(() => open('info'))} data-testid="sheet-tab-info">
        {#if unit && sym}<img src={sym.href} alt="" width={Math.min(sym.width, 30)} height={Math.min(sym.height, 18)} /><span class="t-main">{unit.designation}</span>
        {:else if measure}<span class="kind">{measure.type.toUpperCase()}</span><span class="t-main">{measure.name}</span>
        {:else if sector}<span class="kind">SEC</span><span class="t-main">{sector.name}</span>
        {:else}<span class="t-main">Situation</span>{#if unopposed}<b class="threat" title="Unopposed threats inside PL WEEK">{unopposed}</b>{/if}{/if}
      </button>
      <button role="tab" class="tab" aria-selected={ui.sheetTab === 'log'} class:on={ui.sheetTab === 'log'} onclick={guard(() => open('log'))} data-testid="sheet-tab-log">
        <span class="t-main">Log</span><b class="count">{doc.log.length}</b>
      </button>
    </div>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="body" class:locked onpointerdown={bodyDown} onpointermove={bodyMove} onpointerup={() => (swipe = null)} onpointercancel={() => (swipe = null)}>
    <!-- Map pick: the banner takes the sheet; the view stays mounted underneath, so the composer keeps its draft. -->
    {#if picking}<div class="banner" bind:offsetHeight={bannerH}><PickBanner {doc} /></div>{/if}
    <div class="pane" class:gone={picking}>
      {#if ui.sheetTab === 'info'}
        <Inspector {doc} {now} {theme} {onfocus} />
      {:else}
        <OrderLog {doc} onfocus={onfocus} embedded />
      {/if}
    </div>
  </div>
</section>

<style>
  .sheet {
    position: absolute; left: 0; right: 0; bottom: var(--dock-h); z-index: var(--z-sheet);
    display: flex; flex-direction: column; background: var(--panel); border-top: 2px solid var(--rule-strong);
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12); transition: height 180ms ease-out;
    padding: 0 env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  .sheet.dragging { transition: none; }
  .sheet.hidden { display: none; }
  @media (prefers-reduced-motion: reduce) { .sheet { transition: none; } }
  .sheet.side {
    left: auto; top: var(--top-h); bottom: var(--dock-h); transition: none; padding: 0 env(safe-area-inset-right) 0 0;
    border-top: 0; border-left: 2px solid var(--rule-strong); box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
  }
  .side .grab { display: none; }
  .side .head { height: 44px; touch-action: pan-x pan-y; }
  .head { flex: none; height: 52px; display: flex; flex-direction: column; touch-action: none; border-bottom: 1px solid var(--rule); }
  /* The grab bar is a tap target too: its hit area reaches above the sheet's edge without taking room from the tabs. */
  .grab { flex: none; height: 8px; position: relative; display: grid; place-items: center; width: 100%; padding: 0; border: 0; background: none; cursor: pointer; }
  .grab::before { content: ''; position: absolute; inset: -12px 0 0; }
  .grab span { margin-top: 4px; width: 40px; height: 4px; border-radius: 2px; background: var(--rule); }
  .grab:focus-visible span { background: var(--ink); }
  .tabs { flex: 1; display: flex; }
  .tab {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 44px; border: 0; background: none;
    font: 700 13px/1 var(--font-cond); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); touch-action: pan-x pan-y;
  }
  .tab.on { color: var(--ink); box-shadow: inset 0 -3px 0 var(--accent); }
  .tab img { object-fit: contain; }
  .tab .kind { padding: 0 3px; border: 1px solid var(--rule-strong); font: 700 11px/14px var(--font-mono); letter-spacing: 0.04em; color: var(--ink); }
  .tab b { font: 700 12px/1 var(--font-mono); padding: 2px 5px; border: 1px solid var(--rule); }
  .tab b.threat { color: var(--hostile); border-color: var(--hostile); }
  .t-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane.gone { display: none; }
  .body.locked { overflow: hidden; touch-action: none; }
  .banner { flex: none; }
  /* Typing: the field gets the room. No header, kind strip, section chips or echo line; the composer's foot scrolls with it. */
  .sheet.typing { border-top-width: 1px; box-shadow: none; transition: none; }
  .sheet.typing .head, .sheet.typing :global(.strip), .sheet.typing :global(.index-row), .sheet.typing :global(.echo) { display: none; }
  .sheet.typing :global(.composer .foot) { position: static; box-shadow: none; }
  .body :global(.inspector), .body :global(.log) { border: 0; background: var(--panel); }
</style>
