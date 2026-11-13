import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { sitrepText } from '../../src/core/commands/sitrep';
import { advanceDay } from '../../src/core/commands/turn';
import { seedDoc } from '../../src/core/model/seed';
import { importJson } from '../../src/core/model/json';
import { ringForRadius } from '../../src/core/model/geometry';
import { orderLine } from '../../src/lib/ui/words';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const exec = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)); };
const run = (doc: Doc, text: string) => exec(doc, text).doc;
const orders = (doc: Doc, from: string) => doc.orders.filter(o => o.from === from);

describe('/withdraw', () => {
  it('defaults to the next ring out and does not move the unit or its date', () => {
    const doc = seedDoc(now), leak = doc.units.find(u => u.id === 'leak')!;
    expect(parse('/withdraw LEAK', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'withdraw', args: { unit: 'leak' } }, preview: 'LEAK (ENG PLT) WITHDRAWS TO MID RING' });
    const after = run(doc, '/withdraw LEAK');
    expect(orders(after, 'leak')).toMatchObject([{ type: 'withdraw', to: 'ring:mid' }]);
    const moved = after.units.find(u => u.id === 'leak')!;
    expect(moved.pos).toEqual(leak.pos);
    expect(moved.dueAt).toBe(leak.dueAt);
  });

  it('takes an explicit ring, ring aliases and the retreat, wd and fallback aliases', () => {
    const doc = seedDoc(now);
    expect(parse('/withdraw LEAK to far', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'ring:far' } }, preview: 'LEAK (ENG PLT) WITHDRAWS TO FAR RING' });
    expect(parse('/withdraw LEAK to aoi', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'ring:far' } } });
    expect(parse('/withdraw LEAK to beyond', doc, { now })).toMatchObject({ ok: true, preview: 'LEAK (ENG PLT) WITHDRAWS TO MAP EDGE' });
    for (const alias of ['retreat', 'wd', 'fallback']) expect(parse(`/${alias} LEAK`, doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'withdraw' } });
  });

  it('refuses inward and same-ring targets, HQ targets, and a unit already beyond the edge', () => {
    const doc = seedDoc(now);
    expect(parse('/withdraw IRS to near', doc, { now })).toMatchObject({ ok: false, error: 'Withdraw target must be farther from HQ than IRS' });
    expect(parse('/withdraw IRS to mid', doc, { now })).toMatchObject({ ok: false, error: 'IRS is already in the mid ring' });
    expect(parse('/withdraw IRS to hq', doc, { now })).toMatchObject({ ok: false, error: 'Expected near, mid, far or beyond' });
    expect(parse('/withdraw IRS to', doc, { now })).toMatchObject({ ok: false });
    const beyond = run(doc, '/move LEAK beyond');
    expect(parse('/withdraw LEAK', beyond, { now })).toMatchObject({ ok: false, error: 'LEAK is already beyond the map edge' });
    expect(parse('/withdraw BACKLOG', doc, { now })).toMatchObject({ ok: false, error: 'Archived or destroyed units cannot receive orders' });
  });

  it('cancels an advance or a move, and an advance or a move cancels it', () => {
    let doc = seedDoc(now);
    const r = exec(doc, '/withdraw ESCALATION');
    expect(r.log).toBe('ESCALATION (ARMOR BN) WITHDRAWS TO NEAR RING — ADVANCE CANCELLED');
    expect(orders(r.doc, 'escalation').map(o => o.type).sort()).toEqual(['withdraw']);
    doc = run(r.doc, '/advancing ESCALATION on hq');
    expect(orders(doc, 'escalation').map(o => o.type)).toEqual(['advance']);
    doc = run(seedDoc(now), '/moving MOVE to hq');
    const w = exec(doc, '/withdraw MOVE');
    expect(w.log).toMatch(/— MOVE CANCELLED$/);
    // Attacks and axes stand.
    expect(orders(w.doc, 'move').map(o => o.type).sort()).toEqual(['axis', 'withdraw']);
  });

  it('completes when the unit reaches its ring by /due, /move or unpin, and not before', () => {
    let doc = run(seedDoc(now), '/withdraw LEAK to far');
    let r = exec(doc, '/due LEAK 2026-11-20');
    expect(ringForRadius(r.doc.units.find(u => u.id === 'leak')!.pos.r)).toBe('mid');
    expect(orders(r.doc, 'leak')).toHaveLength(1);
    r = exec(r.doc, '/move LEAK far');
    expect(r.log).toMatch(/ — LEAK WITHDRAWAL COMPLETE$/);
    expect(orders(r.doc, 'leak')).toHaveLength(0);
    doc = run(seedDoc(now), '/withdraw LEAK');
    r = exec(doc, '/due LEAK 2026-11-25');
    expect(r.log).toBe('LEAK DUE 2026-11-25T17:00:00.000Z — LEAK WITHDRAWAL COMPLETE');
  });

  it('/halt cancels it by kind and in full, and the order line and import keep it', () => {
    const doc = run(seedDoc(now), '/withdraw LEAK to far');
    expect(exec(doc, '/halt LEAK withdraw').log).toBe('LEAK HALTED: WITHDRAW TO FAR RING CANCELLED');
    expect(exec(doc, '/halt LEAK withdrawing').doc.orders.some(o => o.type === 'withdraw')).toBe(false);
    expect(orderLine(doc, orders(doc, 'leak')[0], 'leak').text).toMatch(/Withdrawing.*FAR RING/);
    expect(importJson(JSON.stringify(doc)).orders).toEqual(doc.orders);
    expect(() => importJson(JSON.stringify({ ...doc, orders: doc.orders.map(o => o.type === 'withdraw' ? { ...o, to: 'hq' } : o) }))).toThrow();
    expect(() => importJson(JSON.stringify({ ...doc, orders: doc.orders.map(o => o.type === 'withdraw' ? { ...o, to: 'ring:hq' } : o) }))).toThrow();
  });

  it('the morning turn gives a withdrawing hostile no advance order, and the sitrep lists it', () => {
    const doc = run(seedDoc(now), '/withdraw LEAK to far');
    const turned = advanceDay(doc, new Date('2026-11-11T12:00:00Z')).doc;
    expect(orders(turned, 'leak').map(o => o.type)).toEqual(['withdraw']);
    const text = sitrepText(doc, now);
    expect(text).toMatch(/WITHDRAWING \(1\): LEAK to FAR RING\./);
    expect(text).toMatch(/LEAK withdrawing to → FAR RING/);
  });

  it('autocomplete offers the retreat and fallback aliases as you type them, then runs as /withdraw', () => {
    const doc = seedDoc(now);
    expect(suggest('/ret', 4, doc).items).toEqual([expect.objectContaining({ insert: 'retreat', label: '/retreat', detail: expect.stringMatching(/^\/withdraw ‹unit›/) })]);
    expect(suggest('/fall', 5, doc).items.map(s => s.label)).toEqual(['/fallback']);
    expect(suggest('/wd', 3, doc).items.map(s => s.label)).toContain('/wd');
    expect(suggest('/withd', 6, doc).items.map(s => s.label)).toEqual(['/withdraw']);
    // Nothing typed: verbs only, no alias clutter.
    expect(suggest('/', 1, doc).items.some(s => s.label === '/retreat')).toBe(false);
    expect(suggest('/retreat ', 9, doc).items[0]?.kind).toBe('unit');
    expect(suggest('/retreat LEAK ', 14, doc).items.map(s => s.insert)).toEqual(['to']);
  });

  it('suggests hostiles first, then to, then only outward rings', () => {
    const doc = seedDoc(now);
    const units = suggest('/withdraw ', 10, doc).items.map(s => s.label);
    expect(units.indexOf('LEAK')).toBeLessThan(units.indexOf('HOME'));
    expect(suggest('/withdraw LEAK ', 15, doc).items.map(s => s.insert)).toEqual(['to']);
    expect(suggest('/withdraw IRS to ', 17, doc).items.map(s => s.insert)).toEqual(['far', 'beyond']);
  });
});

