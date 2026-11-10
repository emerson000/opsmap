// Turns pointer gestures on the map into commands. Pure; the component calls dispatch.
import type { Command, Doc, Ring } from '../../core/model/types';
import { RING_R, snap, xyToPolar } from '../../core/model/geometry';
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

/** A drag-and-drop of a unit becomes exactly one `move` command. */
export function dropCommand(doc: Doc, unitId: string, world: XY): Command {
  const s = snapWorld(doc, world);
  return { verb: 'move', args: { unit: unitId, r: round(s.r), theta: round(s.theta), sectorId: s.sectorId } };
}

/** A drag-and-drop of an area measure (OBJ, EA, NAI) becomes exactly one `<type> move` command. */
export function measureDropCommand(doc: Doc, measureId: string, world: XY): Command {
  const m = doc.measures.find(x => x.id === measureId);
  if (!m) throw new Error(`Unknown control measure: ${measureId}`);
  if (m.type === 'pl') throw new Error('A phase line sits at its date: use /pl date');
  const s = snapWorld(doc, world);
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
