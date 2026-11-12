// Collapsing a task force, and attaching a unit that supported it.
import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import { createInverse, restoreInverse } from '../../src/core/model/patch';
import type { Doc } from '../../src/core/model/types';
import { buildScene } from '../../src/lib/map/scene';

const now = new Date('2026-11-09T17:00:00Z');
const exec = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); const r: ApplyResult = apply(doc, p.cmd, now); if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => exec(doc, text).doc;
const fails = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); return p.ok ? '' : p.error; };
const unit = (doc: Doc, d: string) => doc.units.find(u => u.designation === d)!;
const scene = (doc: Doc, selectedId: string | null = null) => buildScene(doc, { view: 'staff', now, selectedId, trails: [] });
// In the seed, task force MOVE (Household) holds PACKING and MOVERS.

describe('attach replaces support', () => {
  it('removes the support order to the new task force and says so', () => {
    const doc = run(seedDoc(now), '/support SLEEP MOVE');
    expect(doc.orders.some(o => o.type === 'support' && o.from === 'sleep' && o.to === 'move')).toBe(true);
    const r = exec(doc, '/attach SLEEP to MOVE');
    expect(r.log).toBe('SLEEP ATTACHED TO TF MOVE — SUPPORT ENDED');
    expect(r.doc.orders.some(o => o.type === 'support' && o.from === 'sleep')).toBe(false);
    expect(unit(r.doc, 'SLEEP').parentId).toBe('move');
  });
  it('keeps support to a different unit', () => {
    const doc = run(seedDoc(now), '/support SLEEP PACKING');
    const r = exec(doc, '/attach SLEEP to MOVE');
    expect(r.log).toBe('SLEEP ATTACHED TO TF MOVE');
    expect(r.doc.orders.some(o => o.type === 'support' && o.from === 'sleep' && o.to === 'packing')).toBe(true);
  });
  it('also when /reinforce attaches the supporter', () => {
    const doc = run(seedDoc(now), '/support SLEEP MOVE');
    expect(exec(doc, '/reinforce MOVE with SLEEP').log).toBe('MOVE REINFORCED (+) — SUPPORT ENDED');
  });
  it('undo brings the support order back', () => {
    const before = run(seedDoc(now), '/support SLEEP MOVE');
    const r = exec(before, '/attach SLEEP to MOVE');
    const undone = restoreInverse(r.doc, createInverse(before, r.touched));
    expect(undone.orders).toEqual(before.orders);
    expect(unit(undone, 'SLEEP').parentId).toBeUndefined();
  });
});

describe('/collapse and /expand', () => {
  it('stores the state on the task force and counts its open units', () => {
    const r = exec(seedDoc(now), '/collapse MOVE');
    expect(r.log).toBe('TF MOVE COLLAPSED — 2 UNITS');
    expect(unit(r.doc, 'MOVE').collapsed).toBe(true);
    expect(exec(r.doc, '/expand MOVE').log).toBe('TF MOVE EXPANDED — 2 UNITS');
    expect(unit(run(r.doc, '/expand MOVE'), 'MOVE').collapsed).toBeUndefined();
  });
  it('refuses a unit that is not a task force, or a task force already in that state', () => {
    const doc = seedDoc(now);
    expect(fails(doc, '/collapse TOOLS')).toBe('TOOLS is not a task force: attach a unit to it first');
    expect(fails(doc, '/expand MOVE')).toBe('TF MOVE is already expanded');
    expect(fails(run(doc, '/collapse MOVE'), '/collapse MOVE')).toBe('TF MOVE is already collapsed');
  });
  it('all: every task force in the other state, or an error when there is none', () => {
    let doc = run(seedDoc(now), '/attach TOOLS to RECORDS');
    expect(exec(doc, '/collapse all').log).toMatch(/^TFS (MOVE, RECORDS|RECORDS, MOVE) COLLAPSED$/);
    doc = run(doc, '/collapse all');
    expect(fails(doc, '/collapse all')).toBe('No expanded task force to collapse');
    expect(exec(doc, '/expand all').log).toMatch(/EXPANDED$/);
  });
  it('a dissolved task force is no longer collapsed', () => {
    let doc = run(seedDoc(now), '/collapse MOVE');
    doc = run(run(doc, '/detach PACKING'), '/detach MOVERS');
    expect(unit(doc, 'MOVE').taskForce).toBeUndefined();
    expect(unit(doc, 'MOVE').collapsed).toBeUndefined();
  });
  it('a unit attached to a collapsed task force is hidden, and the log says so', () => {
    const doc = run(seedDoc(now), '/collapse MOVE');
    expect(exec(doc, '/attach TOOLS to MOVE').log).toBe('TOOLS ATTACHED TO TF MOVE — HIDDEN IN COLLAPSED TF MOVE');
  });
});

describe('a collapsed task force on the map', () => {
  it('hides the units under it and draws the task force as a stack with their count', () => {
    const s = scene(run(seedDoc(now), '/collapse MOVE'));
    expect(s.units.some(u => u.id === 'packing' || u.id === 'movers')).toBe(false);
    expect(s.units.find(u => u.id === 'move')?.stack).toBe(2);
    expect(s.commandLines.some(l => l.fromId === 'packing' || l.fromId === 'movers')).toBe(false);
    expect(scene(seedDoc(now)).units.find(u => u.id === 'move')?.stack).toBeUndefined();
  });
  it('draws a hidden unit\'s order from the stack, once per target, and none inside the task force', () => {
    let doc = run(seedDoc(now), '/attack PACKING LEAK');
    doc = run(doc, '/attack MOVERS LEAK support');
    doc = run(doc, '/link PACKING MOVERS');
    const s = scene(run(doc, '/collapse MOVE'));
    const onLeak = s.orders.filter(o => o.toId === 'leak' && (o.kind === 'main' || o.kind === 'support'));
    expect(onLeak).toHaveLength(1);
    expect(s.orders.some(o => o.kind === 'link' && o.fromId === 'packing')).toBe(false);
    // The arrow starts where the stack is.
    const open = scene(doc).orders.find(o => o.id === onLeak[0].id)!;
    expect(onLeak[0].shaft ?? onLeak[0].outline).not.toBe(open.shaft ?? open.outline);
  });
  it('marks the stack selected when a hidden unit is open in the sidebar', () => {
    const s = scene(run(seedDoc(now), '/collapse MOVE'), 'packing');
    expect(s.units.find(u => u.id === 'move')?.selected).toBe(true);
  });
});