describe('ring targets on /moving and /advancing', () => {
  it('a move or an advance to an inner ring', () => {
    const doc = seedDoc(now);
    expect(parse('/moving MOVE to mid', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'moving', args: { target: 'ring:mid' } }, preview: 'MOVE (TRANS DIV) MOVES TO MID RING' });
    expect(parse('/advancing IRS on near', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'ring:near' } }, preview: 'IRS (FIN COY) ADVANCES ON NEAR RING' });
    expect(parse('/advancing IRS on close', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'ring:near' } } });
  });

  it('refuses outward and same-ring targets with a pointer to /withdraw, and rings for other verbs', () => {
    const doc = seedDoc(now);
    expect(parse('/advancing IRS on far', doc, { now })).toMatchObject({ ok: false, error: 'Use /withdraw to move IRS away from HQ' });
    expect(parse('/moving HOME to far', doc, { now })).toMatchObject({ ok: false, error: 'Use /withdraw to move HOME away from HQ' });
    expect(parse('/moving HOME to near', doc, { now })).toMatchObject({ ok: false, error: 'HOME is already in the near ring' });
    expect(parse('/attack HOME far', doc, { now })).toMatchObject({ ok: false });
  });

  it('a quoted ring word still names a unit', () => {
    const doc = run(seedDoc(now), '/new hostile "Far" in Household mid as FAR');
    expect(parse('/advancing FAR on near', doc, { now })).toMatchObject({ ok: true, cmd: { args: { target: 'ring:near' } } });
    expect(parse('/moving RECORDS to "FAR"', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'attack' } });
  });

  it('completes when the unit gets there, including on the morning turn', () => {
    const doc = run(seedDoc(now), '/advancing IRS on near');
    // IRS is due 20 Nov: inside PL WEEK from 13 Nov.
    const turned = advanceDay(doc, new Date('2026-11-14T12:00:00Z'));
    expect(ringForRadius(turned.doc.units.find(u => u.id === 'irs')!.pos.r)).toBe('near');
    expect(turned.doc.orders.some(o => o.from === 'irs' && o.to === 'ring:near')).toBe(false);
    expect(turned.log).toMatch(/IRS ADVANCE COMPLETE/);
  });

  it('suggests inner rings after to and on', () => {
    const doc = seedDoc(now);
    const items = suggest('/advancing IRS on ', 18, doc).items.map(s => s.insert);
    expect(items).toContain('near');
    expect(items).not.toContain('far');
    expect(items).not.toContain('mid');
  });
});
