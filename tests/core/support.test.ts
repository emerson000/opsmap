import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { importJson } from '../../src/core/model/json';
import { forceRatio } from '../../src/core/model/forceRatio';
import { buildScene } from '../../src/lib/map/scene';
import { orderLine } from '../../src/lib/ui/words';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const run = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)).doc; };
const tryRun = (doc: Doc, text: string) => { const p = parse(text, doc, { now }); return p.ok ? p.preview : p.error; };
const support = (doc: Doc, from: string) => doc.orders.find(o => o.type === 'support' && o.from === from);

// In the seed, Q4RPT (Work) is the main attack on ESCALATION (Work); RUN and SLEEP are friendlies in Wellness.
describe('/support between friendlies', () => {
  it('lets a unit in another sector support the engaged unit, with no task force', () => {
    const doc = seedDoc(now);
    expect(tryRun(doc, '/attack RUN ESCALATION support')).toBe('Cross-sector orders require a task force');
    expect(tryRun(doc, '/support RUN Q4RPT')).toBe('RUN (SEC SQD) SUPPORTS Q4RPT (INF COY) (WELLNESS → WORK)');
    const next = run(doc, '/spt RUN Q4RPT');
    expect(support(next, 'run')).toMatchObject({ type: 'support', to: 'q4rpt' });
    expect(next.orders.some(o => o.from === 'run' && o.to === 'escalation')).toBe(false);
    expect(importJson(JSON.stringify(next)).orders).toEqual(next.orders);
  });

  it('refuses hostiles on either end, self-support and mutual support; a new support replaces the old', () => {
    const doc = seedDoc(now);
    expect(tryRun(doc, '/support RUN ESCALATION')).toBe('Support a friendly unit; to act against a threat use /attack');
    expect(tryRun(doc, '/support LEAK Q4RPT')).toBe('Only friendly units can support');
    expect(tryRun(doc, '/support RUN RUN')).toBe('A unit cannot support itself');
    let next = run(doc, '/support RUN Q4RPT');
    expect(tryRun(next, '/support Q4RPT RUN')).toBe('RUN already supports Q4RPT');
    next = run(next, '/support RUN IRSRSP');
    expect(next.orders.filter(o => o.type === 'support' && o.from === 'run').map(o => o.to)).toEqual(['irsrsp']);
  });

  it('survives moves across sectors, counts toward the force ratio, and halts like other orders', () => {
    let doc = run(seedDoc(now), '/support RUN Q4RPT');
    doc = run(doc, '/move RUN to Family near');
    expect(support(doc, 'run')).toBeDefined();
    const before = forceRatio(seedDoc(now), 'escalation');
    const after = forceRatio(doc, 'escalation');
    expect(before && after && after.text !== before.text).toBe(true);
    doc = run(doc, '/halt RUN support');
    expect(support(doc, 'run')).toBeUndefined();
    expect(doc.log.at(-1)?.text).toBe('RUN HALTED: SUPPORT ON Q4RPT CANCELLED');
  });

  it('draws a dashed SPT arrow to the supported unit: Staff always, Commander when selected', () => {
    const doc = run(seedDoc(now), '/support RUN Q4RPT');
    const staff = buildScene(doc, { view: 'staff', now }).orders.find(o => o.kind === 'assist');
    expect(staff).toMatchObject({ fromId: 'run', toId: 'q4rpt', label: { text: 'SPT' } });
    expect(buildScene(doc, { view: 'commander', now }).orders.some(o => o.kind === 'assist')).toBe(false);
    expect(buildScene(doc, { view: 'commander', now, selectedId: 'q4rpt' }).orders.some(o => o.kind === 'assist')).toBe(true);
    const o = support(doc, 'run')!;
    expect(orderLine(doc, o, 'run').text).toBe('Supporting → Q4RPT');
    expect(orderLine(doc, o, 'q4rpt').text).toBe('Supported by ← RUN');
  });

  it('suggests engaged friendlies first', () => {
    const items = suggest('/support RUN ', 13, seedDoc(now)).items.map(i => i.insert);
    // IRSRSP, RECORDS and Q4RPT are attacking in the seed.
    expect(items.slice(0, 3).sort()).toEqual(['IRSRSP', 'Q4RPT', 'RECORDS']);
    expect(items).not.toContain('RUN');
    expect(items).not.toContain('LEAK');
  });
});
