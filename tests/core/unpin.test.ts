import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { advanceDay } from '../../src/core/commands/turn';
import { seedDoc } from '../../src/core/model/seed';
import { ringForRadius } from '../../src/core/model/geometry';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)).doc; };
const unit = (doc: Doc, d: string) => doc.units.find(u => u.designation === d)!;

describe('/unpin', () => {
  // A dated hostile three weeks out (MID band), dragged by hand into the near band.
  const pinned = () => run(run(seedDoc(now), '/new hostile "Renewal" in Work due 2026-12-01 as RENEW'), '/move RENEW to Work near');

  it('releases a hand-placed unit back to the ring its due date gives, in the same sector', () => {
    const doc = pinned();
    expect(unit(doc, 'RENEW').posOverride).toBe(true);
    expect(ringForRadius(unit(doc, 'RENEW').pos.r)).toBe('near');
    const out = run(doc, '/unpin RENEW');
    const u = unit(out, 'RENEW');
    expect(u.posOverride).toBeUndefined();
    expect(u.dueAt).toBe(unit(doc, 'RENEW').dueAt);
    expect(u.sectorId).toBe('work');
    expect(ringForRadius(u.pos.r)).toBe('mid');
    expect(out.log.at(-1)?.text).toMatch(/^RENEW UNPINNED → MID/);
  });

  it('lets auto-advance move it again', () => {
    const doc = run(pinned(), '/unpin RENEW');
    const later = advanceDay(doc, new Date('2026-11-25T12:00:00Z')).doc;
    expect(unit(later, 'RENEW').pos.r).toBeLessThan(unit(doc, 'RENEW').pos.r);
  });

  it('refuses a unit that is not pinned and suggests only pinned units', () => {
    const doc = pinned();
    expect(parse('/unpin TOOLS', doc, { now })).toMatchObject({ ok: false, error: 'TOOLS is not pinned' });
    expect(parse('/unpin', doc, { now })).toMatchObject({ ok: false });
    expect(suggest('/unpin ', 7, doc).items.map(i => i.insert)).toEqual(['RENEW']);
  });
});
