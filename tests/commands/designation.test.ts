import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) return { error: p.error }; return apply(doc, p.cmd, now); };
const ok = (doc: Doc, text: string) => { const r = run(doc, text); if ('error' in r) throw new Error(r.error); return r; };
const names = (doc: Doc) => doc.units.map(u => u.designation);
const outcome = (doc: Doc, text: string) => { const r = run(doc, text); return 'error' in r ? { error: r.error } : { designation: r.doc.units.at(-1)!.designation }; };

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

describe('a designation made from the title follows the same rules as one typed with as', () => {
  // Each title's designation request (its letters and digits, at most 8) next to the same request typed with as.
  const cases: [title: string, as: string][] = [['E1', 'E1'], ['e1', 'E1'], ['Delta', 'DELTA'], ['Plan 2025', 'PLAN2025'], ['Fix the sink', 'FIXTHESI'], ['Q4 report', 'Q4REPORT']];
  it.each(cases)('/new "%s" behaves like as %s: when free, and when taken', (title, as) => {
    const fresh = seedDoc(now);
    expect(outcome(fresh, `/new "${title}" in Work`)).toEqual(outcome(fresh, `/new "Other" in Work as ${as}`));
    const taken = ok(fresh, `/new "First" in Work as ${as}`).doc;
    expect(outcome(taken, `/new "${title}" in Work`)).toEqual(outcome(taken, `/new "Other" in Work as ${as}`));
  });

  it('E1 is refused when taken; Delta is numbered', () => {
    const doc = ok(ok(seedDoc(now), '/new "E1" in Work').doc, '/new "Delta" in Work').doc;
    expect(run(doc, '/new "E1" in Work')).toMatchObject({ error: 'Designation E1 is already taken' });
    expect(ok(doc, '/new "Delta" in Work').log).toContain('CAPTURE DELTA2');
  });
});

describe('Vikunja tasks', () => {
  it('a task titled like a taken designation still syncs, with a free designation', () => {
    let doc = ok(seedDoc(now), '/new "E1" in Work').doc;
    const bound = apply(doc, { verb: 'tasks', args: { action: 'bound', provider: 'vikunja', label: 'Vikunja', root: '1', title: 'Main' } }, now);
    if ('error' in bound) throw new Error(bound.error);
    doc = bound.doc;
    const r = apply(doc, { verb: 'tasks', args: { action: 'add', task: '9001', title: 'E1', sectorId: 'work' } }, now);
    if ('error' in r) throw new Error(r.error);
    expect(r.doc.units.find(u => u.remote === '9001')?.designation).toBe('E1-2');
  });
});

describe('one gate for designations', () => {
  // Every designation is set through designate() in apply.ts (claimDesignation's rules). Any other assignment
  // in the core or the server would skip them.
  const files = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) ? [p] : []; });
  it('no code outside designate() assigns a unit designation', () => {
    const offenders = [...files('src/core'), ...files('server')].flatMap(f => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
      // `a.designation=` is the parser filling in the command's arguments, not a unit.
      .filter(({ line }) => [...line.matchAll(/(\w+)\.designation\s*=(?!=)\s*(\w*)/g)].some(m => m[1] !== 'a' && m[2] !== 'designate'));
    expect(offenders.map(o => `${o.f}:${o.i}`)).toEqual([]);
  });
});
