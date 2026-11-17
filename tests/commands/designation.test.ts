import { describe, expect, it } from 'vitest';
import { apply } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) return { error: p.error }; return apply(doc, p.cmd, now); };
const ok = (doc: Doc, text: string) => { const r = run(doc, text); if ('error' in r) throw new Error(r.error); return r; };
const names = (doc: Doc) => doc.units.map(u => u.designation);

describe('as ‹designation›: a taken name gets the next number', () => {
  it('/new … as DELTA becomes DELTA2, then DELTA3', () => {
    let doc = ok(seedDoc(now), '/new "One" in Work as delta').doc;
    const second = ok(doc, '/new "Two" in Work as DELTA');
    expect(second.log).toContain('CAPTURE DELTA2');
    doc = ok(second.doc, '/new "Three" in Work as DELTA').doc;
    expect(names(doc)).toEqual(expect.arrayContaining(['DELTA', 'DELTA2', 'DELTA3']));
  });

  it('a name that ends in a number is never changed: a duplicate is an error', () => {
    const doc = ok(ok(seedDoc(now), '/new "One" in Work as DELTA2').doc, '/new "Two" in Work as BRAVO1').doc;
    expect(run(doc, '/new "Three" in Work as DELTA2')).toMatchObject({ error: 'Designation DELTA2 is already taken' });
    expect(run(doc, '/new "Four" in Work as bravo1')).toMatchObject({ error: 'Designation BRAVO1 is already taken' });
  });

  it('/rename … as DELTA numbers too, and keeping the unit\'s own name is not a clash', () => {
    let doc = ok(seedDoc(now), '/new "One" in Work as DELTA').doc;
    doc = ok(doc, '/rename RECORDS "Records" as DELTA').doc;
    expect(names(doc)).toContain('DELTA2');
    expect(ok(doc, '/rename DELTA2 "Records again" as DELTA2').doc.units.some(u => u.designation === 'DELTA2' && u.title === 'Records again')).toBe(true);
    expect(run(doc, '/rename DELTA "One" as DELTA2')).toMatchObject({ error: 'Designation DELTA2 is already taken' });
  });
});
