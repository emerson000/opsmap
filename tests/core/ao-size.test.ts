import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { exportJson, importJson } from '../../src/core/model/json';
import { placementFits, polarToXY, ringForRadius } from '../../src/core/model/geometry';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const exec = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)); };
const run = (doc: Doc, text: string) => exec(doc, text).doc;
/** Closest pair of live units in one sector, in ring units. */
const tightest = (doc: Doc, sectorId: string) => {
  const pts = doc.units.filter(u => u.sectorId === sectorId && u.lifecycle !== 'dropped').map(u => polarToXY(u.pos));
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return min;
};
/** Fill one sector's near band with captures. */
const crowd = (doc: Doc, n: number) => { for (let i = 0; i < n; i++) doc = run(doc, `/new hostile "Item ${i}" in Work near as CR${i}`); return doc; };

describe('/ao size', () => {
  it('parses through the /ao alias and /sector, and refuses unknown sizes', () => {
    const doc = seedDoc(now);
    expect(parse('/ao size large', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'sector', args: { action: 'size', size: 'large' } }, preview: 'AO SIZE LARGE' });
    expect(parse('/sector size XL', doc, { now })).toMatchObject({ ok: true, cmd: { args: { size: 'xl' } } });
    expect(parse('/ao size huge', doc, { now })).toMatchObject({ ok: false, error: 'Expected small, medium, large or xl' });
    expect(parse('/ao size medium', doc, { now })).toMatchObject({ ok: false, error: 'AO is already MEDIUM' });
    expect(suggest('/ao ', 4, doc).items.map(i => i.insert)).toContain('size');
    expect(suggest('/ao size ', 9, doc).items.map(i => i.insert)).toEqual(['small', 'medium', 'large', 'xl']);
  });

  it('stores the scale in settings, medium as absent, and survives export and import', () => {
    const large = run(seedDoc(now), '/ao size large');
    expect(large.settings.aoSize).toBe(1.35);
    expect(importJson(exportJson(large)).settings.aoSize).toBe(1.35);
    expect(run(large, '/ao size medium').settings).not.toHaveProperty('aoSize');
    expect(() => importJson(JSON.stringify({ ...JSON.parse(exportJson(large)), settings: { ...large.settings, aoSize: 40 } }))).toThrow();
  });

  it('gives every unit in a crowded band full spacing when larger, without changing any unit’s sector or ring', () => {
    const fits = (doc: Doc) => doc.units.filter(u => u.lifecycle !== 'dropped').every(u => placementFits(doc, u.sectorId, u.pos, u.id));
    const before = crowd(seedDoc(now), 8);
    const after = run(before, '/ao size xl');
    expect(fits(before)).toBe(false);
    expect(fits(after)).toBe(true);
    expect(tightest(after, 'work')).toBeGreaterThan(0.74 / 1.75 - 1e-6);
    for (const u of after.units) {
      const old = before.units.find(x => x.id === u.id)!;
      expect(u.sectorId).toBe(old.sectorId);
      expect(ringForRadius(u.pos.r)).toBe(ringForRadius(old.pos.r));
      expect(u.updatedAt).toBe(old.updatedAt);
    }
    const back = run(run(after, '/ao size small'), '/ao size medium');
    expect(back.units.every(u => back.units.every(v => u === v || Math.hypot(polarToXY(u.pos).x - polarToXY(v.pos).x, polarToXY(u.pos).y - polarToXY(v.pos).y) > 0.01))).toBe(true);
  });

  it('hints at the next size up when a capture or move cannot get full spacing', () => {
    let doc = seedDoc(now), log = '';
    for (let i = 0; i < 40 && !log.includes('BAND FULL'); i++) { const r = exec(doc, `/new hostile "Item ${i}" in Work near as CR${i}`); doc = r.doc; log = r.log; }
    expect(log).toContain('BAND FULL: TRY /ao size large');
    const last = doc.units.at(-1)!;
    expect(placementFits(doc, last.sectorId, last.pos, last.id)).toBe(false);
    const xl = run(doc, '/ao size xl');
    expect(exec(xl, '/new hostile "One more" in Work near as MORE').log).not.toContain('TRY /ao size xl');
    expect(exec(seedDoc(now), '/new hostile "Fine" in Work far as FINE').log).not.toContain('BAND FULL');
  });
});
