import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { emptyDoc, seedDoc } from '../../src/core/model/seed';
import { createInverse } from '../../src/core/model/patch';
import { ringForRadius } from '../../src/core/model/geometry';
import type { Command, Doc } from '../../src/core/model/types';

const now = new Date(2026, 10, 9, 12);
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const cmd = (input: string, doc: Doc): Command => { const p = parse(input, doc, { now }); if (!p.ok) throw new Error(p.error); return p.cmd; };
const nai = (doc: Doc) => doc.measures.find(m => m.id === 'nai-benefits')!;

describe('control measure move (/obj, /ea, /nai move)', () => {
  it('parses ring, sector + ring and near-unit forms', () => {
    const doc = seedDoc(now);
    expect(cmd('/nai move BENEFITS far', doc).args).toEqual({ action: 'move', measure: 'nai-benefits', ring: 'far' });
    expect(cmd('/nai move "BENEFITS ENROLLMENT" to Household mid', doc).args).toEqual({ action: 'move', measure: 'nai-benefits', sectorId: 'household', ring: 'mid' });
    expect(cmd('/obj move "SETTLED IN" near IRS', doc).args).toEqual({ action: 'move', measure: 'obj-settled', nearUnit: 'irs' });
    expect(cmd('/ea move SATURDAY near', doc).args).toEqual({ action: 'move', measure: 'ea-saturday', ring: 'near' });
  });
  it('refuses beyond, the wrong type, and moving a phase line', () => {
    const doc = seedDoc(now);
    const beyond = parse('/nai move BENEFITS beyond', doc, { now });
    expect(beyond.ok).toBe(false);
    expect(parse('/obj move BENEFITS far', doc, { now }).ok).toBe(false);
    expect(parse('/pl move LAUNCH far', doc, { now }).ok).toBe(false);
    expect('error' in apply(doc, { verb: 'pl', args: { action: 'move', measure: 'pl-launch', ring: 'far' } }, now)).toBe(true);
  });
  it('moves to a sector and ring with a doctrinal log line', () => {
    const doc = seedDoc(now);
    const r = ok(apply(doc, cmd('/nai move BENEFITS to Household mid', doc), now, 'alice'));
    const m = nai(r.doc);
    expect(m.sectorId).toBe('household');
    expect(ringForRadius(m.pos!.r)).toBe('mid');
    expect(r.log).toBe('NAI BENEFITS ENROLLMENT MOVED → HOUSEHOLD MID');
    expect(r.touched.measures).toEqual(['nai-benefits']);
    expect(r.doc.log.at(-1)?.text).toBe(r.log);
  });
  it('moves next to a unit, and to a dropped map position (snapped, kept on the map)', () => {
    const doc = seedDoc(now);
    const near = nai(ok(apply(doc, cmd('/nai move BENEFITS near KNEE', doc), now)).doc);
    expect(near.sectorId).toBe('wellness');
    const drop = ok(apply(doc, { verb: 'nai', args: { action: 'move', measure: 'nai-benefits', r: 9, theta: 20 } }, now));
    expect(nai(drop.doc).sectorId).toBe('household');
    expect(nai(drop.doc).pos!.r).toBeLessThan(4);
    expect(drop.log).toBe('NAI BENEFITS ENROLLMENT MOVED → HOUSEHOLD FAR');
  });
  it('undoes through the inverse patch (round trip)', () => {
    const doc = seedDoc(now);
    const moved = ok(apply(doc, cmd('/nai move BENEFITS to Family near', doc), now, 'alice'));
    const revert: Command = { verb: 'revert', args: { seq: 7, inverse: createInverse(doc, moved.touched) } };
    const back = ok(apply(moved.doc, revert, now, 'alice'));
    expect(back.doc.measures).toEqual(doc.measures);
  });
  it('suggests move, measure names and rings', () => {
    const doc = seedDoc(now);
    expect(suggest('/nai ', 5, doc).items.map(i => i.insert)).toEqual(['add', 'move', 'remove']);
    expect(suggest('/nai move ', 10, doc).items.map(i => i.label)).toEqual(['NAI BENEFITS ENROLLMENT']);
    expect(suggest('/nai move BENEFITS ', 19, doc).items.map(i => i.insert)).toEqual(['to', 'hq', 'near', 'mid', 'far']);
    expect(suggest('/pl ', 4, doc).items.map(i => i.insert)).toEqual(['add', 'date', 'remove']);
  });
});

describe('/pl date', () => {
  it('re-dates a phase line and logs it', () => {
    const doc = seedDoc(now);
    const c = cmd('/pl date LAUNCH 2027-01-15', doc);
    expect(c.args).toMatchObject({ action: 'date', measure: 'pl-launch' });
    const r = ok(apply(doc, c, now));
    const pl = r.doc.measures.find(m => m.id === 'pl-launch')!;
    expect(pl.date).toBe(c.args.date);
    expect(r.log).toBe(`PL LAUNCH DATED ${pl.date!.slice(0, 10)}`);
    expect(parse('/nai date BENEFITS 2027-01-15', doc, { now }).ok).toBe(false);
  });
});

describe('measure ops replay deterministically', () => {
  it('replays add, move, near and re-date from an empty map', () => {
    let doc = emptyDoc();
    const ops: { cmd: Command; at: string; actor: string }[] = [];
    const texts = ['/new friend inf "Response" in Household near as RSP', '/nai add "WATCH" in Work far', '/nai move WATCH to Household mid',
      '/obj add "GOAL" in Household near', '/obj move GOAL near RSP', '/pl add "LAUNCH" 2026-12-24', '/pl date LAUNCH 2027-01-02'];
    for (const [i, t] of texts.entries()) {
      const at = new Date(2026, 10, 9, 12, i).toISOString(), c = cmd(t, doc), actor = i % 2 ? 'bob' : 'alice';
      doc = ok(apply(doc, c, new Date(at), actor)).doc;
      ops.push({ cmd: JSON.parse(JSON.stringify(c)), at, actor });
    }
    const replayed = ops.reduce((d, op) => ok(apply(d, op.cmd, new Date(op.at), op.actor)).doc, emptyDoc());
    expect(replayed).toEqual(doc);
    expect(doc.log.map(l => l.text)).toContain('NAI WATCH MOVED → HOUSEHOLD MID');
  });
});

describe('plain ring words and attack suggestions', () => {
  it('accepts close, deep and aoi as ring aliases and names them in the error', () => {
    const doc = seedDoc(now);
    expect(cmd('/new hostile "Car registration" in Household close', doc).args.ring).toBe('near');
    expect(cmd('/move KNEE deep', doc).args.ring).toBe('mid');
    expect(cmd('/nai move BENEFITS aoi', doc).args.ring).toBe('far');
    const bad = parse('/move KNEE soon', doc, { now });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('near (close)');
  });
  it('lists own units first for the attacker slot', () => {
    const doc = seedDoc(now);
    const first = suggest('/attack ', 8, doc).items.slice(0, 5).map(i => doc.units.find(u => u.id === i.unitId)?.affiliation);
    expect(first.every(a => a === 'friend' || a === 'assumed')).toBe(true);
  });
});
