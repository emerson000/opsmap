// Unit label text and placement for the map, kept pure so tests can check what the map draws.
import type { Doc } from '../../core/model/types';
import { formatDtg } from '../../core/model/sidc';
import type { Scene } from './scene';
import { placeLabels, type Box, type PlacedLabel } from './labels';
import type { Insets, View2D } from './panzoom';

export interface MapLabelOptions {
  /** Symbol scale and label text scale (see OpsMap). */
  s: number; ls: number;
  /** World size of the smallest legible text; sizes the phase-line and measure label boxes. */
  mt: number;
  /** Phone commander view at the fitted zoom. */
  declutter: boolean;
  hoveredId?: string | null;
  /** Visible map rectangle in world units; labels stay inside it. */
  bounds?: Box;
  /** Largest leader offset before scaling (phones: 48). */
  maxOffset?: number;
}

/** The visible map area in world units: the screen minus chrome, inset by `margin` px. */
export function visibleWorld(view: View2D, width: number, height: number, insets: Insets, margin = 0): Box {
  const x0 = insets.left + margin, y0 = insets.top + margin;
  const w = Math.max(1, width - insets.left - insets.right - 2 * margin), h = Math.max(1, height - insets.top - insets.bottom - 2 * margin);
  return { x: (x0 - view.x) / view.k, y: (y0 - view.y) / view.k, width: w / view.k, height: h / view.k };
}

const at = (r: number, deg: number) => ({ x: r * Math.cos(deg * Math.PI / 180), y: r * Math.sin(deg * Math.PI / 180) });

/** Boxes along each phase-line label arc, so unit labels yield to them. */
export function phaseLineBoxes(scene: Scene, font: number, withDate: boolean): Box[] {
  const out: Box[] = [];
  for (const ring of [...scene.rings, ...scene.customPls]) {
    const text = withDate ? `${ring.label} ${ring.date}` : ring.label;
    const len = text.length * 0.7 * font;
    for (const c of ring.centers) {
      const half = (len / 2 / ring.r) * 180 / Math.PI, steps = Math.max(2, Math.ceil(len / font));
      for (let i = 0; i <= steps; i++) {
        const p = at(ring.r - font * 0.4, c - half + (2 * half * i) / steps);
        out.push({ x: p.x - font * 0.55, y: p.y - font * 0.55, width: font * 1.1, height: font * 1.1 });
      }
    }
  }
  return out;
}

export function mapLabels(doc: Doc, scene: Scene, o: MapLabelOptions): Map<string, PlacedLabel> {
  const { s } = o, view = doc.settings.view, staff = view !== 'commander';
  const occupied: Box[] = [{ x: -30 * s, y: -35 * s, width: 60 * s, height: 70 * s }, ...scene.units.map(u => ({ x: u.x - 21 * s, y: u.y - 24 * s, width: 42 * s, height: 48 * s }))];
  if (staff) for (const h of scene.sectors) occupied.push({ x: h.hq.x - 25 * s, y: h.hq.y - 35 * s, width: 65 * s, height: 70 * s });
  // Measure labels and phase-line labels are placed first; unit labels go around them.
  for (const m of scene.measures) {
    const f = Math.max(9.5 * s, o.mt), w = Math.max(m.label.length, o.declutter ? 0 : m.name.length * 0.8) * 0.7 * f + 4 * s;
    occupied.push({ x: m.x - w / 2, y: m.y - f, width: w, height: o.declutter ? f * 1.2 : f * 2.2 });
  }
  const pl = phaseLineBoxes(scene, Math.max(8.5 * s, o.mt), !o.declutter);
  occupied.push(...pl);
  const mains = new Set(doc.orders.filter(x => x.type === 'attack' && x.role === 'main').map(x => x.from));
  const inputs = scene.units.flatMap(u => {
    const unit = u.unit, detail = view === 'detail' && u.selected;
    if (o.declutter && !u.selected && !(unit.affiliation === 'hostile' || unit.affiliation === 'suspect') && !mains.has(u.id) && (u.ring === 'far' || u.ring === 'beyond')) return [];
    const lines = [unit.designation + (u.ring === 'hq' && unit.echelon ? ` ${unit.echelon.toUpperCase()}` : '') + (unit.reinforced && staff ? ` (${unit.reinforced})` : '')];
    if (unit.lifecycle === 'done' && unit.affiliation === 'friend') lines.push('COMPLETE');
    if (staff && unit.dueAt && (u.ring === 'hq' || u.ring === 'near' || u.ring === 'mid' || u.selected || o.hoveredId === u.id)) lines.push(formatDtg(unit.dueAt));
    if (detail) { if (unit.note) lines.push(...unit.note.match(/.{1,30}/g) ?? []); if (unit.rating) lines.push(`J ${unit.rating}`); if (unit.parentId) lines.push(`TF ${unit.parentId.toUpperCase()}`); }
    return [{ id: u.id, x: u.x, y: u.y, lines, strength: staff ? unit.strength : undefined, selected: u.selected }];
  });
  // "Nearest symbol" counts every drawn unit, labelled or not.
  const all = scene.units.map(u => ({ id: u.id, x: u.x, y: u.y }));
  // Phones: a label never covers another label or a phase-line label; it is dropped instead.
  return placeLabels(inputs, occupied, { s, ls: o.ls, bounds: o.bounds, maxOffset: o.maxOffset, symbols: all, hard: o.maxOffset !== undefined ? pl : undefined });
}
