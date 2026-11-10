// Turns pointer gestures on the map into commands. Pure; the component calls dispatch.
import type { Command, Doc, Ring } from '../../core/model/types';
import { RING_R, areaShape, snap, xyToPolar } from '../../core/model/geometry';
import { SCALE } from './constants';

type XY = { x: number; y: number };
const round = (n: number) => Number(n.toFixed(3));

export function ringOfRadius(r: number): Ring {
  return r < RING_R.near[0] ? 'hq' : r < RING_R.mid[0] ? 'near' : r < RING_R.far[0] ? 'mid' : r < RING_R.beyond[0] ? 'far' : 'beyond';
}

/** Client (screen) coordinates → world coordinates under a pan/zoom transform {x, y, k}. */
export function worldFromClient(clientX: number, clientY: number, rect: { left: number; top: number }, t: { x: number; y: number; k: number }): XY {
  return { x: (clientX - rect.left - t.x) / t.k, y: (clientY - rect.top - t.y) / t.k };
}

/** Snapped model position for a world point (out of bounds → the beyond edge / nearest sector). */
export function snapWorld(doc: Doc, world: XY) {
  if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) throw new Error('Position must be finite');
  return snap(xyToPolar(world.x / SCALE, world.y / SCALE), doc.sectors);
}

/** A drag-and-drop of a unit becomes exactly one command: dropped inside another area's outline it joins that
 *  area, dropped outside its own area's outline it leaves it, otherwise it moves. */
export function dropCommand(doc: Doc, unitId: string, world: XY, drawn?: { id: string; x: number; y: number; r: number }[]): Command {
  const s = snapWorld(doc, world);
  const pos = { r: round(s.r), theta: round(s.theta) };
  const pt = { x: world.x / SCALE, y: world.y / SCALE };
  // Hit-test the outlines as drawn (world px) when the map supplies them; otherwise the model's shapes.
  const outline = (m: Doc['measures'][number]) => {
    const d = drawn?.find(x => x.id === m.id);
    if (d) return { center: { x: d.x / SCALE, y: d.y / SCALE }, radius: d.r / SCALE };
    return areaShape(doc, m);
  };
  const distance = (m: Doc['measures'][number]) => { const shape = outline(m); return { m, d: Math.hypot(pt.x - shape.center.x, pt.y - shape.center.y), r: shape.radius }; };
  const areas = doc.measures.filter(m => m.type !== 'pl').map(distance);
  const current = areas.find(a => a.m.members?.includes(unitId));
  const into = areas.filter(a => a.d <= a.r && a.m.id !== current?.m.id).sort((a, b) => a.d - b.d)[0];
  if (into) return { verb: into.m.type, args: { action: 'join', measure: into.m.id, units: [unitId], ...pos } };
  if (current && current.d > current.r) return { verb: current.m.type, args: { action: 'leave', measure: current.m.id, units: [unitId], ...pos } };
  return { verb: 'move', args: { unit: unitId, ...pos, sectorId: s.sectorId } };
}

/** A drag-and-drop of an area measure (OBJ, EA, NAI) becomes exactly one `<type> move` command. */
/** `delta` (world px) shifts the area from its model center, so hidden members do not offset the move. */
export function measureDropCommand(doc: Doc, measureId: string, world: XY, delta?: XY): Command {
  const m = doc.measures.find(x => x.id === measureId);
  if (!m) throw new Error(`Unknown control measure: ${measureId}`);
  if (m.type === 'pl') throw new Error('A phase line sits at its date: use /pl date');
  const from = areaShape(doc, m).center;
  const s = snapWorld(doc, delta ? { x: from.x * SCALE + delta.x, y: from.y * SCALE + delta.y } : world);
  return { verb: m.type, args: { action: 'move', measure: m.id, r: round(s.r), theta: round(s.theta) } };
}

export function contextAt(doc: Doc, world: XY): { sectorId: string; ring: Ring } {
  const s = snapWorld(doc, world);
  return { sectorId: s.sectorId, ring: ringOfRadius(s.r) };
}

/**
 * Edge-handle drag from a friendly onto a hostile or suspect. Role:
 * support, unless the attacker's sector has no main effort yet.
 */
export function attackCommand(doc: Doc, fromId: string, targetId: string): Command | { error: string } {
  const from = doc.units.find(u => u.id === fromId), target = doc.units.find(u => u.id === targetId);
  if (!from || !target) return { error: 'Unknown unit' };
  if (from.id === target.id) return { error: 'A unit cannot attack itself' };
  if (from.affiliation === 'hostile' || from.affiliation === 'suspect') return { error: 'Only your own units can attack' };
  if (target.affiliation !== 'hostile' && target.affiliation !== 'suspect') return { error: 'Drop on a hostile or suspect to attack' };
  const bySector = new Map(doc.units.map(u => [u.id, u.sectorId]));
  const hasMain = doc.orders.some(o => o.type === 'attack' && o.role === 'main' && bySector.get(o.from) === from.sectorId);
  return { verb: 'attack', args: { unit: from.id, target: target.id, role: hasMain ? 'support' : 'main' } };
}
