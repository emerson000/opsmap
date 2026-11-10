import { DEFAULT_TZ, calendarDay, parts, zonedTime } from '../../core/model/time';
// Builds everything the map draws from a Doc: a pure projection, recomputed reactively.
import type { ControlMeasure, Doc, Order, Ring, Unit, View } from '../../core/model/types';
import { areaShape, polarToXY, radiusForDate, RING_R } from '../../core/model/geometry';
import { forceRatio } from '../../core/model/forceRatio';
import { annularSectorPath, arcTextPath, attackArrow, axisOutline, bentCurve, curvePath, labelAt, moveArrow, obstacleMark, type Curve, type Pt } from './arrows';
import { BEYOND_R, CHEVRON_R, HQ_CLEAR, MAP_EDGE_R, RIM_LABEL_R, SCALE, SECTOR_HQ_R, UNIT_CLEAR } from './constants';
import { ringOfRadius } from './interaction';
import { hashSeed, mulberry32, smoothPath } from './terrain';

export interface Trail { unitId: string; from: { r: number; theta: number } }
export interface SceneOptions { view: View; now: Date; selectedId?: string | null; trails?: Trail[]; symbolScale?: number; /** World font size of phase-line labels (sizes their arcs). */ plFont?: number;
  /** Phones at the fitted zoom: one staggered label per line, none on PL TODAY, custom lines low. */ compactPl?: boolean;
  /** Orders drawn even where the view would hide them (a just-made attack). */ showOrders?: string[] }

export interface SceneUnit {
  id: string; unit: Unit; x: number; y: number; ring: Ring; symbolView: View;
  pulse: boolean; penetration: boolean; penetrationPath?: string; contact: boolean; pinned: boolean; selected: boolean;
}
export interface SceneSector {
  id: string; name: string; index: number; startDeg: number; widthDeg: number; centerDeg: number;
  wedge: string; band: string; rimPath: string;
  boundary: { segments: [Pt, Pt][]; mark: Pt & { angle: number } };
  hq: Pt; chevron: Pt & { angle: number }; beyondCount: number;
  /** An order targets this sector's HQ, so it shows in every view. */
  hqTargeted: boolean;
}
export interface SceneRing { key: Ring; r: number; label: string; date: string; paths: string[]; /** Arc center of each label path, degrees (screen, 270 = up). */ centers: number[] }
export interface SceneOrder {
  id: string; kind: 'main' | 'support' | 'axis' | 'advance' | 'move' | 'link'; planned: boolean; fromId: string; toId: string;
  /** Link orders: linkup-point position and dependency/handoff kind. */
  linkup?: Pt; linkKind?: 'dependency' | 'handoff';
  shaft?: string; head?: string; width?: number; outline?: string;
  label?: Pt & { angle: number; text: string };
  ratio?: { text: string; under: boolean }; ratioAt?: Pt & { angle: number };
  obstacle?: string;
}
export interface SceneMeasure { id: string; type: ControlMeasure['type']; label: string; name: string; x: number; y: number; r: number; outline: string; members: number;
  /** Label anchor: the center, or just above the top edge when members sit in the middle. */
  labelY: number }
export interface SceneGhost { unitId: string; unit: Unit; x: number; y: number; trail: string }
/** A line from an attached unit to the HQ or task force it belongs to, in the HQ's identity color. */
export interface SceneCommandLine { id: string; fromId: string; toId: string; d: string; side: 'friend' | 'threat' | 'other' }
export interface Scene {
  sectors: SceneSector[]; rings: SceneRing[]; customPls: (SceneRing & { id: string })[];
  units: SceneUnit[]; ghosts: SceneGhost[]; orders: SceneOrder[]; measures: SceneMeasure[]; commandLines: SceneCommandLine[];
  flot: string | null; flotLabel: Pt | null; mapR: number; beyondR: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n: number) => String(n).padStart(2, '0');
export const shortDate = (d: Date,tz=DEFAULT_TZ) => {const p=parts(d,tz);return `${p.day}${MONTHS[Number(p.month)-1]}`;};
const addDays = (d: Date,n:number,tz=DEFAULT_TZ) => new Date(calendarDay(d,tz)+n*86400000+12*3600000);
const localDay = (input: string | Date,tz=DEFAULT_TZ): Date => new Date(typeof input==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(input)?Date.parse(input+'T00:00:00Z'):calendarDay(new Date(input),tz));
const sameDay = (a: string | Date,b:string|Date,tz=DEFAULT_TZ) => localDay(a,tz).getTime()===localDay(b,tz).getTime();
const world = (r: number, theta: number): Pt => { const p = polarToXY(r, theta); return { x: p.x * SCALE, y: p.y * SCALE }; };
const r2 = (n: number) => Number(n.toFixed(2));
const isThreat = (u: Unit) => u.affiliation === 'hostile' || u.affiliation === 'suspect';

