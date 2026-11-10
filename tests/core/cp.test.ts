import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { importJson } from '../../src/core/model/json';
import { symbolOptions, toSidc } from '../../src/core/model/sidc';
import { Store } from '../../server/db';
import { Hub } from '../../server/hub';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)).doc; };
const unit = (doc: Doc, id: string) => doc.units.find(u => u.id === id)!;

describe('/cp command posts', () => {
  it('parses the four types and none, and refuses anything else', () => {
    const doc = seedDoc(now);
    expect(parse('/cp HOME main', doc, { now })).toMatchObject({ ok: true, cmd: { verb: 'cp', args: { unit: 'home', cp: 'main' } }, preview: 'HOME CP MAIN' });
    expect(parse('/commandpost IRSRSP TAC', doc, { now })).toMatchObject({ ok: true, cmd: { args: { unit: 'irsrsp', cp: 'tac' } } });
    expect(parse('/cp HOME forward', doc, { now })).toMatchObject({ ok: false, error: 'Expected main, tac, alt, rear or none' });
    expect(parse('/cp HOME none', doc, { now })).toMatchObject({ ok: false, error: 'HOME is not a command post' });
    expect(suggest('/cp HOME ', 9, doc).items.map(i => i.insert)).toEqual(['main', 'tac', 'alt', 'rear', 'none']);
  });

  it('marks the unit as a headquarters with the type in place of the icon, keeping its function', () => {
    const before = seedDoc(now);
    const doc = run(before, '/cp IRSRSP tac');
    const u = unit(doc, 'irsrsp');
    expect(u.cp).toBe('tac');
    expect(u.fn).toBe(unit(before, 'irsrsp').fn);
    expect(toSidc(u)[7]).toBe('2');                           // headquarters indicator
    expect(toSidc(unit(before, 'irsrsp'))[7]).toBe('0');
    expect(toSidc(u).slice(10, 16)).toBe('000000');
    expect(toSidc(unit(run(doc, '/cp IRSRSP none'), 'irsrsp'))).toBe(toSidc(unit(before, 'irsrsp')));
    for (const view of ['commander', 'staff', 'detail'] as const) expect(symbolOptions(u, view).specialHeadquarters).toBe('TAC');
    expect(doc.log.at(-1)?.text).toBe('IRSRSP CP TAC');
    expect(parse('/cp IRSRSP tac', doc, { now })).toMatchObject({ ok: false, error: 'IRSRSP is already TAC CP' });
    const cleared = run(doc, '/cp IRSRSP none');
    expect(unit(cleared, 'irsrsp').cp).toBeUndefined();
    expect(cleared.log.at(-1)?.text).toBe('IRSRSP CP REMOVED');
  });

  it('round-trips through import, rejects unknown types, and is accepted and undone by the server', () => {
    const doc = run(seedDoc(now), '/cp HOME main');
    expect(unit(importJson(JSON.stringify(doc)), 'home').cp).toBe('main');
    expect(() => importJson(JSON.stringify({ ...doc, units: doc.units.map(u => u.id === 'home' ? { ...u, cp: 'fwd' } : u) }))).toThrow();
    const store = new Store(':memory:');
    try {
      const hub = new Hub(store);
      hub.import('human', seedDoc(now), now);
      const p = parse('/cp HOME alt', hub.doc, { now }); if (!p.ok) throw new Error(p.error);
      hub.submit('human', 'web', 'cp-1', p.cmd, now);
      expect(unit(hub.doc, 'home').cp).toBe('alt');
      hub.undo('human', 'cp-undo');
      expect(unit(hub.doc, 'home').cp).toBeUndefined();
    } finally { store.close(); }
  });
});
