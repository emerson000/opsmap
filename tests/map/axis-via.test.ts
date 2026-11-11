import { describe, expect, it } from 'vitest';
import { buildScene, axisCheckpoints } from '../../src/lib/map/scene';
import { SCALE } from '../../src/lib/map/constants';
import { seedDoc } from '../../src/core/model/seed';
import { radiusForDate } from '../../src/core/model/geometry';
import { advanceDay } from '../../src/core/commands/turn';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { orderLine } from '../../src/lib/ui/words';
import type { Doc } from '../../src/core/model/types';

const now = new Date(2026, 10, 9, 12);
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r.doc; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)); };
const axisOf = (doc: Doc) => buildScene(doc, { view: 'staff', now }).orders.find(o => o.kind === 'axis')!;

describe('axis of advance via phase lines', () => {
  // LAUNCH 20 days out: its ring crosses the route between MOVE (far) and the objective, clear of both symbols.
  const midway = () => run(seedDoc(now), '/pl date LAUNCH +20d');
  it('passes through each named phase line, on its ring, with a checkpoint mark', () => {
    const doc = midway();
    const axis = axisOf(doc);
    const launch = doc.measures.find(m => m.name === 'LAUNCH')!;
    expect(axis.checkpoints).toHaveLength(1);
    const c = axis.checkpoints![0];
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(radiusForDate(launch.date, now, doc.settings.tz) * SCALE, 0);
    // The outline is not the plain one: unbound, it differs.
    const plain = run(doc, '/axis MOVE to OBJ "SETTLED IN"');
    expect(axisOf(plain).checkpoints).toBeUndefined();
    expect(axisOf(plain).outline).not.toBe(axis.outline);
  });
  it('keeps the order given, and two phase lines give two checkpoints', () => {
    let doc = run(midway(), '/pl add "REVIEW" +14d');
    doc = run(doc, '/axis MOVE to OBJ "SETTLED IN" via PL LAUNCH, PL REVIEW');
    const order = doc.orders.find(o => o.type === 'axis')!;
    expect(order.via!.map(id => doc.measures.find(m => m.id === id)!.name)).toEqual(['LAUNCH', 'REVIEW']);
    const a = { x: 0, y: 300 }, b = { x: 300, y: 0 };
    const marks = axisCheckpoints(doc, order, a, b, now);
    expect(marks).toHaveLength(2);
    expect(axisOf(doc).checkpoints).toHaveLength(2);
  });
  it('a checkpoint that falls under a symbol is left out rather than hidden', () => {
    // As seeded, LAUNCH (45 days) sits just inside MOVE's clear zone.
    expect(axisOf(seedDoc(now)).checkpoints).toBeUndefined();
  });
  it('removing a phase line takes it off the axis', () => {
    const doc = run(seedDoc(now), '/pl remove LAUNCH');
    expect(doc.orders.find(o => o.type === 'axis')!.via).toEqual([]);
    expect(axisOf(doc).checkpoints).toBeUndefined();
  });
  it('the order line names each phase line with its date, marking ones passed', () => {
    let doc = seedDoc(now);
    const order = doc.orders.find(o => o.type === 'axis')!;
    expect(orderLine(doc, order, 'move', now).text).toMatch(/^Axis of advance → SETTLED IN via PL LAUNCH \d{2}[A-Z]{3} · planned$/);
    doc = run(doc, '/pl date LAUNCH 2026-11-01');
    expect(orderLine(doc, doc.orders.find(o => o.type === 'axis')!, 'move', now).text).toContain('PL LAUNCH 01NOV (passed)');
  });
  it('the morning turn notes a via phase line falling due that day', () => {
    const doc = run(seedDoc(now), '/pl date LAUNCH 2026-11-10');
    const turn = advanceDay(doc, new Date(2026, 10, 10, 6));
    expect(turn.log).toContain('AXIS MOVE: PL LAUNCH due today (→ OBJ SETTLED IN)');
    expect(turn.doc.log.at(-1)?.text).toContain('AXIS MOVE: PL LAUNCH due today');
  });
  it('autocomplete walks the axis: to, the objective, via, then phase lines after via and each comma', () => {
    const doc = run(seedDoc(now), '/pl add "REVIEW" 2026-11-20');
    const ins = (text: string) => suggest(text, text.length, doc).items.map(i => i.insert);
    expect(ins('/axis MOVE ')).toEqual(['to']);
    expect(ins('/axis MOVE to ')).toContain('"SETTLED IN"');
    expect(ins('/axis MOVE to OBJ "SETTLED IN" ')).toEqual(['via']);
    expect(ins('/axis MOVE to OBJ "SETTLED IN" via ')).toEqual(expect.arrayContaining(['LAUNCH', 'REVIEW']));
    expect(ins('/axis MOVE to OBJ "SETTLED IN" via PL LAUNCH ')).toEqual([',']);
    expect(ins('/axis MOVE to OBJ "SETTLED IN" via PL LAUNCH , ')).toEqual(expect.arrayContaining(['REVIEW']));
  });
});
