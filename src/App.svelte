<script lang="ts">
  import './app.css';
  import { onMount, untrack } from 'svelte';
  import type { Doc } from './lib/model/types';
  import { cueFor } from './core/model/cues';
  import { play } from './lib/ui/sound.svelte';
  import type { Ring } from './lib/model/types';
  import { getDoc, selection } from './lib/model/store.svelte';
  import { commandEvents, dispatch, type CommandEvent } from './lib/commands/dispatch';
  import { turnDetails } from './core/commands/turn';
  import OpsMap from './lib/map/OpsMap.svelte';
  import TopBar from './lib/ui/TopBar.svelte';
  import CommandBar from './lib/ui/CommandBar.svelte';
  import Inspector from './lib/ui/Inspector.svelte';
  import OrderLog from './lib/ui/OrderLog.svelte';
  import SitrepPanel from './lib/ui/SitrepPanel.svelte';
  import Legend from './lib/ui/Legend.svelte';
  import VikunjaAccount from './lib/ui/VikunjaAccount.svelte';
  import Toasts from './lib/ui/Toasts.svelte';
  import Login from './lib/ui/Login.svelte';
  import Sheet from './lib/ui/Sheet.svelte';
  import { ui, env, toast, prefill, write } from './lib/ui/shell.svelte';
  import { resolveTheme, THEME_COLOR } from './lib/ui/theme';
  import { boot, session, live, isAdmin, importShared, localMapText, markLocalImported, others, setSelection, color, initials, nameOf, currentMap } from './lib/sync/sync.svelte';
  import { copyText, download, pickFile, stamp } from './lib/ui/files';
  import { quoteName } from './lib/ui/words';

  const LOG_W = 264, RAIL_W = 28, BAR_H = 40, CMD_H = 84, PHONE_BAR_H = 44, SHEET_HEAD = 52;

  const doc = $derived(getDoc());
  // Console cues for what changes on the map while it is live: a new track, a new hostile, a hostile destroyed.
  // Loading, reconnecting and switching maps set a new baseline instead of sounding off.
  let heard: { map: string; doc: Doc } | null = null;
  $effect(() => {
    const d = doc, map = live.mapId, ready = live.status === 'live' && map !== '';
    untrack(() => {
      if (!ready || !heard || heard.map !== map) { heard = ready ? { map, doc: d } : null; return; }
      const cue = cueFor(heard.doc, d);
      heard = { map, doc: d };
      if (cue) play(cue);
    });
  });
  // System (prefers-color-scheme, live) unless this browser chose Day or Night. Not in the shared doc.
  const theme = $derived(resolveTheme(ui.themePref, env.systemDark));
  const phone = $derived(env.tier === 'phone');
  /** Landscape phone: the sheet becomes a right-hand column and the map keeps the full height. */
  const side = $derived(phone && env.landscape);
  const INSPECTOR_W = $derived(env.tier === 'tablet' ? 280 : 312);
  let orientation = $state((()=>{try{return !localStorage.getItem('opsmap.ui.oriented');}catch{return true;}})());
  function dismissOrientation(){orientation=false;write('opsmap.ui.oriented','yes');}
  let now = $state(new Date());
  let map = $state<ReturnType<typeof OpsMap>>();

  const leftW = $derived(ui.logOpen ? LOG_W : RAIL_W);

  // Phone geometry. Safe-area insets come from probes styled with env(); the keyboard overlap comes
  // from visualViewport (iOS shrinks only the visual viewport; Android with interactive-widget=
  // resizes-content shrinks the layout viewport too, which makes the overlap 0).
  let safeTop = $state(0), dockH = $state(0), sheetH = $state(SHEET_HEAD);
  let vh = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
  let vw = $state(typeof window === 'undefined' ? 1280 : window.innerWidth);
  const sideW = $derived(Math.round(Math.min(340, Math.max(260, vw * 0.42))));
  let vvH = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
  let kb = $state(0);
  const topH = $derived(PHONE_BAR_H + safeTop);
  const sheetAvail = $derived(Math.max(SHEET_HEAD, vh - topH - dockH - kb - 8));
  const popMax = $derived(Math.max(120, vvH - topH - dockH - 8));
  const insets = $derived(side
    ? { top: topH + 4, right: sideW, bottom: dockH + 4, left: 0 }
    : phone
    ? { top: topH + 4, right: 0, bottom: dockH + SHEET_HEAD + 4, left: 0 }
    : { top: BAR_H + 8, right: INSPECTOR_W + 8, bottom: Math.max(CMD_H, dockH + 12), left: leftW + 8 });
  /** Focus centers a unit above whatever the sheet covers right now. */
  const focusInsets = $derived(phone && !side ? { ...insets, bottom: dockH + sheetH + 4 } : insets);
  const trails = $derived(turnDetails(doc).trails.map(t => ({ unitId: t.unitId, from: t.from })));

  $effect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  });
  $effect(() => { document.documentElement.dataset.tier = env.tier; });
  // Leaving the phone tier closes the phone-only menu.
  $effect(() => { if (!phone && env.tier === 'desktop') ui.menuOpen = false; });

  /** Touch gestures on a unit: tap = card (peek), double-tap or long-press = every field (full). */
  function inspect(id: string, size: 'peek' | 'full') {
    ui.beyondSector = null;
    ui.sheetTab = 'info';
    ui.sheet = size;
  }

  function focus(id: string) { map?.focusUnit(id); }

  // Other users' selections, outlined on the map in their color.
  const remote = $derived(others().filter(p => p.selectedId).map(p => ({ unitId: p.selectedId!, userId: p.userId, color: color(p.userId), initials: initials(p.userId), name: nameOf(p.userId) })));
  $effect(() => { setSelection(selection.selectedId); });
  // Opening another map clears the selection and frames the new map.
  let shownMap = '';
  $effect(() => {
    const id = live.mapId;
    if (!id || id === shownMap) return;
    const first = !shownMap; shownMap = id;
    if (first) return;
    selection.selectedId = null; selection.hoveredId = null; ui.beyondSector = null;
    map?.fitView();
  });

  /** Admin import replaces the shared map for everyone, so it asks first. */
  function confirmImport(text: string, label: string, after?: () => void) {
    // The target is fixed now: switching maps while the prompt is up must not redirect the import.
    const target = live.mapId;
    toast(`${label}: this replaces the map ${currentMap()?.name ?? ''} for everyone.`, 'prompt', { label: 'Replace map', run: () => {
      if (live.mapId !== target) { toast('Import cancelled: you opened another map'); return; }
      void importShared(text, target).then(ok => { if (ok) { selection.selectedId = null; ui.beyondSector = null; after?.(); map?.fitView(); } });
    } }, 15000);
  }
  function importLocal() {
    const text = localMapText();
    if (text) confirmImport(text, 'Import the map saved in this browser', markLocalImported);
  }

  async function handle(ev: CommandEvent) {
    const { verb, args } = ev.cmd;
    if (verb === 'sitrep') {
      if (args.copy && ev.text) toast((await copyText(ev.text)) ? 'SITREP copied' : 'Copy failed: open the SITREP and copy by hand', 'info');
      else ui.sitrepOpen = true;
    } else if (verb === 'export' && ev.text) {
      const slug = (currentMap()?.name ?? 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
      download(`opsmap-${slug}-${stamp(new Date())}.json`, ev.text);
      toast('Map exported as JSON', 'info');
    } else if (verb === 'import') {
      if (!isAdmin(session.me)) { toast('Only the administrator can import a map'); return; }
      const text = typeof args.text === 'string' ? args.text : await pickFile();
      if (text !== null) confirmImport(text, 'Import file');
    } else if (verb === 'find' && ev.unitId) {
      ui.beyondSector = null;
      focus(ev.unitId);
    } else if (verb === 'help') {
      ui.legendOpen = true; ui.legendTab = 'commands';
    }
  }

  function onGlobalKey(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select');
    if (e.key === 'Escape') {
      if (ui.legendOpen) { ui.legendOpen = false; e.preventDefault(); }
      else if (ui.sitrepOpen) { ui.sitrepOpen = false; e.preventDefault(); }
      return;
    }
    if (typing) return;
    if(e.key==='0'){e.preventDefault();map?.fitView();return;}
    // Arrows and WASD (by key position, so any layout) pan the map (Shift: farther); + and - zoom. Not where arrows already mean something: menus,
    // dialogs, lists and radio groups, or the side panels, which scroll. Ctrl/⌘ combinations stay the browser's.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !(e.target as HTMLElement | null)?.closest?.('[contenteditable], [role="menu"], [role="dialog"], [role="listbox"], [role="radiogroup"], [role="tablist"], aside, .sheet')) {
      const step = e.shiftKey ? 240 : 80;
      const pan: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step], KeyA: [-step, 0], KeyD: [step, 0], KeyW: [0, -step], KeyS: [0, step] };
      const move = pan[e.key] ?? (e.code.startsWith('Key') ? pan[e.code] : undefined);
      if (move) { e.preventDefault(); map?.panBy(...move); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); map?.zoomBy(1.25, true); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); map?.zoomBy(1 / 1.25, true); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const res = dispatch({ verb: e.shiftKey ? 'redo' : 'undo', args: {} });
      if (!res.ok) toast(res.error, 'info');
    }
  }

  onMount(() => {
    let handled = 0;
    const unsubscribe = commandEvents.subscribe(ev => {
      if (!ev || ev.sequence <= handled) return;
      handled = ev.sequence;
      void handle(ev);
    });
    void boot();
    // iOS Safari ignores user-scalable=no and zooms the page from gesture* events: refuse them everywhere
    // (the map handles pinch itself from pointer events).
    const noPageZoom = (e: Event) => e.preventDefault();
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, noPageZoom, { passive: false });
    const vv = window.visualViewport;
    const measure = () => {
      vh = window.innerHeight; vw = window.innerWidth;
      vvH = vv ? vv.height : vh;
      kb = vv ? Math.max(0, Math.round(vh - vv.height - vv.offsetTop)) : 0;
    };
    measure();
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    // The server runs the daily turn (v2); the client only keeps its clock fresh.
    const tick = setInterval(() => { now = new Date(); }, 15_000);
    return () => { for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.removeEventListener(t, noPageZoom); unsubscribe(); clearInterval(tick); vv?.removeEventListener('resize', measure); vv?.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  });
