import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { importJson } from '../../src/core/model/json';
import { createInverse, restoreInverse } from '../../src/core/model/patch';
import { AREA_MARGIN, AREA_SIZES, areaShape, polarToXY } from '../../src/core/model/geometry';
import { dropCommand } from '../../src/lib/map/interaction';
import { buildScene } from '../../src/lib/map/scene';
import { SCALE } from '../../src/lib/map/constants';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)).doc; };
const ea = (doc: Doc) => doc.measures.find(m => m.id === 'ea-saturday')!;
const unit = (doc: Doc, id: string) => doc.units.find(u => u.id === id)!;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('area membership and size', () => {
  it('parses join, leave and size', () => {
    const doc = seedDoc(now);
    expect(parse('/ea join SATURDAY LEAK RECORDS', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'ea', args: { action: 'join', measure: 'ea-saturday', units: ['leak', 'records'] } } });
    expect(parse('/ea leave SATURDAY LEAK', doc, { now })).toMatchObject({ ok: false, error: 'Not in EA SATURDAY: LEAK' });
    expect(parse('/ea leave SATURDAY LEAK', run(doc, '/ea join SATURDAY LEAK'), { now })).toMatchObject({ ok: true, cmd: { args: { action: 'leave', units: ['leak'] } } });
    expect(parse('/obj size "SETTLED IN" xl', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'obj', args: { action: 'size', measure: 'obj-settled', size: 'xl' } } });
    expect(parse('/ea size SATURDAY huge', doc, { now })).toMatchObject({ ok: false, error: 'Expected small, medium, large or xl' });
    expect(parse('/pl join LAUNCH LEAK', doc, { now }).ok).toBe(false);
  });

  it('suggests size presets and only non-members to join', () => {
    let doc = run(seedDoc(now), '/ea join SATURDAY LEAK');
    const sug = (text: string) => suggest(text, text.length, doc).items;
    expect(sug('/ea size SATURDAY ').map(s => s.insert)).toEqual(['small', 'medium', 'large', 'xl']);
    expect(sug('/ea join SATURDAY ').map(s => s.unitId)).not.toContain('leak');
    expect(sug('/ea join SATURDAY ').map(s => s.unitId)).toContain('records');
    expect(sug('/ea leave SATURDAY ').map(s => s.unitId)).toEqual(['leak']);
    doc = run(doc, '/ea leave SATURDAY LEAK');
    expect(ea(doc).members).toBeUndefined();
  });

  it('join moves units inside, pins dated ones, and the area grows to enclose them', () => {
    const before = seedDoc(now);
    const doc = run(before, '/ea join SATURDAY LEAK RECORDS IRSRSP');
    expect(ea(doc).members).toEqual(['leak', 'records', 'irsrsp']);
    expect(unit(doc, 'leak').posOverride).toBe(true);
    const shape = areaShape(doc, ea(doc));
    expect(shape.members).toBe(3);
    for (const id of ['leak', 'records', 'irsrsp']) expect(dist(polarToXY(unit(doc, id).pos), shape.center)).toBeLessThanOrEqual(shape.radius - AREA_MARGIN + 1e-9);
    expect(shape.radius).toBeGreaterThan(AREA_SIZES.medium);
    expect(doc.log.at(-1)?.text).toBe('LEAK, RECORDS, IRSRSP JOINED EA SATURDAY');
    // The renderer draws the same outline.
    const drawn = buildScene(doc, { view: 'commander', now }).measures.find(m => m.id === 'ea-saturday')!;
    expect(drawn.r).toBeCloseTo(shape.radius * SCALE);
    expect(drawn.members).toBe(3);
  });

  it('a unit belongs to one area; joining another moves it across', () => {
    let doc = run(seedDoc(now), '/ea join SATURDAY LEAK');
    doc = run(doc, '/obj join "SETTLED IN" LEAK');
    expect(ea(doc).members).toBeUndefined();
    expect(doc.measures.find(m => m.id === 'obj-settled')!.members).toEqual(['leak']);
    expect(doc.log.at(-1)?.text).toBe('LEAK JOINED OBJ SETTLED IN; LEAK LEFT EA SATURDAY');
    expect(() => importJson(JSON.stringify({ ...doc, measures: doc.measures.map(m => m.id === 'ea-saturday' ? { ...m, members: ['leak'] } : m) }))).toThrow(/at most one area/);
    expect(() => importJson(JSON.stringify({ ...doc, measures: doc.measures.map(m => m.id === 'ea-saturday' ? { ...m, members: ['ghost'] } : m) }))).toThrow();
  });

  it('size sets the minimum radius; members still enlarge it', () => {
    let doc = run(seedDoc(now), '/ea size SATURDAY xl');
    expect(ea(doc).size).toBe(AREA_SIZES.xl);
    expect(areaShape(doc, ea(doc)).radius).toBe(AREA_SIZES.xl);
    expect(parse('/ea size SATURDAY xl', doc, { now })).toMatchObject({ ok: false, error: 'EA SATURDAY is already xl' });
    doc = run(doc, '/ea size SATURDAY small');
    doc = run(doc, '/ea join SATURDAY LEAK RECORDS');
    expect(areaShape(doc, ea(doc)).radius).toBeGreaterThan(AREA_SIZES.small);
  });

  it('moving an area carries its members, keeping their spacing; undo restores everything', () => {
    const joined = run(seedDoc(now), '/ea join SATURDAY LEAK RECORDS');
    const p = parse('/ea move SATURDAY to Family mid', joined, { now });
    if (!p.ok) throw new Error(p.error);
    const result = ok(apply(joined, p.cmd, now));
    const doc = result.doc;
    for (const id of ['leak', 'records']) expect(unit(doc, id).sectorId).toBe('family');
    expect(ea(doc).sectorId).toBe('family');
    expect(doc.log.at(-1)?.text).toMatch(/^EA SATURDAY MOVED → FAMILY MID WITH 2 UNITS/);
    const shape = areaShape(doc, ea(doc));
    for (const id of ['leak', 'records']) expect(dist(polarToXY(unit(doc, id).pos), shape.center)).toBeLessThan(shape.radius);
    // Undo restores units and the area; the audit log keeps its line by design.
    expect({ ...restoreInverse(doc, createInverse(joined, result.touched)), log: [] }).toEqual({ ...joined, log: [] });
  });

  it('a member moved to another sector by command leaves its area', () => {
    let doc = run(seedDoc(now), '/ea join SATURDAY LEAK');
    doc = run(doc, '/move LEAK to Work near');
    expect(ea(doc).members).toBeUndefined();
    expect(doc.log.at(-1)?.text).toMatch(/; LEFT EA SATURDAY$/);
  });

  it('dropping a unit inside an area joins it; dragging a member outside leaves it', () => {
    const doc = seedDoc(now);
    const center = areaShape(doc, ea(doc)).center;
    const join = dropCommand(doc, 'records', { x: center.x * SCALE, y: center.y * SCALE });
    expect(join).toMatchObject({ verb: 'ea', args: { action: 'join', measure: 'ea-saturday', units: ['records'] } });
    const joined = ok(apply(doc, join, now)).doc;
    expect(ea(joined).members).toEqual(['records']);
    const inside = areaShape(joined, ea(joined)).center;
    expect(dropCommand(joined, 'records', { x: inside.x * SCALE + 5, y: inside.y * SCALE })).toMatchObject({ verb: 'move' });
    const leave = dropCommand(joined, 'records', { x: 0, y: -250 });
    expect(leave).toMatchObject({ verb: 'ea', args: { action: 'leave', measure: 'ea-saturday', units: ['records'] } });
    const left = ok(apply(joined, leave, now)).doc;
    expect(ea(left).members).toBeUndefined();
    expect(unit(left, 'records').sectorId).toBe('work');
  });

  it('a member moved within its own sector stays in its area, even if the area sits in another sector', () => {
    const doc = seedDoc(now);
    // Joined by a drop just over the boundary into Work; the area itself is in Household.
    let joined = ok(apply(doc, { verb: 'ea', args: { action: 'join', measure: 'ea-saturday', units: ['tools'], r: 2.6, theta: 300 } }, now)).doc;
    expect(unit(joined, 'tools').sectorId).toBe('work');
    joined = run(joined, '/move TOOLS to Work mid');
    expect(ea(joined).members).toEqual(['tools']);
  });

  it('membership changes mark the units, so undo conflicts instead of breaking the one-area rule', () => {
    const doc = run(seedDoc(now), '/obj join "SETTLED IN" LEAK');
    const p = parse('/obj leave "SETTLED IN" LEAK', doc, { now });
    if (!p.ok) throw new Error(p.error);
    const later = new Date(now.getTime() + 60_000);
    expect(ok(apply(doc, p.cmd, later)).touched.units).toContain('leak');
    const removal = parse('/obj remove "SETTLED IN"', doc, { now });
    if (!removal.ok) throw new Error(removal.error);
    expect(ok(apply(doc, removal.cmd, later)).touched.units).toContain('leak');
  });

  it('moving an area cancels cross-sector orders on the area itself, with or without members', () => {
    for (const join of [true, false]) {
      let doc = seedDoc(now);
      if (join) doc = run(doc, '/obj join "SETTLED IN" RECORDS');
      doc = run(doc, '/attack IRSRSP obj "SETTLED IN"');
      const moved = run(doc, '/obj move "SETTLED IN" to Work mid');
      expect(moved.orders.some(o => o.from === 'irsrsp' && o.to === 'obj-settled')).toBe(false);
      expect(moved.log.at(-1)?.text).toMatch(/ATTACK ON SETTLED IN CANCELLED \(BOUNDARY\)/);
    }
  });

  it('drops hit-test the outline as drawn when the map supplies it', () => {
    const doc = seedDoc(now);
    const center = areaShape(doc, ea(doc)).center;
    const far = { x: center.x * SCALE + 80, y: center.y * SCALE };
    expect(dropCommand(doc, 'records', far)).toMatchObject({ verb: 'move' });
    expect(dropCommand(doc, 'records', far, [{ id: 'ea-saturday', x: center.x * SCALE, y: center.y * SCALE, r: 90 }])).toMatchObject({ verb: 'ea', args: { action: 'join' } });
  });
});