/**
 * Archive rule: dropped units leave at once; done friendlies stay for the rest of the day;
 * done hostiles stay until the next morning turn after they were finished.
 */
export function isArchived(u: Unit, now: Date, lastTurn?: string,tz=DEFAULT_TZ): boolean {
  if (u.lifecycle === 'dropped') return true;
  if (u.lifecycle !== 'done') return false;
  if (isThreat(u)) return lastTurn !== undefined && localDay(lastTurn,tz).getTime() > localDay(u.updatedAt,tz).getTime();
  return !sameDay(u.updatedAt, now,tz);
}

/** Old positions of dated hostiles and suspects that the morning turn moved today. */
export function derivedTrails(doc: Doc, now: Date): Trail[] {
  if (!doc.lastTurn || !doc.settings.autoAdvance || !sameDay(doc.lastTurn, now,doc.settings.tz)) return [];
  const before = zonedTime(new Date(localDay(doc.lastTurn,doc.settings.tz).getTime()-86400000+12*3600000),doc.settings.tz);
  const out: Trail[] = [];
  for (const u of doc.units) {
    if (!isThreat(u) || !u.dueAt || u.posOverride || u.lifecycle === 'done' || u.lifecycle === 'dropped') continue;
    const r = radiusForDate(u.dueAt, before,doc.settings.tz);
    if (Math.abs(r - u.pos.r) > 0.02) out.push({ unitId: u.id, from: { r, theta: u.pos.theta } });
  }
  return out;
}

function blob(id: string, cx: number, cy: number, r: number, vertices: number, jag: number, smooth: boolean): string {
  const rand = mulberry32(hashSeed(id));
  const pts: Pt[] = [];
  for (let i = 0; i < vertices; i++) {
    const a = (i / vertices) * Math.PI * 2 + rand() * 0.2, k = 1 - jag / 2 + rand() * jag;
    pts.push({ x: r2(cx + Math.cos(a) * r * k), y: r2(cy + Math.sin(a) * r * k * 0.85) });
  }
  return smooth ? smoothPath(pts, true) : `M${pts.map(p => `${p.x} ${p.y}`).join(' L')} Z`;
}

/** Arcs for phase-line labels, long enough for `len` world px of text (at least 170). */
function ringPaths(r: number, centers: number[], len = 170): string[] {
  const span = Math.min(len > 170 ? 160 : 120, (Math.max(170, len) / r) * 180 / Math.PI);
  return centers.map(c => arcTextPath(r, c, span));
}

