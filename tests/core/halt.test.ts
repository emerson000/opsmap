import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)).doc; };
const tryRun = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); return p.ok ? 'ok' : p.error; };

describe('/halt', () => {
  it('clears an advance and logs what was cancelled', () => {
    let doc = run(seedDoc(now), '/advancing LEAK on sector hq');
    doc = run(doc, '/halt LEAK');
    expect(doc.orders.some(o => o.from === 'leak')).toBe(false);
    expect(doc.log.at(-1)?.text).toBe('LEAK HALTED: ADVANCE ON HOUSEHOLD HQ CANCELLED');
    expect(tryRun(doc, '/halt LEAK')).toBe('LEAK has no orders');
  });

  it('clears only one kind when named, accepting advancing/moving and the stop alias', () => {
    const seeded = seedDoc(now);
    // ESCALATION advances on HQ in the seed; Q4RPT attacks it.
    expect(tryRun(seeded, '/halt ESCALATION attack')).toBe('ESCALATION has no attack order');
    const doc = run(seeded, '/stop ESCALATION advancing');
    expect(doc.orders.some(o => o.from === 'escalation')).toBe(false);
    expect(doc.orders.some(o => o.from === 'q4rpt' && o.to === 'escalation')).toBe(true);
    expect(tryRun(seeded, '/halt ESCALATION retreat')).toBe('Expected advance, move, attack, axis or link');
    expect(suggest('/halt MOVE ', 11, seeded).items.map(i => i.insert)).toEqual(['axis']);
  });

  it('cancels one order by id (the inspector button)', () => {
    const doc = seedDoc(now);
    const order = doc.orders.find(o => o.id === 'o-tax-support')!;
    const next = ok(apply(doc, { verb: 'halt', args: { unit: order.from, order: order.id } }, now)).doc;
    expect(next.orders.map(o => o.id)).not.toContain('o-tax-support');
    expect(next.orders).toHaveLength(doc.orders.length - 1);
    expect(next.log.at(-1)?.text).toBe('RECORDS HALTED: ATTACK ON IRS CANCELLED');
  });
});

describe('task forces across sectors', () => {
  it('only a task force (a unit with units attached) may attack into another sector', () => {
    let doc = seedDoc(now);
    expect(tryRun(doc, '/attack IRSRSP ESCALATION')).toBe('Cross-sector orders require a task force');
    doc = run(doc, '/attach RECORDS to IRSRSP');
    expect(doc.units.find(u => u.id === 'irsrsp')!.taskForce).toBe(true);
    doc = run(doc, '/attack IRSRSP ESCALATION support');
    expect(doc.orders.find(o => o.from === 'irsrsp' && o.to === 'escalation')).toMatchObject({ type: 'attack' });
    // The attached unit itself is not a task force.
    expect(tryRun(doc, '/attack RECORDS ESCALATION')).toBe('Cross-sector orders require a task force');
  });
});
