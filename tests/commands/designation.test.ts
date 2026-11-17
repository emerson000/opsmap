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

describe('a title typed as a designation', () => {
  it('/new "E1" fails when E1 exists, like as E1; a free one is used as typed', () => {
    let doc = ok(seedDoc(now), '/new "E1" in Work').doc;
    expect(names(doc)).toContain('E1');
    expect(run(doc, '/new "E1" in Work')).toMatchObject({ error: 'Designation E1 is already taken' });
    expect(run(doc, '/new "e1" in Work')).toMatchObject({ error: 'Designation E1 is already taken' });
    doc = ok(doc, '/new "E2" in Work').doc;
    expect(names(doc)).toContain('E2');
  });

  it('a one-word title without a digit is numbered, like as DELTA', () => {
    const doc = ok(ok(seedDoc(now), '/new "Delta" in Work').doc, '/new "Delta" in Work').doc;
    expect(names(doc)).toEqual(expect.arrayContaining(['DELTA', 'DELTA2']));
  });

  it('a longer title is never refused; a base that ends in a digit gets a hyphen before its number', () => {
    let doc = ok(seedDoc(now), '/new "Plan 2025" in Work').doc;
    doc = ok(doc, '/new "Plan 2025" in Work').doc;
    doc = ok(doc, '/new "Plan 2025" in Work').doc;
    expect(names(doc)).toEqual(expect.arrayContaining(['PLAN2025', 'PLAN2025-2', 'PLAN2025-3']));
    // An explicit designation still wins over the title.
    expect(ok(doc, '/new "E1" in Work as E7').log).toContain('CAPTURE E7');
  });
});

describe('Vikunja tasks', () => {
  it('a task titled like a taken designation still syncs, with a free designation', () => {
    let doc = ok(seedDoc(now), '/new "E1" in Work').doc;
    const bound = apply(doc, { verb: 'vk', args: { action: 'bound', project: 1, title: 'Main' } }, now);
    if ('error' in bound) throw new Error(bound.error);
    doc = bound.doc;
    const r = apply(doc, { verb: 'vk', args: { action: 'add', task: 9001, title: 'E1', sectorId: 'work' } }, now);
    if ('error' in r) throw new Error(r.error);
    expect(r.doc.units.find(u => u.vk === 9001)?.designation).toBe('E1-2');
  });
});
