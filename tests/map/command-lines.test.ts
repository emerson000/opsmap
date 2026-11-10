import { describe, expect, it } from 'vitest';
import { apply } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import { toSidc } from '../../src/core/model/sidc';
import { buildScene } from '../../src/lib/map/scene';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); const r = apply(doc, p.cmd, now); if ('error' in r) throw new Error(r.error); return r.doc; };
const enemy = () => {
  let doc = run(seedDoc(now), '/new hostile bn hq "Landlord legal team" in Household mid as LEGAL');
  doc = run(doc, '/attach IRS to LEGAL');
  return run(doc, '/attach LEAK to LEGAL');
};

describe('hostile headquarters and command lines', () => {
  it('a hostile HQ is a headquarters symbol with its subordinates attached', () => {
    const doc = enemy();
    const hq = doc.units.find(u => u.designation === 'LEGAL')!;
    expect(hq.affiliation).toBe('hostile');
    expect(toSidc(hq).slice(3, 4)).toBe('6');
    expect(Number(toSidc(hq)[7]) & 2).toBe(2);
    expect(doc.units.filter(u => u.parentId === hq.id).map(u => u.designation).sort()).toEqual(['IRS', 'LEAK']);
  });

  it('draws command lines in Staff and Detail, in the HQ\'s color, and only for the selection in Commander', () => {
    const doc = enemy();
    const hq = doc.units.find(u => u.designation === 'LEGAL')!;
    const staff = buildScene(doc, { view: 'staff', now }).commandLines.filter(c => c.toId === hq.id);
    expect(staff.map(c => c.fromId).sort()).toEqual(['irs', 'leak']);
    expect(staff.every(c => c.side === 'threat' && /^M[\d.-]+ [\d.-]+ L[\d.-]+ [\d.-]+$/.test(c.d))).toBe(true);
    expect(buildScene(doc, { view: 'commander', now }).commandLines.filter(c => c.toId === hq.id)).toEqual([]);
    expect(buildScene(doc, { view: 'commander', now, selectedId: hq.id }).commandLines.map(c => c.fromId).sort()).toEqual(['irs', 'leak']);
    expect(buildScene(doc, { view: 'commander', now, selectedId: 'irs' }).commandLines.map(c => c.fromId)).toEqual(['irs']);
    // Friendly task forces get friendly-colored lines.
    expect(buildScene(seedDoc(now), { view: 'staff', now }).commandLines.filter(c => c.toId === 'move').every(c => c.side === 'friend')).toBe(true);
  });
});
