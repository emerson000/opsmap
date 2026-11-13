import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const exec = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)); };

describe('/bda clear', () => {
  it('removes the strength and keeps the condition', () => {
    let doc = exec(seedDoc(now), '/bda IRS dmg').doc;
    expect(parse('/bda IRS clear', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'bda', args: { unit: 'irs', strength: null } }, preview: 'BDA IRS STRENGTH CLEARED' });
    doc = exec(doc, '/bda IRS clear').doc;
    const irs = doc.units.find(u => u.id === 'irs')!;
    expect(irs.strength).toBeUndefined();
    expect(irs.condition).toBe('damaged');
    expect(JSON.parse(JSON.stringify(doc)).units.find((u: { id: string }) => u.id === 'irs').strength).toBeUndefined();
  });

  it('is refused when no strength is set, and named in the error for a bad token', () => {
    const doc = exec(seedDoc(now), '/bda IRS clear').doc;
    expect(parse('/bda IRS clear', doc, { now })).toMatchObject({ ok: false, error: 'IRS has no strength to clear' });
    expect(parse('/bda IRS half', doc, { now })).toMatchObject({ ok: false, error: 'Expected 0–100%, clear, fc, dmg, des, full or none' });
  });

  it('autocomplete offers clear only when there is a strength', () => {
    const doc = seedDoc(now);
    expect(suggest('/bda IRS ', 9, doc).items.map(s => s.insert)).toContain('clear');
    const cleared = exec(doc, '/bda IRS clear').doc;
    expect(suggest('/bda IRS ', 9, cleared).items.map(s => s.insert)).not.toContain('clear');
  });
});
