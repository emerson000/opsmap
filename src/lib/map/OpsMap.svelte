<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Command, Ring, Unit } from '../../core/model/types';
  import { AREA_SIZES, RING_R, aoScale, areaMembers, areaSizeName, type AreaSize } from '../../core/model/geometry';
  const AREA_SIZE_NAMES = Object.keys(AREA_SIZES) as AreaSize[];
  import { mapLabels, visibleWorld } from './maplabels';
  import { band } from '../ui/words';
  import { formatDtg } from '../../core/model/sidc';
  import { getDoc, selection } from '../model/store.svelte';
  import { dispatch } from '../commands/dispatch';
  import { touchUnit } from '../commands/recent.svelte';
  import { buildScene, type Trail } from './scene';
  import { buildTerrain } from './terrain';
  import { annularSectorPath } from './arrows';
  import { attackCommand, contextAt, dropCommand, measureDropCommand, snapWorld, worldFromClient, ringOfRadius } from './interaction';
  import { fitTransform, focusTransform, lerpView, NO_INSETS, mapScale, pinchView, wheelFactor, zoomAround, ZOOM_MAX, ZOOM_MIN, type Insets, type View2D } from './panzoom';
  import { keyTerrainSymbol, unitSymbol } from './symbols';
  import { SCALE, TERRAIN_BOUNDS, TERRAIN_SEED, UNIT_SIZE } from './constants';
  import TerrainLayer from './TerrainLayer.svelte';
  import FrameworkLayer from './FrameworkLayer.svelte';
  import OrderLayer from './OrderLayer.svelte';

  interface Props {
    /** Selection changed on the map (null = cleared). The map also writes `selection.selectedId`. */
    onselect?: (id: string | null) => void;
    /** Touch: tap a unit = 'peek' (its card), double-tap or long-press and release = 'full' (every field). */
    oninspect?: (id: string, size: 'peek' | 'full') => void;
    /** Capture on open ground (double-click, or long-press then a capture-menu choice). */
    oncontextnew?: (ctx: { sectorId: string; ring: Ring }, identity?: string) => void;
    /** Put a command in the command bar for the user to finish (right-click menu items ending in …). */
    oncommandtext?: (text: string, caret?: number) => void;
    /** A sector's beyond chevron was clicked. */
    onbeyond?: (sectorId: string) => void;
    /** Errors from drag commands. Without it the map shows its own toast. */
    onerror?: (message: string) => void;
    /** Confirmation of a drag-made order (e.g. "PACKING ATTACKS LEAK"), offered with undo by the shell. */
    onnotice?: (message: string) => void;
    /** Old positions from the last morning turn. Without it the map derives them from `lastTurn`. */
    trails?: Trail[];
    /** Space covered by app chrome, so fit centers the map in the free area. */
    insets?: Insets;
    /** Space covered right now (an open sheet), so focus centers in what is visible. Defaults to insets. */
    focusInsets?: Insets;
    /** Touch layout: 44 px attack handle and map buttons, decluttered commander labels. */
    touch?: boolean;
    /** Phone layout: smaller symbols, so a 390 px wide map is not all symbol. */
    compact?: boolean;
    /** Clock override (tests). */
    now?: Date;
    /** Theme override (the app shell keeps theme as a UI preference, outside the undoable doc). */
    theme?: 'light' | 'dark';
    /** Other users' selections (v2 presence), outlined in their color. */
    remote?: { unitId: string; userId: string; color: string; initials: string; name: string }[];
  }
  let { onselect, oninspect, oncontextnew, oncommandtext, onbeyond, onerror, onnotice, trails, insets = NO_INSETS, focusInsets, touch = false, compact = false, now: nowProp, theme: themeProp, remote = [] }: Props = $props();

  const uid = `om${Math.random().toString(36).slice(2, 8)}`;
  const terrain = buildTerrain(TERRAIN_SEED, TERRAIN_BOUNDS, 22);
  /** Smallest on-screen text, px. */
  const MIN_TEXT = 12;
  /** Long-press before a unit lifts (touch), and before open ground offers capture. */
  const LONG_PRESS = 450, LONG_PRESS_GROUND = 550;
  /** Travel (px) that turns a touch press into a pan; mice start panning sooner. */
  const TOUCH_SLOP = 8, MOUSE_SLOP = 3;
  const DOUBLE_TAP_MS = 320, DOUBLE_TAP_PX = 30;

  let container: HTMLDivElement;
  let svg: SVGSVGElement;
  let view2d = $state<View2D>({ x: 0, y: 0, k: 1 });
  let fitK = $state(1);
  let userMoved = false;
  let clock = $state(new Date());
  /** An order just made by dragging the attack handle: drawn (and animated in) for 3 s even when the view hides it. */
  let freshOrder = $state<string | null>(null);
  let freshTimer: ReturnType<typeof setTimeout> | undefined;

  const now = $derived(nowProp ?? clock);
  const doc = $derived(getDoc());
  const theme = $derived(themeProp ?? doc.settings.theme);
  /** Zoom, rounded so that panning (x/y only) does not recompute labels. */
  const zk = $derived(Math.round(view2d.k * 1000) / 1000);
  // A larger AO draws symbols smaller against the rings; placement spaces them by the same factor.
  const s = $derived(mapScale(zk, fitK) * Math.max(1,Math.min(1.3,fitK/0.64)) * (compact ? 0.72 : 1) / aoScale(doc));
  /** World size of the smallest legible text at this zoom. */
  const mt = $derived(MIN_TEXT / zk);
  /** Unit labels grow with the text floor: 10.5 px base, never under MIN_TEXT on screen. */
  const ls = $derived(Math.max(1, MIN_TEXT / (10.5 * s * zk)));
  /** Phone at about the fitted zoom: compact phase-line labels (staggered, no dates, none on PL TODAY). */
  const compactPl = $derived(compact && zk < fitK * 1.6);
  const scene = $derived(buildScene(doc, { view: doc.settings.view, now, selectedId: selection.selectedId, trails, symbolScale: s, plFont: Math.max(8.5 * s, mt), compactPl, showOrders: freshOrder ? [freshOrder] : [] }));
  const selectedUnit = $derived(doc.units.find(u => u.id === selection.selectedId));
  /**
   * Touch commander view at (about) fitted zoom: label only what needs a name at a glance —
   * threats, units inside PL MONTH, main efforts and the selection. Zoom in for every label.
   */
  const declutter = $derived(touch && doc.settings.view === 'commander' && zk < fitK * 1.6);
  const mainIds = $derived(new Set(doc.orders.filter(o => o.type === 'attack' && o.role === 'main').map(o => o.from)));

  /** The fitted view and screen size: labels stay inside the map area visible at fit. */
  let fitT = $state<View2D | null>(null), screen = $state({ w: 0, h: 0 });
  const labelBounds = $derived(fitT ? visibleWorld(fitT, screen.w, screen.h, insets, 4) : undefined);
  const labels = $derived(mapLabels(doc, scene, { s, ls, mt, declutter, hoveredId: selection.hoveredId, bounds: labelBounds, maxOffset: compact ? 48 : undefined }));

  // ---------- pan / zoom (Pointer Events + wheel; no browser gestures on the map) ----------
  function applyView(t: View2D) {
    view2d = { x: t.x, y: t.y, k: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, t.k)) };
  }
  /** Fit the whole map into the free area. */
  export function fitView() {
    const t = fitTransform(container.clientWidth, container.clientHeight, insets, compact ? 14 : 0);
    fitK = t.k; fitT = t; screen = { w: container.clientWidth, h: container.clientHeight };
    userMoved = false;
    applyView(t);
  }
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let anim = 0;
  function animateTo(target: View2D, ms = 450) {
    cancelAnimationFrame(anim);
    if (reducedMotion()) { applyView(target); return; }
    const from = { ...view2d }, t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms), e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      applyView(lerpView(from, target, e));
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  /** Zoom buttons: about the center of the free area. */
  function zoomBy(factor: number) {
    const w = container.clientWidth, h = container.clientHeight;
    userMoved = true;
    applyView(zoomAround(view2d, { x: insets.left + (w - insets.left - insets.right) / 2, y: insets.top + (h - insets.top - insets.bottom) / 2 }, factor));
  }
  let flashId = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pan (and zoom in a little) to a unit; units beyond the map pan to their sector chevron. */
  export function focusUnit(id: string): boolean {
    const su = scene.units.find(u => u.id === id);
    let p: { x: number; y: number } | undefined = su;
    if (!p) {
      const u = doc.units.find(x => x.id === id);
      const sec = u && scene.sectors.find(x => x.id === u.sectorId);
      if (sec && u && ringOfRadius(u.pos.r) === 'beyond') p = sec.chevron;
    }
    if (!p) return false;
    userMoved = true;
    animateTo(focusTransform(p, Math.max(view2d.k, fitK * 1.8), container.clientWidth, container.clientHeight, focusInsets ?? insets));
    flashId = id;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashId = null), 1800);
    return true;
  }

  onMount(() => {
    fitView();
    const ro = new ResizeObserver(() => { if (!userMoved) fitView(); else { fitT = fitTransform(container.clientWidth, container.clientHeight, insets, compact ? 14 : 0); fitK = fitT.k; screen = { w: container.clientWidth, h: container.clientHeight }; } });
    ro.observe(container);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(anim);
      userMoved = true;
      unitMenu = null;
      applyView(zoomAround(view2d, rel(e), wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey)));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    // iOS Safari's own pinch (gesture* events) would zoom the page: the map owns pinch.
    const noGesture = (e: Event) => e.preventDefault();
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) container.addEventListener(t, noGesture);
    const tick = setInterval(() => (clock = new Date()), 60_000);
    return () => {
      ro.disconnect(); svg.removeEventListener('wheel', onWheel);
      for (const t of ['gesturestart', 'gesturechange', 'gestureend']) container.removeEventListener(t, noGesture);
      clearInterval(tick); cancelAnimationFrame(anim); clearTimeout(flashTimer); clearTimeout(pressTimer); clearTimeout(freshTimer);
    };
  });

  // ---------- commands ----------
  let toasts = $state<{ id: number; text: string }[]>([]);
  let toastSeq = 0;
  function toast(text: string) {
    if (onerror) { onerror(text); return; }
    const id = ++toastSeq;
    toasts = [...toasts, { id, text }];
    setTimeout(() => (toasts = toasts.filter(t => t.id !== id)), 4000);
  }
  function run(cmd: Command): boolean {
    try {
      const res = dispatch(cmd);
      if (!res.ok) toast(res.error);
      return res.ok;
    } catch (e) {
      toast(`Could not ${cmd.verb}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  function selectUnit(id: string | null) {
    selection.selectedId = id;
    // Every click counts as using the unit, even when it was already selected: it leads the next suggestions.
    if (id) touchUnit({ id });
    onselect?.(id);
  }

  // ---------- pointer interaction ----------
  // Every active pointer is tracked. One pointer pans (or drags a unit / the attack handle); a
  // second pointer cancels whatever one finger was doing and starts a pinch. Mouse: press on a
  // unit drags it at once. Touch: press on a unit pans unless it is held for LONG_PRESS, which
  // lifts the unit: drag to move it, or let go to open its inspector.
  type P = { x: number; y: number };
  /** A unit or area-measure drag. x/y: pointer in world space; wx/wy: where the press started. */
  type Drag = { id: string; kind: 'unit' | 'measure'; pointerId: number; sx: number; sy: number; moved: boolean; x: number; y: number; wx: number; wy: number; lifted: boolean };
  type Link = { fromId: string; pointerId: number; x: number; y: number; targetId: string | null; valid: boolean };
  type Gesture =
    | { kind: 'pan'; id: number; sx: number; sy: number; view: View2D; moved: boolean; touch: boolean; unitId: string | null; measureId: string | null }
    | { kind: 'pinch'; a: number; b: number; a0: P; b0: P; view: View2D };
  let drag = $state<Drag | null>(null);
  let link = $state<Link | null>(null);
  let lifted = $state<string | null>(null);
  let gesture: Gesture | null = null;
  const pointers = new Map<number, P>();
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTap: { t: number; x: number; y: number; unitId: string | null; measureId: string | null } | null = null;
  let lastPointerType = 'mouse';
  let captureMenu = $state<{ x: number; y: number; py: number; ctx: { sectorId: string; ring: Ring } } | null>(null);
  /** Small inspector for an OBJ, EA or NAI (long-press and let go, double-tap, or double-click). */
  let measureCard = $state<{ id: string; x: number; y: number } | null>(null);
  /** The card's height, so it stays above whatever covers the bottom of the map (command bar, sheet). */
  let cardH = $state(0), mapH = $state(0), menuH = $state(0);
  function menuTop(m: { y: number; py: number }): number {
    const limit = mapH - (insets?.bottom ?? 0) - 8;
    return m.y + menuH <= limit ? m.y : Math.max(8, m.py - 16 - menuH);
  }
  const cardMeasure = $derived(measureCard ? doc.measures.find(x => x.id === measureCard?.id) : undefined);
  const cardSector = $derived(cardMeasure ? doc.sectors.find(x => x.id === cardMeasure.sectorId) : undefined);
  const captureSector = $derived(captureMenu ? doc.sectors.find(x => x.id === captureMenu?.ctx.sectorId) : undefined);

  const rel = (e: { clientX: number; clientY: number } | P): P => {
    const r = svg.getBoundingClientRect();
    const x = 'clientX' in e ? e.clientX : e.x, y = 'clientY' in e ? e.clientY : e.y;
    return { x: x - r.left, y: y - r.top };
  };
  const toWorld = (e: { clientX: number; clientY: number }) => worldFromClient(e.clientX, e.clientY, svg.getBoundingClientRect(), view2d);
  const buzz = () => { try { navigator.vibrate?.(10); } catch { /* not supported */ } };
  const preview = $derived.by(() => {
    if (!drag?.moved) return null;
    try {
      const at = drag.kind === 'measure' ? measureAt(drag) : drag;
      const snapped = snapWorld(doc, at);
      const sec = doc.sectors.find(x => x.id === snapped.sectorId)!;
      const [lo, hi] = RING_R[ringOfRadius(snapped.r)];
      return { band: annularSectorPath(lo * SCALE, hi * SCALE, sec.startDeg, sec.widthDeg), sectorId: sec.id };
    } catch { return null; }
  });

  /** Where a dragged measure's center is now (it moves with the pointer, keeping its offset). */
  function measureAt(d: Drag): P {
    const m = scene.measures.find(x => x.id === d.id);
    return m ? { x: m.x + d.x - d.wx, y: m.y + d.y - d.wy } : { x: d.x, y: d.y };
  }
  const moving = $derived(drag?.kind === 'measure' && drag.moved ? { id: drag.id, dx: drag.x - drag.wx, dy: drag.y - drag.wy } : null);
  /** Units that travel with the area being dragged. */
  const movingMembers = $derived(new Set(moving ? doc.measures.find(m => m.id === moving.id)?.members ?? [] : []));
  function openMeasure(id: string) {
    const m = scene.measures.find(x => x.id === id);
    if (!m) return;
    const sx = view2d.x + m.x * view2d.k, sy = view2d.y + m.y * view2d.k;
    measureCard = { id, x: Math.max(8, Math.min(sx - 120, container.clientWidth - 248)), y: Math.max(8, Math.min(sy + 24, container.clientHeight - 300)) };
  }
  function unitUnder(e: { clientX: number; clientY: number }): string | null {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el?.closest('[data-unit-id]')?.getAttribute('data-unit-id') ?? null;
  }
  function capture(e: PointerEvent) { try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ } }
  function endPress() { clearTimeout(pressTimer); pressTimer = undefined; }
  /** Drop whatever one finger was doing (a second finger landed, or the browser cancelled). */
  function abortSingle() { endPress(); drag = null; link = null; lifted = null; gesture = null; }

  function startPinch() {
    abortSingle();
    const [a, b] = [...pointers.keys()];
    gesture = { kind: 'pinch', a, b, a0: rel(pointers.get(a)!), b0: rel(pointers.get(b)!), view: { ...view2d } };
  }

  function onPointerDown(e: PointerEvent) {
    lastPointerType = e.pointerType;
    const isTouch = e.pointerType === 'touch';
    if (!isTouch && (e.button !== 0 || e.ctrlKey)) return;
    const target = e.target as Element;
    if (captureMenu) captureMenu = null;
    if (measureCard) measureCard = null;
    if (unitMenu) unitMenu = null;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(anim);
    if (pointers.size === 2) { capture(e); startPinch(); return; }
    if (pointers.size > 2) return;
    capture(e);
    const handle = target.closest?.('.handle');
    if (handle && selectedUnit) {
      const w = toWorld(e);
      link = { fromId: selectedUnit.id, pointerId: e.pointerId, x: w.x, y: w.y, targetId: null, valid: false };
      return;
    }
    if (target.closest?.('[data-beyond]')) return; // the chevron's click opens the list
    let unitId = target.closest?.('[data-unit-id]')?.getAttribute('data-unit-id') ?? null;
    let measureId = unitId ? null : target.closest?.('[data-measure-id]')?.getAttribute('data-measure-id') ?? null;
    // A press on an OBJ/EA/NAI outline or label beats a unit *label* drawn over it (not a unit symbol):
    // look through the stack under the point. Touch adjustment can also retarget a finger to a nearby label.
    if (!measureId && (!unitId || target.closest?.('.unit-labels'))) {
      const stack = document.elementsFromPoint?.(e.clientX, e.clientY) ?? [];
      const m = stack.find(el => el.closest?.('[data-measure-id]'))?.closest('[data-measure-id]')?.getAttribute('data-measure-id');
      if (m && !stack.some(el => el.closest?.('g.unit'))) { measureId = m; unitId = null; }
    }
    if ((unitId || measureId) && !isTouch) {
      const w = toWorld(e);
      drag = { id: (unitId ?? measureId)!, kind: unitId ? 'unit' : 'measure', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, x: w.x, y: w.y, wx: w.x, wy: w.y, lifted: false };
      return;
    }
    const g: Gesture = { kind: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, view: { ...view2d }, moved: false, touch: isTouch, unitId, measureId };
    gesture = g;
    if (!isTouch) return;
    endPress();
    pressTimer = setTimeout(() => {
      if (gesture !== g || g.moved) return;
      gesture = null;
      buzz();
      if (unitId || measureId) {
        // Lifted: drag to move, or let go to open the inspector.
        const w = worldFromClient(g.sx, g.sy, svg.getBoundingClientRect(), view2d);
        drag = { id: (unitId ?? measureId)!, kind: unitId ? 'unit' : 'measure', pointerId: g.id, sx: g.sx, sy: g.sy, moved: false, x: w.x, y: w.y, wx: w.x, wy: w.y, lifted: true };
        lifted = drag.id;
      } else {
        try {
          const ctx = contextAt(doc, worldFromClient(g.sx, g.sy, svg.getBoundingClientRect(), view2d));
          const p = rel({ x: g.sx, y: g.sy });
          captureMenu = { x: Math.max(8, Math.min(p.x - 110, container.clientWidth - 228)), y: p.y + 16, py: p.y, ctx };
        } catch { /* no sectors */ }
      }
    }, unitId || measureId ? LONG_PRESS : LONG_PRESS_GROUND);
  }

  function onPointerMove(e: PointerEvent) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (drag && e.pointerId === drag.pointerId) {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > (drag.lifted ? 2 : 4)) drag.moved = true;
      if (drag.moved) { const w = toWorld(e); drag.x = w.x; drag.y = w.y; }
    } else if (link && e.pointerId === link.pointerId) {
      const w = toWorld(e);
      const target = unitUnder(e);
      link.x = w.x; link.y = w.y;
      link.targetId = target && target !== link.fromId ? target : null;
      link.valid = link.targetId !== null && !('error' in attackCommand(doc, link.fromId, link.targetId));
    } else if (gesture?.kind === 'pinch') {
      const a = pointers.get(gesture.a), b = pointers.get(gesture.b);
      if (!a || !b) return;
      userMoved = true;
      applyView(pinchView(gesture.view, gesture.a0, gesture.b0, rel(a), rel(b)));
    } else if (gesture?.kind === 'pan' && e.pointerId === gesture.id) {
      const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
      if (!gesture.moved && Math.hypot(dx, dy) > (gesture.touch ? TOUCH_SLOP : MOUSE_SLOP)) { gesture.moved = true; endPress(); }
      if (gesture.moved) { userMoved = true; applyView({ x: gesture.view.x + dx, y: gesture.view.y + dy, k: gesture.view.k }); }
    }
  }

  function tap(g: Extract<Gesture, { kind: 'pan' }>, e: PointerEvent) {
    const double = lastTap !== null && e.timeStamp - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX && lastTap.unitId === g.unitId && lastTap.measureId === g.measureId;
    lastTap = double ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY, unitId: g.unitId, measureId: g.measureId };
    if (g.measureId) {
      if (double) openMeasure(g.measureId);
    } else if (g.unitId) {
      selectUnit(g.unitId);
      oninspect?.(g.unitId, double ? 'full' : 'peek');
    } else if (g.touch && double) {
      userMoved = true;
      animateTo(zoomAround(view2d, rel(e), 2), 220);
    } else selectUnit(null);
  }

  function onPointerUp(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return;
    if (drag && e.pointerId === drag.pointerId) {
      const d = drag;
      drag = null; lifted = null;
      if (d.moved) {
        try { run(d.kind === 'measure' ? measureDropCommand(doc, d.id, measureAt(d), { x: d.x - d.wx, y: d.y - d.wy }) : dropCommand(doc, d.id, d, scene.measures)); } catch (err) { toast(err instanceof Error ? err.message : String(err)); }
      } else if (d.kind === 'measure') {
        if (d.lifted) openMeasure(d.id);
      } else {
        selectUnit(d.id);
        if (d.lifted) oninspect?.(d.id, 'full');
      }
    } else if (link && e.pointerId === link.pointerId) {
      const l = link;
      link = null;
      const target = unitUnder(e);
      if (!target || target === l.fromId) return;
      const cmd = attackCommand(doc, l.fromId, target);
      if ('error' in cmd) { toast(cmd.error); return; }
      const before = new Set(doc.orders.map(o => o.id));
      if (run(cmd)) {
        const made = getDoc().orders.find(o => !before.has(o.id) && o.from === l.fromId && o.to === target);
        if (made) { freshOrder = made.id; clearTimeout(freshTimer); freshTimer = setTimeout(() => (freshOrder = null), 3000); }
        const from = doc.units.find(u => u.id === l.fromId), to = doc.units.find(u => u.id === target);
        onnotice?.(`${from?.designation ?? l.fromId} ATTACKS ${to?.designation ?? target}${cmd.args.role === 'main' ? ' (MAIN)' : ''}`);
      }
    } else if (gesture?.kind === 'pinch') {
      // One finger left: keep panning with it (never a tap).
      const rest = [...pointers.entries()][0];
      gesture = rest ? { kind: 'pan', id: rest[0], sx: rest[1].x, sy: rest[1].y, view: { ...view2d }, moved: true, touch: true, unitId: null, measureId: null } : null;
    } else if (gesture?.kind === 'pan' && e.pointerId === gesture.id) {
      const g = gesture;
      gesture = null; endPress();
      if (!g.moved) tap(g, e);
    }
  }
  function onPointerCancel(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) abortSingle();
  }
  function onDblClick(e: MouseEvent) {
    // Touch double-tap is handled from pointer events (zoom); the dblclick that some browsers add is ignored.
    if (lastPointerType !== 'mouse' && lastPointerType !== 'pen') return;
    const measureId = (e.target as Element).closest('[data-measure-id]')?.getAttribute('data-measure-id');
    if (measureId) { openMeasure(measureId); return; }
    if ((e.target as Element).closest('[data-interactive]')) return;
    try { oncontextnew?.(contextAt(doc, toWorld(e))); } catch { /* no sectors */ }
  }
  function onMapKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && (captureMenu || measureCard || unitMenu)) { captureMenu = null; measureCard = null; unitMenu = null; return; }
    if (e.key === 'Escape' && selection.selectedId) selectUnit(null);
  }
  function unitKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectUnit(id); }
    // The keyboard's context-menu key, or Shift+F10: the unit's menu at its symbol.
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const su = scene.units.find(u => u.id === id);
      if (su) openUnitMenu(id, { x: view2d.x + su.x * view2d.k, y: view2d.y + su.y * view2d.k });
    }
  }

  // ---------- right-click (desktop) ----------
  // A unit: its menu. An OBJ/EA/NAI: its card. Open ground: the capture menu. Touch keeps long-press.
  type MenuItem = { key: string; label: string; act: () => void; warn?: boolean; sep?: boolean };
  let unitMenu = $state<{ id: string; x: number; y: number; py: number } | null>(null);
  let unitMenuEl = $state<HTMLDivElement | undefined>();
  let unitMenuH = $state(0);
  const MENU_W = 220;
  const menuX = (x: number) => Math.max(8, Math.min(x, (container?.clientWidth ?? 0) - MENU_W - 8));
  const menuUnit = $derived(unitMenu ? doc.units.find(u => u.id === unitMenu?.id) : undefined);
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (lastPointerType === 'touch') return;
    captureMenu = null; measureCard = null; unitMenu = null;
    const t = e.target as Element;
    if (t.closest('[data-beyond]') || t.closest('.handle')) return;
    const p = rel(e);
    const unitId = t.closest('[data-unit-id]')?.getAttribute('data-unit-id');
    if (unitId && doc.units.some(u => u.id === unitId)) { openUnitMenu(unitId, p); return; }
    const measureId = t.closest('[data-measure-id]')?.getAttribute('data-measure-id');
    if (measureId) { openMeasure(measureId); return; }
    try { captureMenu = { x: menuX(p.x), y: p.y + 2, py: p.y, ctx: contextAt(doc, toWorld(e)) }; } catch { /* no sectors */ }
  }
  function openUnitMenu(id: string, p: P) {
    selectUnit(id);
    unitMenu = { id, x: menuX(p.x), y: p.y + 2, py: p.y };
    void tick().then(() => unitMenuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  }
  /** Finish in the command bar: `text` with the caret at its end, or at `caret`. */
  const ask = (text: string, caret?: number) => () => oncommandtext?.(text, caret);
  /** Run at once, then confirm with the order line and an Undo, as a drag-made attack does. */
  const act = (verb: string, args: Record<string, unknown> = {}) => () => {
    if (!unitMenu) return;
    const cmd = { verb, args: { unit: unitMenu.id, ...args } };
    try { const res = dispatch(cmd); if (res.ok) onnotice?.(res.log); else toast(res.error); }
    catch (e) { toast(`Could not ${verb}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  function unitMenuItems(u: Unit): MenuItem[] {
    const d = u.designation, items: MenuItem[] = [];
    const threat = u.affiliation === 'hostile' || u.affiliation === 'suspect';
    if (u.lifecycle === 'done' || u.lifecycle === 'dropped') {
      items.push({ key: 'note', label: 'Note…', act: ask(`/note ${d} ""`, `/note ${d} "`.length) });
      return items;
    }
    if (canAttack(u)) items.push({ key: 'attack', label: 'Attack…', act: ask(`/attack ${d} `) });
    items.push({ key: 'move', label: 'Move…', act: ask(`/move ${d} to `) });
    items.push({ key: 'due', label: 'Due date…', act: ask(`/due ${d} `) });
    items.push({ key: 'note', label: 'Note…', act: ask(`/note ${d} ""`, `/note ${d} "`.length) });
    const first = items.length;
    if (!threat) items.push(u.lifecycle === 'blocked'
      ? { key: 'unblock', label: 'Unblock', act: act('unblock') }
      : { key: 'block', label: 'Block…', act: ask(`/block ${d} by ""`, `/block ${d} by "`.length) });
    if (u.posOverride) items.push({ key: 'unpin', label: 'Unpin', act: act('unpin') });
    if (doc.orders.some(o => o.from === u.id)) items.push({ key: 'halt', label: 'Halt orders', act: act('halt') });
    items.push({ key: 'key', label: u.keyTerrain ? 'Clear key terrain' : 'Mark key terrain', act: act('key') });
    if (items[first]) items[first].sep = true;
    items.push({ key: 'done', label: threat ? 'Destroyed' : 'Done', act: act('done'), sep: true });
    items.push({ key: 'drop', label: threat ? 'Bypassed' : 'Drop', act: act('drop', threat ? { bypassed: true } : {}), warn: true });
    return items;
  }
  function chooseUnitItem(item: MenuItem) {
    item.act();
    unitMenu = null;
  }
  function unitMenuKey(e: KeyboardEvent) {
    const items = [...(unitMenuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); unitMenu = null; svg?.focus(); }
  }
  function chooseCapture(identity?: string) {
    const m = captureMenu;
    captureMenu = null;
    if (m) oncontextnew?.(m.ctx, identity);
  }

  // ---------- withdraw animation (dropped friendlies return to HQ) ----------
  function leave(node: Element, p: { id: string; x: number; y: number }) {
    const u = getDoc().units.find(x => x.id === p.id);
    const home = Boolean(u && (u.lifecycle === 'dropped' || u.lifecycle === 'done') && u.affiliation !== 'hostile' && u.affiliation !== 'suspect');
    if (reducedMotion()) return { duration: 0 };
    return {
      duration: home ? 700 : 280,
      css: (t: number) => (home ? `transform: translate(${-p.x * (1 - t)}px, ${-p.y * (1 - t)}px); opacity: ${t}` : `opacity: ${t}`),
    };
  }

  // ---------- hover label ----------
  /** ' · HQ', ' · MAIN CP', with the size of its organization when units are attached. */
  function hqTag(u: Unit): string {
    if (u.fn !== 'hq' && !u.cp) return '';
    const n = doc.units.filter(x => x.parentId === u.id).length;
    return ` · ${u.cp ? `${u.cp.toUpperCase()} CP` : 'HQ'}${n ? ` of ${n}` : ''}`;
  }
  const AFF: Record<Unit['affiliation'], string> = { pending: 'Pending (not looked at)', unknown: 'Unknown', assumed: 'Assumed friend', friend: 'Friend', neutral: 'Neutral', suspect: 'Suspect', hostile: 'Hostile' };
  const RING_WORDS: Record<Ring, string> = { hq: 'HQ perimeter · today/overdue', near: 'Close · ≤ 7 days', mid: 'Deep · 8–30 days', far: 'Area of interest · 31–90 days', beyond: 'Beyond · > 90 days' };
  const hovered = $derived(!drag && !link ? scene.units.find(u => u.id === selection.hoveredId && !u.selected) : undefined);
  const hoverPos = $derived(hovered ? { x: view2d.x + hovered.x * view2d.k, y: view2d.y + hovered.y * view2d.k } : null);
  const canAttack = (u: Unit) => (u.affiliation === 'friend' || u.affiliation === 'assumed') && u.lifecycle !== 'done' && u.lifecycle !== 'dropped';
  const PIN = 'M0 0 L0 -7 M-2.6 -9.4 a2.6 2.6 0 1 0 5.2 0 a2.6 2.6 0 1 0 -5.2 0';
  const RING_NAME: Record<Ring, string> = { hq: 'HQ', near: 'close', mid: 'deep', far: 'far', beyond: 'beyond' };
</script>

<!-- A press outside the map (sidebars, bars) closes its right-click menus; the map's own presses close them too. -->
<svelte:window onpointerdown={(e) => {
  const t = e.target as Element;
  if (!t.isConnected || t.closest?.('.capture-menu') || container?.contains(t)) return;
  unitMenu = null; if (!touch) captureMenu = null;
}} />

<div class="opsmap" data-theme={theme} bind:this={container} bind:clientHeight={mapH}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg bind:this={svg} class="map-svg" role="application" aria-label="Tactical map" tabindex="-1" data-zoom={view2d.k.toFixed(4)}
    class:dragging={drag?.moved || link}
    onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerCancel}
    ondblclick={onDblClick} onkeydown={onMapKey} oncontextmenu={onContextMenu}>
    <g transform="translate({view2d.x} {view2d.y}) scale({view2d.k})">
      <TerrainLayer {terrain} {uid} {s} {mt} />
      <FrameworkLayer {scene} {uid} {s} {mt} declutter={compactPl} {theme} view={doc.settings.view} activeSectorId={preview?.sectorId ?? selectedUnit?.sectorId ?? null} {onbeyond} />
      {#if preview}<path d={preview.band} class="snap-band" />{/if}
      <OrderLayer {scene} {s} {mt} {declutter} {moving} freshId={freshOrder} liftedId={drag?.kind === 'measure' ? lifted : null} hitW={(touch ? 24 : 12) / view2d.k} {theme} selectedId={selection.selectedId} />

      <!-- Ghosts and trails from the last auto-advance -->
      <g class="ghosts" aria-hidden="true">
        {#each scene.ghosts as g (g.unitId)}
          {@const sym = unitSymbol(g.unit, 'commander', UNIT_SIZE, theme, {bare:true})}
          <path d={g.trail} class="trail" />
          <image href={sym.href} x={g.x - sym.center.x * s} y={g.y - sym.center.y * s} width={sym.width * s} height={sym.height * s} class="ghost" />
        {/each}
      </g>

      <!-- Penetration markers for overdue threats inside PL TODAY -->
      {#each scene.units as su (su.id)}
        {#if su.penetrationPath}<path d={su.penetrationPath} class="pen" />{/if}
      {/each}

      <g class="units">
        {#each scene.units as su (su.id)}
          {@const sym = unitSymbol(su.unit, su.symbolView, UNIT_SIZE * (su.ring==='hq'?0.6:1), theme, { contact: su.contact, bare:true })}
          {@const dragging = drag?.kind === 'unit' && drag?.id === su.id && drag.moved}
          {@const carried = moving && movingMembers.has(su.id)}
          {@const x = dragging && drag ? drag.x : carried ? su.x + moving!.dx : su.x}
          {@const y = dragging && drag ? drag.y : carried ? su.y + moving!.dy : su.y}
          <g class="unit" class:dragging class:lifted={drag?.kind === 'unit' && lifted === su.id} class:selected={su.selected} class:link-target={link?.targetId === su.id}
            class:link-valid={link?.targetId === su.id && link.valid} class:complete={su.unit.lifecycle === 'done' && su.unit.affiliation === 'friend'}
            data-unit-id={su.id} data-interactive transform="translate({x} {y})"
            role="button" tabindex="0" aria-label="{su.unit.designation}: {su.unit.title}"
            ondblclick={(e) => e.stopPropagation()} onkeydown={(e) => unitKey(e, su.id)}
            onpointerenter={(e) => { if (e.pointerType !== 'touch') selection.hoveredId = su.id; }}
            onpointerleave={() => { if (selection.hoveredId === su.id) selection.hoveredId = null; }}>
            <g out:leave={{ id: su.id, x: su.x, y: su.y }}>
              {#if su.pulse}<circle r={21 * s} class="pulse" />{/if}
              {#if su.selected}<circle r={23 * s} class="sel-ring" />{:else if selection.hoveredId === su.id}<circle r={22 * s} class="hover-ring" />{/if}
              {#each remote.filter(r => r.unitId === su.id) as r, i (r.userId)}
                <g class="remote-sel" data-testid="remote-selection" data-user-id={r.userId} style="--who:{r.color}">
                  <circle r={(26 + i * 4) * s} />
                  <text x={(18 + i * 4) * s} y={-20 * s - i * 9 * s} font-size={Math.max(9 * s, mt)}>{r.initials}<title>Selected by {r.name}</title></text>
                </g>
              {/each}
              {#if flashId === su.id}<circle r={24 * s} class="flash" />{/if}
              {#if link?.targetId === su.id}<circle r={23 * s} class="target-ring" />{/if}
              <rect x={-20*s} y={-24*s} width={40*s} height={48*s} fill="transparent" />
              <!-- Placed by the frame center, so an HQ's frame sits on its spot and its staff hangs below. -->
              <image pointer-events="none" href={sym.href} x={-sym.center.x * s} y={-sym.center.y * s} width={sym.width * s} height={sym.height * s} />
              {#if su.unit.lifecycle === 'done' && su.unit.affiliation === 'friend'}
                <path d="M0 0 H20 M14 -4 L20 0 L14 4" transform="translate(0 {28*s}) rotate({su.unit.pos.theta+180}) scale({s})" class="withdraw" />
              {/if}
              {#if su.unit.keyTerrain}
                {@const kt = keyTerrainSymbol(11, theme)}
                <image href={kt.href} x={-22 * s - kt.anchor.x * s} y={-17 * s - kt.anchor.y * s} width={kt.width * s} height={kt.height * s} class="kt"><title>Key terrain</title></image>
              {/if}
              {#if su.pinned}
                <path d={PIN} transform="translate({-17 * s} {-12 * s}) scale({s})" class="pin"><title>Placed by hand: skipped by auto-advance</title></path>
              {/if}
            </g>
          </g>
        {/each}
      </g>

      <g class="unit-labels">
        {#each scene.units.filter(u => labels.has(u.id)) as su (su.id)}
          {@const label=labels.get(su.id)!}
          {@const b=label.box}
          {@const ex=Math.max(b.x,Math.min(b.x+b.width,su.x))}
          {@const ey=Math.max(b.y,Math.min(b.y+b.height,su.y))}
          {@const dl=Math.hypot(ex-su.x,ey-su.y)}
          <g data-unit-id={su.id} data-interactive role="button" tabindex="-1" aria-label="{su.unit.designation} label"
             ondblclick={(e)=>e.stopPropagation()} onkeydown={(e)=>unitKey(e,su.id)}>
            {#if dl>22*s}
              {@const sx0=su.x+(ex-su.x)*(20*s/dl)}
              {@const sy0=su.y+(ey-su.y)*(20*s/dl)}
              <!-- Leader from the symbol's edge, with a dot there, so the label reads as this unit's. -->
              <line x1={sx0} y1={sy0} x2={ex} y2={ey} class="label-leader" stroke-width={1.25/view2d.k} />
              <circle cx={sx0} cy={sy0} r={2/view2d.k} class="label-dot" />
            {/if}
            <rect x={b.x} y={b.y} width={b.width} height={b.height} class="label-ground" />
            {#each label.lines as line,i}<text x={b.x+4*s} y={b.y+(12+i*13)*s*ls} font-size={10.5*s*ls} class="label-text">{line}</text>{/each}
            {#if label.strength!==undefined}
              {@const k=band(label.strength)!}
              <rect x={b.x+3*s} y={b.y+(label.lines.length*13+2)*s*ls} width={Math.min(b.width-6*s,67*s*ls)} height={12*s*ls} rx={2*s} class="strength-tag {k}" />
              <text x={b.x+6*s} y={b.y+(label.lines.length*13+11)*s*ls} font-size={10.5*s*ls} class="strength-text">{k[0].toUpperCase()} {label.strength}%</text>
            {/if}
          </g>
        {/each}
      </g>

      <!-- Edge handle: drag onto a hostile to attack. Touch: a 44 px target below the symbol. -->
      {#if selectedUnit && canAttack(selectedUnit) && !drag?.moved && !lifted}
        {@const su = scene.units.find(u => u.id === selectedUnit.id)}
        {#if su}
          {@const dot = touch ? 11 / view2d.k : 6 * s}
          {@const g = dot / 6}
          <g class="handle" class:touch data-interactive data-testid="attack-handle" transform="translate({su.x} {su.y + (touch ? 24 * s + 24 / view2d.k : 22 * s)})" role="button" tabindex="-1"
            aria-label="Drag onto a hostile to attack">
            {#if touch}<circle r={22 / view2d.k} class="handle-hit" />{/if}
            <circle r={dot} class="handle-dot" />
            <path d="M{-2.5 * g} {-1.5 * g} L0 {1.5 * g} L{2.5 * g} {-1.5 * g}" class="handle-glyph" />
            <title>Drag onto a hostile or suspect to attack</title>
          </g>
        {/if}
      {/if}
      {#if link}
        {@const from = scene.units.find(u => u.id === link?.fromId)}
        {#if from}<line x1={from.x} y1={from.y} x2={link.x} y2={link.y} class="rubber" class:valid={link.valid} />{/if}
        {#if link.targetId}
          {@const tu = doc.units.find(u => u.id === link?.targetId)}
          <!-- The target's name beside the finger, so the user sees what the drop will hit. -->
          {#if tu}<text x={link.x} y={link.y - 40 / view2d.k} font-size={14 / view2d.k} class="link-name" class:valid={link.valid} text-anchor="middle">{link.valid ? '⚔ ' : ''}{tu.designation}</text>{/if}
        {/if}
      {/if}
    </g>
  </svg>

  <!-- Touch: Fit sits bottom right, above the sheet, in thumb reach. -->
  <div class="map-controls" class:touch aria-label="Map zoom" style={touch ? `right:${insets.right+8}px;bottom:${insets.bottom+8}px` : `left:${insets.left+8}px;top:${insets.top+8}px`}>
    {#if !touch}
      <button class="btn" aria-label="Zoom in" onclick={()=>zoomBy(1.25)}>+</button>
      <button class="btn" aria-label="Zoom out" onclick={()=>zoomBy(1/1.25)}>−</button>
    {/if}
    <button class="btn" onclick={fitView}>Fit</button>
  </div>
  {#if measureCard && cardMeasure}
    {@const mm = cardMeasure}
    {@const sec = cardSector}
      <div class="capture-menu measure-card" role="dialog" aria-label="{mm.type.toUpperCase()} {mm.name}" data-testid="measure-card" bind:offsetHeight={cardH} style="left:{measureCard.x}px; top:{Math.max(8, Math.min(measureCard.y, mapH - (insets?.bottom ?? 0) - cardH - 8))}px">
        <div class="cm-title"><b>{mm.type.toUpperCase()}</b> {mm.name}</div>
        <div class="cm-meta">{({ obj: 'Objective', ea: 'Engagement area', nai: 'Named area of interest', pl: 'Phase line' })[mm.type]}{sec ? ` · ${sec.name}` : ''}{mm.pos ? ` · ${RING_NAME[ringOfRadius(mm.pos.r)]} ring` : ''}</div>
        <div class="cm-meta">{touch ? 'Long-press and drag to move it.' : 'Drag its outline or label to move it.'} Or: /{mm.type} move {mm.name} ‹ring›</div>
        {#if mm.type !== 'pl'}
          {@const inside = areaMembers(doc, mm).map(u => u.designation)}
          <div class="cm-meta" data-testid="area-members"><b>{inside.length ? `Holds ${inside.join(', ')}.` : 'Empty.'}</b> Drop a unit inside to add it; drag it out to remove it.</div>
          <div class="cm-sizes" role="radiogroup" aria-label="Minimum size">
            {#each AREA_SIZE_NAMES as key (key)}
              <button class="btn" role="radio" aria-checked={areaSizeName(mm.size) === key} class:on={areaSizeName(mm.size) === key} data-size={key}
                onclick={() => { if (areaSizeName(mm.size) !== key) run({ verb: mm.type, args: { action: 'size', measure: mm.id, size: key } }); }}>{key === 'xl' ? 'XL' : key[0].toUpperCase() + key.slice(1)}</button>
            {/each}
          </div>
        {/if}
        <button class="btn warn" onclick={() => { const cmd = { verb: mm.type, args: { action: 'remove', measure: mm.id } }; measureCard = null; run(cmd); }}>Remove</button>
        <button class="btn" onclick={() => (measureCard = null)}>Close</button>
      </div>
  {/if}
  {#if unitMenu && menuUnit}
    {@const u = menuUnit}
    {@const um = unitMenu}
    <div class="capture-menu desk-menu" role="menu" tabindex="-1" aria-label="{u.designation} actions" data-testid="unit-menu" data-unit={u.id}
      bind:this={unitMenuEl} bind:offsetHeight={unitMenuH} onkeydown={unitMenuKey} oncontextmenu={(e) => e.preventDefault()}
      style="left:{um.x}px; top:{um.y + unitMenuH <= mapH - (insets?.bottom ?? 0) - 8 ? um.y : Math.max(8, um.py - unitMenuH - 2)}px">
      <div class="cm-title"><b>{u.designation}</b> {u.title}</div>
      {#each unitMenuItems(u) as item (item.key)}
        {#if item.sep}<div class="cm-sep" role="separator"></div>{/if}
        <button class="btn" class:warn={item.warn} role="menuitem" tabindex="-1" data-action={item.key} onclick={() => chooseUnitItem(item)}>{item.label}</button>
      {/each}
    </div>
  {/if}
  {#if captureMenu}
    {@const m = captureMenu}
    {@const sec = captureSector}
    <!-- Below the finger, or above it when the command bar or sheet would cover it; never under the finger, which lifts onto it. -->
    <div class="capture-menu" class:desk-menu={!touch} role="menu" aria-label="Capture here" data-testid="capture-menu" bind:offsetHeight={menuH}
      style="left:{m.x}px; top:{menuTop(m)}px">
      <div class="cm-title">New here · {sec?.name ?? m.ctx.sectorId} · {RING_NAME[m.ctx.ring]}</div>
      <button class="btn" role="menuitem" onclick={() => chooseCapture()}>New unit</button>
      <button class="btn" role="menuitem" onclick={() => chooseCapture('hostile')}>New problem (hostile)</button>
      <button class="btn" role="menuitem" onclick={() => chooseCapture('hostile hq')}>New hostile HQ</button>
      <button class="btn" role="menuitem" onclick={() => (captureMenu = null)}>Cancel</button>
    </div>
  {/if}
  {#if hovered && hoverPos}
    {@const u = hovered.unit}
    <div class="hover-label" class:west={hovered.x<0} style="left:{hoverPos.x}px; top:{hoverPos.y - 30 * s * view2d.k}px">
      <div class="hl-title"><b>{u.designation}</b> {u.title}</div>
      <div class="hl-meta">{AFF[u.affiliation]}{hqTag(u)} · {u.presence === 'planned' ? 'planned' : 'present'} · {u.lifecycle}{u.echelon ? ` · ${u.echelon.toUpperCase()}` : ''}</div>
      <div class="hl-meta">{RING_WORDS[hovered.ring]}{u.dueAt ? ` · due ${formatDtg(u.dueAt)}` : ''}{u.posOverride ? ' · pinned' : ''}</div>
    </div>
  {/if}

  {#if toasts.length}
    <div class="toasts" role="status" aria-live="polite">
      {#each toasts as t (t.id)}<div class="toast">{t.text}</div>{/each}
    </div>
  {/if}
</div>

<style>
  .opsmap {
    --om-font: 'IBM Plex Mono', 'JetBrains Mono', 'DejaVu Sans Mono', ui-monospace, monospace;
    --om-font-cond: 'IBM Plex Sans Condensed', 'Roboto Condensed', 'Arial Narrow', 'DejaVu Sans Condensed', sans-serif;
    --om-ground: #eee7d3;
    --om-band: rgba(120, 104, 70, 0.1);
    --om-sector-a: rgba(255, 252, 240, 0.18);
    --om-sector-b: rgba(120, 100, 60, 0.045);
    --om-sector-active: rgba(212, 138, 0, 0.045);
    --om-contour: rgba(150, 102, 52, 0.26);
    --om-contour-index: rgba(140, 92, 44, 0.45);
    --om-water: #5a8fbf;
    --om-water-bank: rgba(90, 143, 191, 0.18);
    --om-woods: rgba(112, 146, 84, 0.1);
    --om-woods-edge: rgba(92, 126, 66, 0.35);
    --om-woods-hatch: rgba(92, 126, 66, 0.2);
    --om-ink: #23211c;
    --om-ink-soft: rgba(35, 33, 28, 0.55);
    --om-pl: rgba(35, 33, 28, 0.62);
    --om-pl-custom: #7a4b9a;
    --om-friend: #1c3f8c;
    --om-hostile: #c4142b;
    --om-select: #d48a00;
    --om-halo: #eee7d3;
    --om-measure-fill: rgba(35, 33, 28, 0.035);
    --om-axis-fill: rgba(28, 63, 140, 0.07);
    --om-panel: rgba(250, 247, 238, 0.96);
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--om-ground);
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    touch-action: none;
  }
  .opsmap[data-theme='dark'] {
    --om-ground: #171f1b;
    --om-band: rgba(0, 0, 0, 0.22);
    --om-sector-a: rgba(255, 255, 255, 0.012);
    --om-sector-b: rgba(160, 200, 160, 0.03);
    --om-sector-active: rgba(255, 176, 46, 0.06);
    --om-contour: rgba(130, 170, 135, 0.1);
    --om-contour-index: rgba(140, 180, 145, 0.2);
    --om-water: #2f6489;
    --om-water-bank: rgba(47, 100, 137, 0.2);
    --om-woods: rgba(70, 110, 70, 0.08);
    --om-woods-edge: rgba(100, 150, 100, 0.2);
    --om-woods-hatch: rgba(100, 150, 100, 0.1);
    --om-ink: #c9d4c4;
    --om-ink-soft: rgba(201, 212, 196, 0.5);
    --om-pl: rgba(201, 212, 196, 0.55);
    --om-pl-custom: #c49ae0;
    --om-friend: #86a9ff;
    --om-hostile: #ff5d5d;
    --om-select: #ffb02e;
    --om-halo: #171f1b;
    --om-measure-fill: rgba(201, 212, 196, 0.03);
    --om-axis-fill: rgba(134, 169, 255, 0.07);
    --om-panel: rgba(22, 30, 26, 0.96);
  }
  .unit.complete { opacity:0.6; }
  .withdraw { stroke:var(--om-friend);stroke-width:2;fill:none; }
  .label-leader {stroke:var(--om-ink);opacity:0.8;pointer-events:none;}
  .label-dot {fill:var(--om-ink);pointer-events:none;}
  .label-ground {fill:var(--om-ground);fill-opacity:0.92;}
  .label-text {fill:var(--om-ink);font-family:var(--om-font);font-weight:600;pointer-events:none;}
  .strength-tag.green {fill:#28652d;} .strength-tag.amber {fill:#845600;} .strength-tag.red {fill:#a01823;} .strength-tag.black {fill:#171917;stroke:#c9d4c4;stroke-width:0.5;}
  .strength-text {fill:white;font-family:var(--om-font);pointer-events:none;}
  .map-controls {position:absolute;height:24px;display:flex;gap:4px;}
  .map-controls.touch {height:44px;}
  .map-controls.touch .btn {height:44px;min-width:44px;justify-content:center;font-size:14px;}
  .capture-menu { position:absolute; z-index:4; width:220px; display:flex; flex-direction:column; gap:4px; padding:8px; background:var(--om-panel); color:var(--om-ink); border:2px solid var(--om-ink); box-shadow:0 4px 16px rgba(0,0,0,0.25); }
  .capture-menu .btn { height:44px; justify-content:center; }
  /* Desktop menus (right-click): compact rows, left-aligned, keyboard focus visible. */
  .desk-menu { gap:0; padding:4px; }
  .desk-menu .btn { height:28px; justify-content:flex-start; border-color:transparent; background:transparent; padding:0 8px; }
  .desk-menu .btn:hover, .desk-menu .btn:focus-visible { background:var(--om-ink); color:var(--om-panel); outline:none; }
  .desk-menu .btn.warn { color:var(--om-hostile); }
  .desk-menu .btn.warn:hover, .desk-menu .btn.warn:focus-visible { background:var(--om-hostile); color:#fff; }
  .desk-menu .cm-title { padding:4px 8px 6px; border-bottom:1px solid var(--om-ink-soft); margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-transform:none; letter-spacing:0.02em; }
  .cm-sep { height:1px; margin:4px 2px; background:var(--om-ink-soft); opacity:0.5; }
  .cm-title { font:600 12px/1.3 var(--om-font-cond); letter-spacing:0.08em; text-transform:uppercase; padding:2px 2px 4px; }
  .measure-card { width: 240px; }
  .cm-meta { font: 12px/1.35 var(--om-font); padding: 0 2px 4px; }
  .cm-sizes { display:flex; margin: 2px 0 6px; }
  .cm-sizes .btn { flex:1; height:32px; padding:0 4px; }
  .cm-sizes .btn + .btn { margin-left:-1px; }
  .cm-sizes .btn.on { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .map-svg { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
  .map-svg:active { cursor: grabbing; }
  .map-svg.dragging { cursor: grabbing; }
  .snap-band { fill: var(--om-select); opacity: 0.12; stroke: var(--om-select); stroke-width: 1; stroke-dasharray: 4 3; pointer-events: none; }
  .unit { cursor: pointer; outline: none; }
  .unit.dragging { cursor: grabbing; opacity: 0.85; }
  /* Long-press fired: the symbol lifts, so the user knows they can drag it or let go. */
  .unit.lifted > g { transform: scale(1.18); filter: drop-shadow(0 6px 5px rgba(0, 0, 0, 0.4)); transition: transform 120ms ease-out; }
  @media (prefers-reduced-motion: reduce) { .unit.lifted > g { transition: none; } }
  .unit:focus-visible .hover-ring, .unit:focus-visible image { filter: drop-shadow(0 0 3px var(--om-select)); }
  .remote-sel circle { fill: none; stroke: var(--who); stroke-width: 2.5; opacity: 0.9; }
  .remote-sel text { fill: var(--who); font-family: var(--font-mono); font-weight: 700; paint-order: stroke; stroke: var(--panel, #fff); stroke-width: 2px; }
  .sel-ring { fill: none; stroke: var(--om-select); stroke-width: 2; stroke-dasharray: 5 3; }
  .hover-ring { fill: none; stroke: var(--om-select); stroke-width: 1; opacity: 0.6; }
  .target-ring { fill: none; stroke: var(--om-ink-soft); stroke-width: 2; }
  .unit.link-valid .target-ring { stroke: var(--om-hostile); }
  .flash { fill: none; stroke: var(--om-select); stroke-width: 3; transform-box: fill-box; transform-origin: center; animation: flash 0.6s ease-out 3; }
  .pulse { fill: var(--om-hostile); opacity: 0; transform-box: fill-box; transform-origin: center; animation: pulse 2.4s ease-out infinite; pointer-events: none; }
  .pin { fill: none; stroke: var(--om-ink); stroke-width: 1.4; }
  .kt { pointer-events: none; }
  .pen { fill: var(--om-hostile); fill-opacity: 0.16; stroke: var(--om-hostile); stroke-width: 1.6; stroke-linejoin: miter; pointer-events: none; }
  .trail { fill: none; stroke: var(--om-hostile); stroke-width: 1.2; stroke-dasharray: 1.5 3.5; stroke-linecap: round; opacity: 0.55; }
  .ghost { opacity: 0.22; pointer-events: none; }
  .handle { cursor: crosshair; }
  .handle-hit { fill: transparent; }
  .handle-dot { fill: var(--om-halo); stroke: var(--om-friend); stroke-width: 1.6; }
  .handle.touch .handle-dot { stroke-width: 2.5; vector-effect: non-scaling-stroke; }
  .handle:hover .handle-dot { fill: var(--om-friend); }
  .handle-glyph { fill: none; stroke: var(--om-friend); stroke-width: 1.4; pointer-events: none; }
  .handle:hover .handle-glyph { stroke: var(--om-halo); }
  .rubber { stroke: var(--om-ink-soft); stroke-width: 2; stroke-dasharray: 6 4; pointer-events: none; }
  .rubber.valid { stroke: var(--om-friend); }
  .link-name { fill: var(--om-ink-soft); font-family: var(--om-font); font-weight: 700; paint-order: stroke; stroke: var(--om-halo); stroke-width: 4px; pointer-events: none; }
  .link-name.valid { fill: var(--om-hostile); }
  @keyframes pulse { 0% { transform: scale(0.8); opacity: 0.35; } 100% { transform: scale(1.9); opacity: 0; } }
  @keyframes flash { 0% { transform: scale(1.8); opacity: 0; } 50% { opacity: 1; } 100% { transform: scale(1); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; opacity: 0.22; }
    .flash { animation: none; }
  }
  .hover-label {
    position: absolute; transform: translate(24px, -100%); pointer-events: none; z-index: 2;
    background: var(--om-panel); color: var(--om-ink); border: 1px solid var(--om-ink-soft);
    padding: 4px 8px; font: 12px/1.35 var(--om-font); white-space: nowrap; box-shadow: 0 1px 0 rgba(0, 0, 0, 0.12);
  }
  .hover-label.west { transform:translate(calc(-100% - 24px),-100%); }
  .hl-title b { letter-spacing: 0.04em; }
  .hl-meta { opacity: 0.85; font-size: 12px; }
  .toasts { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 4px; z-index: 3; }
  .toast { background: var(--om-panel); color: var(--om-ink); border-left: 3px solid var(--om-hostile); padding: 6px 12px; font: 12px/1.4 var(--om-font); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); }
</style>
