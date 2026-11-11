// The order composer builds command-bar text: every target it offers parses, names the same object, and reads back
// as the text format() would write for the parsed Command. Its targets are ranked as the command bar suggests them.
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { ORDER_VERBS, draftSlots, draftText, optionFor, optionForSel, orderingUnits, targetOptions, type OrderVerb } from '../../src/lib/ui/compose';
import { enabledFor, format, slotFor } from '../../src/lib/ui/verbs';

const now = new Date('2026-11-10T15:00:00Z');
const doc = seedDoc(now);
const unit = (id: string) => doc.units.find(u => u.id === id)!;
/** A subject the verb applies to: a friendly for most, a threat for advancing. */
const SUBJECT: Record<OrderVerb, string> = { attack: 'records', moving: 'records', axis: 'records', support: 'records', link: 'records', advancing: 'leak' };

describe('composer targets', () => {
  it.each(ORDER_VERBS)('/%s: every offered target parses to that object, and format() writes the same text back', verb => {
    const u = unit(SUBJECT[verb]);
    const options = targetOptions(verb, u, doc);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some(o => !o.why)).toBe(true);
    for (const o of options) {
      const text = draftText({ verb, unit: u, target: o.text }, doc);
      const res = parse(text, doc, { now });
      // A target the parser refuses (another sector, no hostile near) carries its reason and is listed last.
      if (!res.ok) { expect(o.why, text).toBe(res.error); continue; }
      expect(o.why, text).toBeUndefined();
      const target = res.cmd.args.target;
      if (o.sel?.kind === 'unit' || o.sel?.kind === 'measure') expect(target, text).toBe(o.sel.id);
      if (o.sel?.kind === 'sector') expect(target, text).toBe(`hq:${o.sel.id}`);
      if (o.key === 'hq') expect(target).toBe('hq');
      // The sidebar's own text for that Command (format) gives the same Command: one language, two writers.
      const again = parse(format(res.cmd, doc), doc, { now });
      if (!again.ok) throw new Error(`${format(res.cmd, doc)}: ${again.error}`);
      // (/moving onto a hostile parses as an attack, whose text also says planned or not: compare the order itself.)
      if (res.cmd.verb === verb) expect(again.cmd.args, text).toEqual(res.cmd.args);
      else expect([again.cmd.verb, again.cmd.args.unit, again.cmd.args.target, again.cmd.args.role], text).toEqual([res.cmd.verb, res.cmd.args.unit, res.cmd.args.target, res.cmd.args.role]);
    }
  });
  it('ranks targets as the command bar does', () => {
    const u = unit('records');
    const options = targetOptions('attack', u, doc);
    const valid = new Set(options.filter(o => !o.why).map(o => o.label));
    const bar = suggest('/attack RECORDS ', 16, doc).items.filter(s => s.kind === 'unit').map(s => s.label);
    expect(options.filter(o => o.sel?.kind === 'unit' && !o.why).map(o => o.label)).toEqual(bar.filter(l => valid.has(l)));
    // Then the targets it cannot take, with the reason.
    expect(options.findIndex(o => o.why)).toBeGreaterThan(options.map(o => !o.why).lastIndexOf(true));
    expect(options.find(o => o.label === 'ESCALATION')?.why).toBe('Cross-sector orders require a task force');
    // Recent units lead, as in the bar.
    expect(targetOptions('link', u, doc, ['irsrsp'])[0].label).toBe('IRSRSP');
    // Attack offers objectives; moving offers any area or phase line, HQ, sector HQs and the nearest hostile.
    expect(targetOptions('attack', u, doc).map(o => o.label)).toContain('OBJ SETTLED IN');
    const moving = targetOptions('moving', u, doc).map(o => o.key);
    for (const k of ['hq', 'sector hq', 'nearest hostile', 's:work', 'm:pl-launch', 'm:ea-saturday', 'u:irsrsp']) expect(moving).toContain(k);
    expect(targetOptions('axis', u, doc).every(o => o.key.startsWith('m:obj'))).toBe(true);
    expect(targetOptions('advancing', unit('leak'), doc)[0].key).toBe('hq');
    expect(moving).not.toContain('u:records');
  });
  it('finds the option for a target id or a map pick', () => {
    const options = targetOptions('moving', unit('records'), doc);
    expect(optionFor('hq', options)?.key).toBe('hq');
    expect(optionFor('hq:family', options)?.label).toBe('Family HQ');
    expect(optionFor('obj-settled', options)?.text).toBe('OBJ "SETTLED IN"');
    expect(optionFor('leak', options)?.text).toBe('LEAK');
    expect(optionForSel({ kind: 'sector', id: 'work' }, options)?.text).toBe('Work hq');
    expect(optionForSel({ kind: 'measure', id: 'nope' }, options)).toBeUndefined();
  });
});

