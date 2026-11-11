import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import { cueFor } from '../../src/core/model/cues';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r.doc; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)); };
const cue = (text: string, doc = seedDoc(now)) => cueFor(doc, run(doc, text));

describe('console cues', () => {
  it('a new track beeps; a new hostile or suspect alerts', () => {
    expect(cue('/new "Fix sink"')).toBe('track');
    expect(cue('/new friend "Help a neighbour"')).toBe('track');
    expect(cue('/new hostile "Parking ticket"')).toBe('hostile');
    expect(cue('/new suspect "Odd charge"')).toBe('hostile');
  });
  it('identifying a track as hostile alerts; other identities are quiet', () => {
    expect(cue('/id TOOLS hostile')).toBe('hostile');
    expect(cue('/id TOOLS friend')).toBeNull();
  });
  it('a hostile destroyed splashes; a friendly done does not', () => {
    expect(cue('/done LEAK')).toBe('splash');
    expect(cue('/bda IRS 0%')).toBe('splash');
    expect(cue('/done IRSRSP')).toBeNull();
  });
  it('everyday edits are quiet', () => {
    for (const text of ['/note LEAK "Roofer Tuesday"', '/move TOOLS to Work near', '/due LEAK +5d', '/bda IRS 40%', '/rename TOOLS "Tools"', '/block PASSPORT by "Photo"'])
      expect(cue(text)).toBeNull();
  });
  it('several changes at once give one cue, the most urgent', () => {
    const before = seedDoc(now);
    const after = run(run(run(before, '/new "A"'), '/done LEAK'), '/new hostile "B"');
    expect(cueFor(before, after)).toBe('hostile');
    expect(cueFor(before, run(run(before, '/new "A"'), '/done LEAK'))).toBe('splash');
  });
});
