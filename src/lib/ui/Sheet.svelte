<script lang="ts">
  // Phone tier: the inspector (or situation summary) and the order log share one bottom sheet.
  // Three heights: peek, half, full. Tapping the open tab steps peek → half → full → peek; tapping the
  // other tab switches to it. Or drag the header and let go: it snaps to the nearest height (a flick
  // goes one step in its direction). Landscape phones get `side`: a full-height right-hand column, so the
  // map keeps the whole height; there the tabs only switch.
  import type { Doc } from '../../core/model/types';
  import { selection } from '../model/store.svelte';
  import { isArchived } from '../map/scene';
  import { miniSymbol } from './mini';
  import { ui, type SheetSize, type Theme } from './shell.svelte';
  import Inspector from './Inspector.svelte';
  import OrderLog from './OrderLog.svelte';

  let { doc, now, theme, avail, onfocus, shown = $bindable(0), side = false, sideW = 320 }: { doc: Doc; now: Date; theme: Theme; avail: number; onfocus: (id: string) => void; shown?: number; side?: boolean; sideW?: number } = $props();

  const HEAD = 52;
  const unit = $derived(doc.units.find(u => u.id === selection.selectedId));
  const unopposed = $derived.by(() => {
    const attacked = new Set(doc.orders.filter(o => o.type === 'attack').map(o => o.to));
    return doc.units.filter(u => !isArchived(u, now, doc.lastTurn) && u.lifecycle !== 'done' && (u.affiliation === 'hostile' || u.affiliation === 'suspect') && u.pos.r < 2 && !attacked.has(u.id)).length;
  });
  /** Peek shows the tabs; with a unit selected it also shows the unit card and quick actions. */
  /** A pending or unknown unit's card adds the identity and effort chips. */
  const triage = $derived(unit !== undefined && (unit.affiliation === 'pending' || unit.affiliation === 'unknown') && unit.lifecycle !== 'done' && unit.lifecycle !== 'dropped');
  const peekH = $derived(ui.sheetTab === 'info' && (unit || ui.beyondSector) ? Math.min(HEAD + 128 + (triage ? 108 : 0), avail) : HEAD);
  // Full stops short of the top so a strip of map (with the selected unit) stays visible.
  const heights = $derived({ peek: peekH, half: Math.max(peekH, Math.round(avail * 0.5)), full: Math.max(peekH, Math.round(avail * 0.85)) });
  let liveH = $state<number | null>(null);
  const height = $derived(liveH ?? heights[ui.sheet]);
  $effect(() => { shown = ui.barFocused || side ? 0 : heights[ui.sheet]; });

  function open(tab: 'info' | 'log') {
    if (side) { ui.sheetTab = tab; return; }
    if (ui.sheetTab !== tab) { ui.sheetTab = tab; if (ui.sheet === 'peek') ui.sheet = 'half'; return; }
    ui.sheet = ui.sheet === 'peek' ? 'half' : ui.sheet === 'half' ? 'full' : 'peek';
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
  const guard = (fn: () => void) => () => { if (!swallow) fn(); };
  const sym = $derived(unit ? miniSymbol(unit, theme, 12) : null);
</script>

<section class="sheet {ui.sheet}" class:side class:dragging={liveH !== null} class:hidden={ui.barFocused && !side} style={side ? `width:${sideW}px` : `height:${height}px`} aria-label="Details sheet" data-testid="sheet" data-size={ui.sheet} data-tab={ui.sheetTab}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="head" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel}>
    <span class="grab" aria-hidden="true"><span></span></span>
    <div class="tabs" role="tablist">
      <button role="tab" class="tab" aria-selected={ui.sheetTab === 'info'} class:on={ui.sheetTab === 'info'} onclick={guard(() => open('info'))} data-testid="sheet-tab-info">
        {#if unit && sym}<img src={sym.href} alt="" width={Math.min(sym.width, 30)} height={Math.min(sym.height, 18)} /><span class="t-main">{unit.designation}</span>
        {:else if ui.beyondSector}<span class="t-main">Beyond</span>
        {:else}<span class="t-main">Situation</span>{#if unopposed}<b class="threat" title="Unopposed threats inside PL WEEK">{unopposed}</b>{/if}{/if}
      </button>
      <button role="tab" class="tab" aria-selected={ui.sheetTab === 'log'} class:on={ui.sheetTab === 'log'} onclick={guard(() => open('log'))} data-testid="sheet-tab-log">
        <span class="t-main">Log</span><b class="count">{doc.log.length}</b>
      </button>
    </div>
  </div>
  <div class="body" class:locked={!side && ui.sheet === 'peek' && liveH === null}>
    {#if ui.sheetTab === 'info'}
      <Inspector {doc} {now} {theme} {onfocus} />
    {:else}
      <OrderLog {doc} onfocus={onfocus} embedded />
    {/if}
  </div>
</section>

<style>
  .sheet {
    position: absolute; left: 0; right: 0; bottom: var(--dock-h); z-index: 12;
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
  .grab { flex: none; height: 8px; display: grid; place-items: center; }
  .grab span { margin-top: 4px; width: 40px; height: 4px; border-radius: 2px; background: var(--rule); }
  .tabs { flex: 1; display: flex; }
  .tab {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 44px; border: 0; background: none;
    font: 700 13px/1 var(--font-cond); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); touch-action: pan-x pan-y;
  }
  .tab.on { color: var(--ink); box-shadow: inset 0 -3px 0 var(--accent); }
  .tab img { object-fit: contain; }
  .tab b { font: 700 12px/1 var(--font-mono); padding: 2px 5px; border: 1px solid var(--rule); }
  .tab b.threat { color: var(--hostile); border-color: var(--hostile); }
  .t-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .body.locked { overflow: hidden; }
  .body :global(.inspector), .body :global(.log) { border: 0; background: var(--panel); }
</style>
