import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const exec = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); const r: ApplyResult = apply(doc, p.cmd, now); if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => exec(doc, text).doc;
const unit = (doc: Doc, d: string) => doc.units.find(u => u.designation === d)!;
// In the seed, task force MOVE holds PACKING and MOVERS; with MOVERS detached, PACKING is its last unit.
const lastOne = () => run(seedDoc(now), '/detach MOVERS');

describe('task forces', () => {
  it('detaching the last attached unit makes the task force a regular unit again', () => {
    const doc = lastOne();
    expect(unit(doc, 'MOVE').taskForce).toBe(true);
    const r = exec(doc, '/detach PACKING');
    expect(unit(r.doc, 'MOVE').taskForce).toBeUndefined();
    expect(r.log).toBe('PACKING DETACHED — TF MOVE DISSOLVED');
  });

  it('its orders across a sector boundary are cancelled and named; orders inside its sector stay', () => {
    // MOVE (Household) attacks ESCALATION (Work) as a task force, and LEAK (Household).
    let doc = run(lastOne(), '/attack MOVE ESCALATION');
    doc = run(doc, '/attack RECORDS LEAK');
    const r = exec(doc, '/detach PACKING');
    expect(r.log).toMatch(/^PACKING DETACHED — TF MOVE DISSOLVED; ATTACK ON ESCALATION/);
    expect(r.doc.orders.some(o => o.from === 'move' && o.to === 'escalation')).toBe(false);
    expect(r.doc.orders.some(o => o.from === 'records' && o.to === 'leak')).toBe(true);
  });

  it('a task force with units left stays one', () => {
    let doc = run(lastOne(), '/attach TOOLS to MOVE');
    expect(exec(doc, '/detach PACKING').log).toBe('PACKING DETACHED');
    doc = run(doc, '/detach PACKING');
    expect(unit(doc, 'MOVE').taskForce).toBe(true);
    expect(exec(doc, '/detach TOOLS').log).toBe('TOOLS DETACHED — TF MOVE DISSOLVED');
  });

  it('moving its last unit to another task force dissolves the old one', () => {
    const r = exec(lastOne(), '/attach PACKING to IRSRSP');
    expect(unit(r.doc, 'MOVE').taskForce).toBeUndefined();
    expect(unit(r.doc, 'IRSRSP').taskForce).toBe(true);
    expect(r.log).toBe('PACKING ATTACHED TO TF IRSRSP — TF MOVE DISSOLVED');
    // Attaching again to the same task force changes nothing about it.
    expect(exec(lastOne(), '/attach PACKING to MOVE').log).toBe('PACKING ATTACHED TO TF MOVE');
  });

  it('reinforcing with the last unit of another task force dissolves that one', () => {
    const r = exec(lastOne(), '/reinforce IRSRSP with PACKING');
    expect(unit(r.doc, 'MOVE').taskForce).toBeUndefined();
    expect(r.log).toBe('IRSRSP REINFORCED (+) — TF MOVE DISSOLVED');
  });

  it('a unit that is not attached cannot be detached', () => {
    expect(parse('/detach TOOLS', seedDoc(now), { now })).toMatchObject({ ok: false, error: 'TOOLS is not attached' });
  });
  it('/reinforce takes the reinforcing unit with or without `with`, including hostiles named T1 and T2', () => {
    let doc = run(seedDoc(now), '/new hostile "Alpha" as T1');
    doc = run(doc, '/new hostile "Bravo" as T2');
    const bare = parse('/reinforce T1 T2', doc, { now }), full = parse('/reinforce T1 with T2', doc, { now });
    expect(bare.ok && full.ok && bare.cmd.args).toEqual(full.ok && full.cmd.args);
    const r = exec(doc, '/reinforce T1 T2');
    expect(r.log).toBe('T1 REINFORCED (+)');
    expect(unit(r.doc, 'T2').parentId).toBe(unit(r.doc, 'T1').id);
    expect(parse('/reinforce T1 "T2"', doc, { now })).toMatchObject({ ok: false });
  });
});
