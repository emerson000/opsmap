// A unit placed by hand (a drag, /move to a point) lands at the free spot nearest where it was let go.
import { describe, expect, it } from 'vitest';
import { seedDoc } from '../../src/core/model/seed';
import { polarToXY, resolvePlacement } from '../../src/core/model/geometry';
import type { Doc, Unit } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const at = (doc: Doc, id: string, r: number, theta: number, sectorId = 'household'): Unit => {
  const base = doc.units[0];
  return { ...base, id, designation: id.toUpperCase(), sectorId, pos: { r, theta }, lifecycle: 'todo', dueAt: undefined, posOverride: undefined, parentId: undefined };
};
const empty = () => { const doc = seedDoc(now); doc.units = []; doc.orders = []; doc.measures = []; return doc; };
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const dist = (a: { r: number; theta: number }, b: { r: number; theta: number }) => { const p = polarToXY(a), q = polarToXY(b); return Math.hypot(p.x - q.x, p.y - q.y); };

describe('placement by hand', () => {
  it('keeps a drop with room exactly where it was let go', () => {
    const doc = empty(), s = doc.sectors.find(x => x.id === 'household')!, c = s.startDeg + s.widthDeg / 2;
    const got = resolvePlacement(doc, 'household', { r: 2.4, theta: c + 7 });
    expect(got.r).toBe(2.4);
    expect(angle(got.theta, c + 7)).toBeLessThan(1e-9);
  });

  it('a drop between two close neighbors shifts a little, not across the sector', () => {
    const doc = empty(), s = doc.sectors.find(x => x.id === 'household')!, c = s.startDeg + s.widthDeg / 2;
    doc.units = [at(doc, 'a', 2.3, c - 12), at(doc, 'b', 2.3, c + 12)];
    const drop = { r: 2.3, theta: c };
    const got = resolvePlacement(doc, 'household', drop);
    expect(dist(got, drop)).toBeLessThan(0.6);
    expect(angle(got.theta, c)).toBeLessThan(4);
    for (const u of doc.units) expect(dist(got, u.pos)).toBeGreaterThanOrEqual(0.74 - 1e-9);
  });

  it('a drop in the edge margin of a sector stays at that edge, not the center', () => {
    const doc = empty(), s = doc.sectors.find(x => x.id === 'household')!;
    const got = resolvePlacement(doc, 'household', { r: 3.5, theta: s.startDeg + s.widthDeg - 1 });
    expect(angle(got.theta, s.startDeg + s.widthDeg)).toBeLessThan(7);
    expect(got.r).toBe(3.5);
  });
});
