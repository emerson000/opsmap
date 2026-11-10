import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { importJson } from '../../src/core/model/json';
import { buildScene } from '../../src/lib/map/scene';
import { orderLine } from '../../src/lib/ui/words';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)).doc; };
const advance = (doc: Doc, from: string) => doc.orders.find(o => o.type === 'advance' && o.from === from);

describe('advancing on a sector HQ', () => {
  it('parses sector hq (own sector), <sector> hq, and plain hq', () => {
    const doc = seedDoc(now);
    expect(parse('/advancing LEAK on sector hq', doc, { now })).toMatchObject({ ok: true, cmd: { args: { unit: 'leak', target: 'hq:household' } }, preview: 'LEAK (ENG PLT) ADVANCES ON HOUSEHOLD HQ' });
    expect(parse('/advancing LEAK on Household hq', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'hq:household' } } });
    expect(parse('/advancing LEAK on hq', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'hq' } } });
    expect(parse('/advancing LEAK on Work hq', doc, { now })).toMatchObject({ ok: false, error: 'Cross-sector orders require a task force' });
  });

  it('draws the arrow to the sector HQ, which then shows in Commander view, and names it in the order text', () => {
    const doc = run(seedDoc(now), '/advancing LEAK on sector hq');
    expect(advance(doc, 'leak')?.to).toBe('hq:household');
    const scene = buildScene(doc, { view: 'commander', now });
    const sector = scene.sectors.find(s => s.id === 'household')!;
    expect(sector.hqTargeted).toBe(true);
    expect(scene.sectors.filter(s => s.hqTargeted).map(s => s.id)).toEqual(['household']);
    const arrow = scene.orders.find(o => o.fromId === 'leak' && o.kind === 'advance');
    expect(arrow?.toId).toBe('hq:household');
    expect(arrow?.shaft).toBeTruthy();
    expect(orderLine(doc, advance(doc, "leak")!, "leak").text).toMatch(/HOUSEHOLD HQ/);
    expect(importJson(JSON.stringify(doc)).orders).toEqual(doc.orders);
    expect(() => importJson(JSON.stringify({ ...doc, orders: doc.orders.map(o => o.from === 'leak' && o.type === 'advance' ? { ...o, to: 'hq:nowhere' } : o) }))).toThrow();
  });

  it('a friendly can move to its sector HQ; attacks on a sector HQ are refused', () => {
    const doc = run(seedDoc(now), '/moving RECORDS to sector hq');
    expect(doc.orders.find(o => o.from === 'records' && o.type === 'move')?.to).toBe('hq:household');
    expect('error' in apply(doc, { verb: 'attack', args: { unit: 'irsrsp', target: 'hq:household' } }, now)).toBe(true);
  });

  it('a unit leaving the sector cancels its advance; removing a sector drops or reassigns those orders', () => {
    let doc = run(seedDoc(now), '/advancing LEAK on sector hq');
    const moved = run(doc, '/move LEAK to Work near');
    expect(advance(moved, 'leak')).toBeUndefined();
    expect(moved.log.at(-1)?.text).toMatch(/ADVANCE ON HOUSEHOLD HQ CANCELLED \(BOUNDARY\)/);
    doc = run(doc, '/sector remove Household reassign Family');
    expect(advance(doc, 'leak')?.to).toBe('hq:family');
  });

  it('suggests sector hq and each sector after on', () => {
    const items = suggest('/advancing LEAK on ', 19, seedDoc(now)).items.map(i => i.insert);
    expect(items.slice(0, 6)).toEqual(['sector hq', 'Work hq', 'Household hq', 'Family hq', 'Wellness hq', 'Productivity hq']);
  });
});
