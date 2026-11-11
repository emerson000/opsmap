import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import { sitrepText } from '../../src/core/commands/sitrep';
import type { Doc } from '../../src/core/model/types';

const t0 = new Date('2026-11-10T14:00:00Z');
let clock = t0.getTime();
const run = (doc: Doc, text: string) => { const now = new Date(clock += 60_000); const p = parse(text, doc, { now }); if (!p.ok) throw new Error(`${text}: ${p.error}`); const r: ApplyResult = apply(doc, p.cmd, now); if ('error' in r) throw new Error(r.error); return r.doc; };
const day = (): Doc => {
  clock = t0.getTime();
  let doc = seedDoc(new Date('2026-11-09T12:00:00Z'));
  for (const c of [
    '/new hostile "Furnace inspection" in Household near as FURNACE', '/new friend "Pack boxes" in Household as BOXES',
    '/new "Scratch" in Work as NEW1', '/size NEW1 plt', '/size NEW1 tm', '/size NEW1 plt', '/size NEW1 tm', '/drop NEW1',
    '/obj add "TEST" in Work mid', '/obj move TEST to Work far', '/obj remove TEST', '/obj add "HEALTHCARE" in Wellness mid',
    '/attack RECORDS FURNACE main', '/attack IRSRSP LEAK support', '/halt IRSRSP', '/done LEAK', '/note TOOLS "Compare options"', '/move TOOLS to Work near',
  ]) doc = run(doc, c);
  return doc;
};

describe('SITREP', () => {
  it('has one heading per paragraph and plain sentences under it', () => {
    const text = sitrepText(day(), new Date(clock + 60_000));
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^SITREP \d{6}J[A-Z]{3}\d{2}$/);
    for (const h of ['1. ENEMY', '2. FRIENDLY', '3. TERRAIN', "5. COMMANDER'S INTENT TODAY"]) expect(lines).toContain(h);
    expect(lines.some(l => l.startsWith('4. CHANGES LAST 24 H ('))).toBe(true);
    expect(lines.filter(l => !/^(SITREP|\d\. )/.test(l)).every(l => l.startsWith('   '))).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);           // no raw timestamps
  });
  it('summarizes what holds now: churn, things opened and dropped, and cancelled orders leave no trace', () => {
    const text = sitrepText(day(), new Date(clock + 60_000));
    expect(text).toContain('   New (2): hostile FURNACE; friend BOXES.');
    expect(text).toContain('   Closed (2): destroyed LEAK; withdrawn NEW1.');
    expect(text).toContain('   Orders given: RECORDS main attack → FURNACE.');
    expect(text).toContain('   Control measures: added OBJ HEALTHCARE.');
    expect(text).not.toContain('OBJ TEST');
    expect(text).not.toContain('RESIZED');
    expect(text).toMatch(/   Also updated: \d+ other units? \(.*TOOLS.*\)\./);
  });
  it('says plainly when there is nothing to report', () => {
    const text = sitrepText(seedDoc(new Date('2026-11-09T12:00:00Z')), new Date('2026-11-12T12:00:00Z'));
    expect(text).toContain('   No changes recorded.');
    expect(text).toContain('   None set (/intent "…").');
  });
});