describe('orders started at the target end', () => {
  it('offers open friendlies ranked as the bar suggests the unit; the ones the order refuses come last with the reason', () => {
    const options = orderingUnits('attack', doc, [], 'OBJ "SETTLED IN"');
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      const u = doc.units.find(x => `u:${x.id}` === o.key)!;
      expect(['friend', 'assumed'], o.label).toContain(u.affiliation);
      const res = parse(draftText({ verb: 'attack', unit: u, target: 'OBJ "SETTLED IN"' }, doc), doc, { now });
      if (res.ok) expect(o.why, o.label).toBeUndefined(); else expect(o.why, o.label).toBe(res.error);
    }
    expect(options.findIndex(o => o.why)).not.toBe(0);
    const valid = options.filter(o => !o.why).map(o => o.label);
    const bar = suggest('/attack ', 8, doc).items.filter(s => s.kind === 'unit').map(s => s.label).filter(l => valid.includes(l));
    expect(valid.slice(0, bar.length)).toEqual(bar);
    expect(orderingUnits('axis', doc, ['irsrsp'])[0].label).toBe('IRSRSP');
    expect(orderingUnits('axis', doc).some(o => o.label === 'LEAK')).toBe(false);
  });
});

describe('composer text', () => {
  const u = unit('records');
  it('fills slots in command order; empty ones show the SYNTAX placeholder', () => {
    const slots = draftSlots({ verb: 'attack', unit: u, target: '' }, doc);
    expect(slots.map(s => s.text).join(' ')).toBe('/attack RECORDS ‹target› [main|support] [planned]');
    expect(slots.filter(s => s.filled).map(s => s.key)).toEqual(['verb', 'unit']);
    expect(slotFor('attack', undefined, 'unit')!.slots).toEqual(['‹unit›', '‹target›', '[main|support]', '[planned]']);
  });
  it('writes each option where the bar expects it', () => {
    expect(draftText({ verb: 'attack', unit: u, target: 'LEAK', role: 'support', planned: true }, doc)).toBe('/attack RECORDS LEAK support planned');
    expect(draftText({ verb: 'moving', unit: u, target: 'nearest hostile' }, doc)).toBe('/moving RECORDS to nearest hostile');
    expect(draftText({ verb: 'axis', unit: u, target: 'OBJ "SETTLED IN"', via: ['pl-launch'] }, doc)).toBe('/axis RECORDS to OBJ "SETTLED IN" via PL LAUNCH');
    expect(draftText({ verb: 'link', unit: u, target: 'IRSRSP', kind: 'dependency' }, doc)).toBe('/link RECORDS IRSRSP as dependency');
    expect(draftText({ verb: 'advancing', unit: unit('leak'), target: 'sector hq' }, doc)).toBe('/advancing LEAK on sector hq');
    expect(draftText({ verb: 'support', unit: u, target: '' }, doc)).toBe('/support RECORDS');
  });
  it('strikes the verbs that do not apply, with the reason', () => {
    const why = (verb: OrderVerb, id: string) => enabledFor(slotFor(verb, undefined, 'unit')!, { kind: 'unit', unit: unit(id) }, doc);
    expect(why('advancing', 'records')).toBe('Only a hostile or suspect advances');
    expect(why('attack', 'leak')).toBe('Only a friendly attacks');
    expect(why('moving', 'backlog')).toMatch(/reopen it first/);
    expect(why('attack', 'records')).toBe(true);
  });
});