</script>

<svelte:window onkeydown={onGlobalKey} />

{#if session.phase !== 'ready'}
<Login />
{:else}
<div class="app {env.tier}" class:kb={kb > 0} style="--left-w:{leftW}px; --right-w:{INSPECTOR_W}px; --cmd-h:{CMD_H}px; --kb:{kb}px; --dock-h:{dockH + kb}px; --top-h:{topH}px; --pop-max:{popMax}px">
  <div class="probe" aria-hidden="true" bind:clientHeight={safeTop}></div>
  <div class="map-layer">
    <OpsMap bind:this={map} {theme} {insets} {now} {trails} {remote}
      {focusInsets} touch={phone || env.coarse} compact={phone}
      onselect={(id) => { if (id) ui.beyondSector = null; }}
      oninspect={inspect}
      oncommandtext={(text: string, caret?: number) => prefill(text, caret)}
      oncontextnew={(ctx: { sectorId: string; ring: Ring }, identity?: string) => {
        const name = doc.sectors.find(s => s.id === ctx.sectorId)?.name ?? ctx.sectorId;
        const head = `/new ${identity ? identity + ' ' : ''}"`;
        prefill(`${head}" in ${quoteName(name)} ${ctx.ring}`, head.length);
      }}
      onbeyond={(sectorId) => { selection.selectedId = null; ui.beyondSector = sectorId; if (phone) { ui.sheetTab = 'info'; ui.sheet = 'half'; } }}
      onerror={(message) => toast(message)}
      onnotice={(message) => toast(message, 'info', { label: 'Undo', run: () => { const r = dispatch({ verb: 'undo', args: {} }); if (!r.ok) toast(r.error, 'info'); } }, 6000)} />
  </div>

  <TopBar {doc} {now} onimportlocal={importLocal} />

  {#if phone}
    <Sheet {doc} {now} {theme} avail={sheetAvail} onfocus={focus} bind:shown={sheetH} {side} {sideW} />
  {:else}
    <div class="left"><OrderLog {doc} onfocus={focus} /></div>
    <div class="right"><Inspector {doc} {now} {theme} onfocus={focus} /></div>
  {/if}

  <div class="bottom" bind:clientHeight={dockH}><div class="bar-wrap">
    {#if orientation}<div class="orientation" data-testid="orientation">
      <span>Center is you (HQ). Rings are time to impact: today, week, month, quarter. Frame = for or against you. Echelon = effort, not urgency.</span>
      {#if phone || env.coarse}<span class="gest-hint">Long-press a symbol to move it · drag its round handle onto a problem to attack · long-press ground to capture.</span>{/if}
      <div><button class="btn" onclick={()=>{ui.legendOpen=true;dismissOrientation();}}>Open legend</button>
      <button class="btn" onclick={()=>{prefill('/new "Fix sink"');dismissOrientation();}}>Try: /new "Fix sink"</button>
      <button class="btn" aria-label="Dismiss orientation" onclick={dismissOrientation}>✕</button></div>
    </div>{/if}
    <CommandBar {doc} {theme} /></div></div>

  <div class="toast-layer"><Toasts /></div>

  {#if ui.sitrepOpen}
    <div class="sitrep-layer"><SitrepPanel {doc} {now} /></div>
  {/if}
  {#if ui.vikunjaOpen}
    <div class="sitrep-layer vk-layer"><VikunjaAccount /></div>
  {/if}
  {#if ui.legendOpen}
    <div class="legend-layer"><Legend {theme} /></div>
  {/if}
</div>
{/if}

<style>
  .app { position: relative; width: 100%; height: 100dvh; overflow: hidden; }
  .probe { position: absolute; top: 0; left: 0; width: 0; height: env(safe-area-inset-top); visibility: hidden; pointer-events: none; }
  .map-layer { position: absolute; inset: 0; }
  .left { position: absolute; top: var(--bar-h); bottom: 0; left: 0; width: var(--left-w); z-index: 10; }
  .right { position: absolute; top: var(--bar-h); bottom: 0; right: 0; width: var(--right-w); z-index: 10; }
  .bottom {
    touch-action: pan-x pan-y;
    position: absolute; bottom: 12px; left: calc(var(--left-w) + 16px); right: calc(var(--right-w) + 16px); z-index: 15;
    display: flex; justify-content: center; pointer-events: none;
  }
  .orientation { padding:8px;background:var(--panel);border:1px solid var(--rule);font-size:12px;margin-bottom:8px; }
  .orientation div {display:flex;gap:4px;margin-top:8px;}
  .bar-wrap { width: 100%; max-width: 760px; pointer-events: auto; }
  .toast-layer { position: absolute; top: calc(var(--bar-h) + 8px); left: calc(var(--left-w) + 16px); right: calc(var(--right-w) + 16px); z-index: 30; }
  .sitrep-layer { position: absolute; top: calc(var(--bar-h) + 16px); left: calc(var(--left-w) + 16px); right: calc(var(--right-w) + 16px); z-index: 25; display: flex; justify-content: center; }
  .vk-layer { z-index: 27; }
  .legend-layer { position: absolute; top: calc(var(--bar-h) + 6px); right: 12px; z-index: 26; }

  /* Phone: the map fills the screen; the command bar docks at the bottom (above the keyboard),
     the details sheet sits on top of it, and overlays fill the space between bar and dock. */
  .app.phone .bottom {
    left: 0; right: 0; bottom: var(--kb); pointer-events: auto;
    padding: 8px calc(8px + env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));
    background: var(--panel); border-top: 1px solid var(--rule); z-index: 16;
  }
  .app.phone.kb .bottom { padding-bottom: 8px; }
  .app.phone .bar-wrap { max-width: none; }
  .app.phone .toast-layer { top: calc(var(--top-h) + 8px); left: 8px; right: 8px; }
  .app.phone .sitrep-layer, .app.phone .legend-layer, .app.phone .vk-layer { top: calc(var(--top-h) + 8px); left: 8px; right: 8px; bottom: calc(var(--dock-h) + 8px); display: flex; justify-content: center; align-items: stretch; }
  .app.phone .sitrep-layer > :global(*), .app.phone .legend-layer > :global(*) { max-height: 100%; }
  .app.phone .orientation { font-size: 13px; }
  .gest-hint { display: block; margin-top: 4px; font-weight: 600; }
  .app.phone .orientation div { flex-wrap: wrap; }
</style>