export function buildScene(doc: Doc, o: SceneOptions): Scene {
  const scale = o.symbolScale ?? 1;
  // "PL QUARTER 07FEB" is the longest stock label: 16 monospace characters plus margins.
  const plLen = o.plFont ? 17 * 0.7 * o.plFont + 16 : 170;
  const unitClear = UNIT_CLEAR * scale;
  const live = doc.units.filter(u => !isArchived(u, o.now, doc.lastTurn,doc.settings.tz));
  const liveIds = new Set(live.map(u => u.id));
  const byId = new Map(doc.units.map(u => [u.id, u]));
  const staffPlus = o.view !== 'commander';

  // Sectors
  const beyondBySector = new Map<string, number>();
  for (const u of live) if (ringOfRadius(u.pos.r) === 'beyond') beyondBySector.set(u.sectorId, (beyondBySector.get(u.sectorId) ?? 0) + 1);
  const sectors: SceneSector[] = doc.sectors.map((s, index) => {
    const centerDeg = s.startDeg + s.widthDeg / 2;
    const inner = 0.3, outer = BEYOND_R, mid = (inner + outer) / 2, gap = 0.13;
    const rimSpan = Math.min(s.widthDeg - 6, 60);
    return {
      id: s.id, name: s.name, index, startDeg: s.startDeg, widthDeg: s.widthDeg, centerDeg,
      wedge: annularSectorPath(0, MAP_EDGE_R * SCALE, s.startDeg, s.widthDeg),
      band: annularSectorPath(MAP_EDGE_R * SCALE, BEYOND_R * SCALE, s.startDeg, s.widthDeg),
      rimPath: arcTextPath(RIM_LABEL_R * SCALE, centerDeg, Math.max(rimSpan, 10)),
      boundary: {
        segments: [[world(inner, s.startDeg), world(mid - gap, s.startDeg)], [world(mid + gap, s.startDeg), world(outer, s.startDeg)]],
        mark: { ...world(mid, s.startDeg), angle: uprightAngle(s.startDeg) },
      },
      hq: world(SECTOR_HQ_R, centerDeg),
      chevron: { ...world(CHEVRON_R, centerDeg), angle: centerDeg },
      beyondCount: beyondBySector.get(s.id) ?? 0,
      hqTargeted: doc.orders.some(o => o.to === `hq:${s.id}`),
    };
  });
  const sectorById = new Map(sectors.map(s => [s.id, s]));

  // Phase lines
  const ringDefs: [Ring, string, number, number][] = [['hq', 'PL TODAY', RING_R.near[0], 0], ['near', 'PL WEEK', RING_R.mid[0], 7], ['mid', 'PL MONTH', RING_R.far[0], 30], ['far', 'PL QUARTER', RING_R.beyond[0], 90]];
  // Compact: labels spread around the circle so neighbouring lines do not stack at the top.
  const COMPACT: Record<Ring, number[]> = { hq: [], near: [228], mid: [312], far: [270], beyond: [] };
  const rings: SceneRing[] = ringDefs.map(([key, label, r, days]) => { const centers = o.compactPl ? COMPACT[key] : [262, 98]; return { key, label, r: r * SCALE, date: shortDate(zonedTime(addDays(o.now, days,doc.settings.tz),doc.settings.tz),doc.settings.tz), paths: ringPaths(r * SCALE, centers, plLen), centers }; });
  const customPls = doc.measures.filter(m => m.type === 'pl' && m.date).flatMap(m => {
    const r = radiusForDate(m.date, o.now,doc.settings.tz);
    if (r <= 0.3 || r > MAP_EDGE_R) return [];
    const centers = o.compactPl ? [100] : [280, 80];
    return [{ id: m.id, key: ringOfRadius(r), label: `PL ${m.name.toUpperCase()}`, date: shortDate(new Date(m.date!),doc.settings.tz), r: r * SCALE, paths: ringPaths(r * SCALE, centers, plLen), centers }];
  });

  // Units
  const attacked = new Set(doc.orders.filter(ord => ord.type === 'attack' && liveIds.has(ord.from) && byId.get(ord.from)!.lifecycle !== 'done').map(ord => ord.to));
  const contactIds = new Set<string>();
  for (const ord of doc.orders) {
    if (ord.type !== 'attack') continue;
    const a = byId.get(ord.from), t = byId.get(ord.to);
    if (a && t && liveIds.has(a.id) && liveIds.has(t.id) && a.pos.r < RING_R.mid[0] && t.pos.r < RING_R.mid[0]) contactIds.add(a.id);
  }
  const todayStart = zonedTime(localDay(o.now,doc.settings.tz),doc.settings.tz).getTime();
  const units: SceneUnit[] = [];
  const anchors = new Map<string, Pt & { clear: number }>();
  for (const u of live) {
    const ring = ringOfRadius(u.pos.r);
    if (ring === 'beyond') {
      const s = sectorById.get(u.sectorId);
      if (s) anchors.set(u.id, { x: s.chevron.x, y: s.chevron.y, clear: 14 * scale });
      continue;
    }
    const p = world(u.pos.r, u.pos.theta);
    const resolved = u.lifecycle === 'done' || u.condition === 'destroyed';
    const overdue = isThreat(u) && !resolved && u.dueAt !== undefined && new Date(u.dueAt).getTime() < todayStart;
    const scenePos: SceneUnit = {
      id: u.id, unit: u, x: r2(p.x), y: r2(p.y), ring,
      symbolView: o.view === 'detail' ? (o.selectedId === u.id ? 'detail' : 'staff') : o.view,
      pulse: u.affiliation === 'hostile' && !resolved && u.pos.r < RING_R.mid[0] && !attacked.has(u.id),
      penetration: overdue && ring === 'hq',
      contact: contactIds.has(u.id),
      pinned: Boolean(u.posOverride),
      selected: o.selectedId === u.id,
    };
    if (scenePos.penetration) {
      const tip = world(Math.max(u.pos.r + unitClear / SCALE * 0.9, 0.35), u.pos.theta);
      const a = world(RING_R.near[0] + 0.12, u.pos.theta - 5), b = world(RING_R.near[0] + 0.12, u.pos.theta + 5);
      scenePos.penetrationPath = `M${r2(a.x)} ${r2(a.y)} L${r2(tip.x)} ${r2(tip.y)} L${r2(b.x)} ${r2(b.y)}`;
    }
    units.push(scenePos);
    anchors.set(u.id, { x: p.x, y: p.y, clear: unitClear });
  }

  // Control measures
  const measures: SceneMeasure[] = doc.measures.filter(m => m.type !== 'pl').map(m => {
    // Centered on its visible members and enclosing them; otherwise its own position and size.
    // Symbols keep their screen size, so zoomed out the margin grows with them.
    const shape = areaShape(doc, m, u => liveIds.has(u.id), (unitClear + 14 * scale) / SCALE);
    const p = { x: shape.center.x * SCALE, y: shape.center.y * SCALE }, r = shape.radius * SCALE;
    const outline = m.type === 'obj' ? blob(m.id, p.x, p.y, r, 9, 0.45, false) : blob(m.id, p.x, p.y, r, 10, 0.3, true);
    anchors.set(m.id, { x: p.x, y: p.y, clear: r * 0.75 });
    return { id: m.id, type: m.type, label: m.type.toUpperCase(), name: m.name.toUpperCase(), x: r2(p.x), y: r2(p.y), r, outline, members: shape.members, labelY: r2(shape.members ? p.y - r - 13 * scale : p.y) };
  });
  anchors.set('hq', { x: 0, y: 0, clear: HQ_CLEAR * scale });
  for (const sec of sectors) anchors.set(`hq:${sec.id}`, { x: sec.hq.x, y: sec.hq.y, clear: 14 * scale });

  // Orders
  const visibleOrder = (ord: Order) => {
    if (!anchors.has(ord.from) || !anchors.has(ord.to)) return false;
    if (staffPlus || o.showOrders?.includes(ord.id)) return true;
    return (ord.type === 'attack' && ord.role === 'main') || ord.type === 'advance';
  };
  // Command lines: each attached unit to its parent, in Staff and Detail, or for the selected HQ or member.
  const commandLines: SceneCommandLine[] = [];
  for (const u of live) {
    if (!u.parentId) continue;
    const parent = byId.get(u.parentId), a = anchors.get(u.id), b = anchors.get(u.parentId);
    if (!parent || !a || !b || !liveIds.has(parent.id)) continue;
    if (!staffPlus && o.selectedId !== u.id && o.selectedId !== parent.id) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len <= a.clear + b.clear) continue;
    const ux = dx / len, uy = dy / len;
    const side = parent.affiliation === 'friend' || parent.affiliation === 'assumed' ? 'friend' : parent.affiliation === 'hostile' || parent.affiliation === 'suspect' ? 'threat' : 'other';
    commandLines.push({ id: `cmd-${u.id}`, fromId: u.id, toId: parent.id, side,
      d: `M${r2(a.x + ux * a.clear)} ${r2(a.y + uy * a.clear)} L${r2(b.x - ux * b.clear)} ${r2(b.y - uy * b.clear)}` });
  }
  const shown = doc.orders.filter(visibleOrder);
  const ratioOn = new Map<string, string>();   // target id → order id that carries the force ratio
  if (staffPlus) {
    const byTarget = new Map<string, Order[]>();
    for (const ord of shown) if (ord.type === 'attack') byTarget.set(ord.to, [...(byTarget.get(ord.to) ?? []), ord]);
    for (const [target, list] of byTarget) {
      const carrier = list.find(x => x.role === 'main') ?? (list.length === 1 ? list[0] : undefined);
      if (carrier) ratioOn.set(target, carrier.id);
    }
  }
  const orders: SceneOrder[] = [];
  for (const ord of shown) {
    const a = anchors.get(ord.from)!, b = anchors.get(ord.to)!;
    const kind: SceneOrder['kind'] = ord.type === 'attack' ? (ord.role === 'main' ? 'main' : 'support') : ord.type;
    const bend = kind === 'link' ? 0 : kind === 'advance' ? 0.12 : kind === 'axis' ? 0.1 : 0.18;
    const curve: Curve | null = bentCurve(a, b, { startClear: a.clear, endClear: b.clear, bend });
    if (!curve) continue;
    const out: SceneOrder = { id: ord.id, kind, planned: Boolean(ord.planned), fromId: ord.from, toId: ord.to };
    if (kind === 'link') {
      out.shaft = curvePath(curve); out.width = 1.2 * scale;
      out.linkup = { x: r2((a.x + b.x) / 2), y: r2((a.y + b.y) / 2) };
      if (ord.kind) out.linkKind = ord.kind;
    } else if (kind === 'main') Object.assign(out, attackArrow(curve, { width: 4.5 * scale, headLen: 18 * scale, headHalf: 10 * scale }));
    else if (kind === 'support') {
      Object.assign(out, attackArrow(curve, { width: 2 * scale, headLen: 14 * scale, headHalf: 7 * scale }));
      out.label = { ...labelAt(curve, 0.5, 9 * scale), text: 'SPT' };
    } else if (kind === 'advance') Object.assign(out, attackArrow(curve, { width: 3 * scale, headLen: 16 * scale, headHalf: 9 * scale }));
    else if (kind === 'move') Object.assign(out, moveArrow(curve, 10 * scale), { width: 1.5 * scale });
    else out.outline = axisOutline(curve, { halfWidth: 8 * scale, headLen: 24 * scale, headHalf: 17 * scale });
    if (ord.type === 'attack' && ratioOn.get(ord.to) === ord.id) {
      const ratio = forceRatio(doc, ord.to);
      if (ratio) { out.ratio = ratio; out.ratioAt = labelAt(curve, 0.5, (kind === 'main' ? -12 : -9) * scale); }
    }
    if (byId.get(ord.from)?.lifecycle === 'blocked') out.obstacle = obstacleMark(curve, 0.35, 9 * scale);
    orders.push(out);
  }

  // Ghosts and trails for auto-advanced units
  const trails = o.trails ?? derivedTrails(doc, o.now);
  const ghosts: SceneGhost[] = [];
  for (const t of trails) {
    const u = byId.get(t.unitId), now = anchors.get(t.unitId);
    if (!u || !now || ringOfRadius(t.from.r) === 'beyond' && ringOfRadius(u.pos.r) === 'beyond') continue;
    const from = world(Math.min(t.from.r, BEYOND_R), t.from.theta);
    ghosts.push({ unitId: u.id, unit: u, x: r2(from.x), y: r2(from.y), trail: `M${r2(from.x)} ${r2(from.y)} L${r2(now.x)} ${r2(now.y)}` });
  }

  // FLOT: through the outermost active friendlies per sector (staff/detail only)
  let flot: string | null = null, flotLabel: Pt | null = null;
  if (staffPlus && sectors.length) {
    const pts: Pt[] = [];
    let maxR = 0, maxDeg = 0;
    for (const s of [...sectors].sort((x, y) => norm(x.startDeg) - norm(y.startDeg))) {
      const active = live.filter(u => u.sectorId === s.id && (u.affiliation === 'friend' || u.affiliation === 'assumed') && u.lifecycle === 'active' && ringOfRadius(u.pos.r) !== 'beyond');
      const r = active.length ? Math.max(...active.map(u => u.pos.r)) + 0.22 : 0.78;
      for (const k of [0.12, 0.5, 0.88]) pts.push(world(r, s.startDeg + s.widthDeg * k));
      if (r > maxR) { maxR = r; maxDeg = s.centerDeg; }
    }
    flot = scallops(densify(pts, 16));
    flotLabel = world(maxR + 0.14, maxDeg);
  }

  return { sectors, rings, customPls, units, ghosts, orders, measures, commandLines, flot, flotLabel, mapR: MAP_EDGE_R * SCALE, beyondR: BEYOND_R * SCALE };
}

const norm = (d: number) => ((d % 360) + 360) % 360;
function uprightAngle(deg: number): number { let a = norm(deg); if (a > 90 && a <= 270) a -= 180; return a; }

/** Resample a closed polygon so consecutive points are about `step` apart. */
function densify(pts: Pt[], step: number): Pt[] {
  const smooth: Pt[] = [];
  // Chaikin once for a softer trace, then resample.
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    smooth.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  const out: Pt[] = [];
  for (let i = 0; i < smooth.length; i++) {
    const a = smooth[i], b = smooth[(i + 1) % smooth.length];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n) });
  }
  return out;
}
/** FLOT line: semicircles bulging outward (the trace runs clockwise, so sweep=1 bulges outward). */
function scallops(pts: Pt[]): string {
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length], rr = r2(Math.hypot(b.x - a.x, b.y - a.y) / 2);
    d += ` A${rr} ${rr} 0 0 1 ${r2(b.x)} ${r2(b.y)}`;
  }
  return `${d} Z`;
}
