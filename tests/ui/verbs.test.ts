// Every sidebar command round-trips through the command bar: parse(format(c)) is c, over the seed map.
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/core/commands/grammar';
import { parseDate } from '../../src/core/commands/tokenize';
import { apply } from '../../src/core/commands/apply';
import { seedDoc } from '../../src/core/model/seed';
import type { Command, Doc } from '../../src/core/model/types';
import { VERB_SLOTS, dateText, format, tryFormat, verbCode, type VerbSlot } from '../../src/lib/ui/verbs';

const now = new Date('2026-11-10T15:00:00Z');
const c = (verb: string, args: Record<string, unknown>): Command => ({ verb, args });
const due = (doc: Doc, text: string) => parseDate(text, now, doc.settings.tz);

/** One or more commands per table entry, each in the shape parse() gives (flags parse always sets are present). */
function samples(doc: Doc): Record<string, Command[]> {
  const area = (v: string): Record<string, Command[]> => {
    const m = doc.measures.find(x => x.type === v)!.id;
    return {
      [`${v} add`]: [c(v, { action: 'add', name: 'NEW ONE', sectorId: 'work' }), c(v, { action: 'add', name: 'X', sectorId: 'household', ring: 'far' })],
      [`${v} move`]: [c(v, { action: 'move', measure: m, ring: 'near' }), c(v, { action: 'move', measure: m, sectorId: 'family', ring: 'mid' })],
      [`${v} near`]: [c(v, { action: 'move', measure: m, nearUnit: 'records' })],
      [`${v} join`]: [c(v, { action: 'join', measure: m, units: ['records', 'irsrsp'] })],
      [`${v} leave`]: [c(v, { action: 'leave', measure: m, units: ['records'] })],
      [`${v} size`]: [c(v, { action: 'size', measure: m, size: 'xl' })],
      [`${v} rename`]: [c(v, { action: 'rename', measure: m, name: 'NEW "Q" NAME' })],
      [`${v} remove`]: [c(v, { action: 'remove', measure: m })],
    };
  };
  // A unit in an area for leave, and a pinned unit for unpin.
  return {
    'new': [c('new', { title: 'Fix gutter', sectorId: 'household' }), c('new', { affiliation: 'hostile', echelon: 'sec', fn: 'eng', title: 'Leak, again', sectorId: 'work', ring: 'near', dueAt: due(doc, '2026-11-20'), designation: 'GUTTER', confirm: true }),
      c('new', { fn: 'sec', title: 'Routine', sectorId: 'wellness' })],
    'id': [c('id', { unit: 'tools', affiliation: 'hostile', confirm: false }), c('id', { unit: 'landlord', affiliation: 'hostile', confirm: true })],
    'size': [c('size', { unit: 'tools', echelon: 'coy' })],
    'fn': [c('fn', { unit: 'tools', fn: 'sec', confirm: false })],
    'rename': [c('rename', { unit: 'tools', title: 'Review "new" tool\\x' }), c('rename', { unit: 'tools', title: 'Tool', designation: 'TOOL2' })],
    'move': [c('move', { unit: 'knee', ring: 'near' }), c('move', { unit: 'knee', sectorId: 'work', ring: 'far' })],
    'move near': [c('move', { unit: 'knee', nearUnit: 'sleep' })],
    'attack': [c('attack', { unit: 'irsrsp', target: 'leak', role: 'support', planned: true }), c('attack', { unit: 'records', target: 'obj-settled', role: 'main', planned: false })],
    'moving': [c('moving', { unit: 'records', target: 'hq' }), c('moving', { unit: 'records', target: 'hq:household' }), c('moving', { unit: 'records', target: 'pl-launch' }), c('moving', { unit: 'records', target: 'ea-saturday' }), c('moving', { unit: 'records', target: 'irsrsp' })],
    'axis': [c('axis', { unit: 'records', target: 'obj-settled', via: [] }), c('axis', { unit: 'records', target: 'obj-settled', via: ['pl-launch'] })],
    'advancing': [c('advancing', { unit: 'leak', target: 'hq:household' }), c('advancing', { unit: 'leak', target: 'irsrsp' }), c('advancing', { unit: 'leak', target: 'hq' })],
    'support': [c('support', { unit: 'records', target: 'irsrsp' })],
    'link': [c('link', { unit: 'records', target: 'irsrsp' }), c('link', { unit: 'records', target: 'irsrsp', kind: 'handoff' })],
    'halt': [c('halt', { unit: 'irsrsp' }), c('halt', { unit: 'irsrsp', kind: 'attack' })],
    'bda': [c('bda', { unit: 'leak', strength: 45 }), c('bda', { unit: 'leak', condition: 'damaged' }), c('bda', { unit: 'leak', condition: 'none' })],
    'block': [c('block', { unit: 'records' }), c('block', { unit: 'records', note: 'Waiting on "bank"' })],
    'unblock': [c('unblock', { unit: 'passport' })],
    'unpin': [c('unpin', { unit: 'pinned' })],
    'reopen': [c('reopen', { unit: 'backlog' })],
    'done': [c('done', { unit: 'records' })],
    'drop': [c('drop', { unit: 'records', bypassed: false }), c('drop', { unit: 'leak', bypassed: true })],
    'reinforce': [c('reinforce', { unit: 'records' }), c('reinforce', { unit: 'records', with: 'tools' })],
    'reduce': [c('reduce', { unit: 'records' }), c('reduce', { unit: 'records', note: 'Only 2025' })],
    'attach': [c('attach', { unit: 'records', parent: 'move' })],
    'detach': [c('detach', { unit: 'packing' })],
    'due': [c('due', { unit: 'records', dueAt: due(doc, '2026-12-01') }), c('due', { unit: 'records', dueAt: due(doc, '011230JDEC26') }), c('due', { unit: 'records', dueAt: null })],
    'note': [c('note', { unit: 'records', note: 'Line one\nline "two"' }), c('note', { unit: 'records', note: '' })],
    'rate': [c('rate', { unit: 'records', rating: 'B2' })],
    'key': [c('key', { unit: 'records' })],
    'cp': [c('cp', { unit: 'records', cp: 'tac' }), c('cp', { unit: 'pinned', cp: null })],
    'sidc': [c('sidc', { unit: 'records', sidc: '13031000141211000000' })],
    'find': [c('find', { unit: 'records' }), c('find', { measure: 'obj-settled' }), c('find', { measure: 'pl-launch' }), c('find', { sectorId: 'household' })],
    'sector add': [c('sector', { action: 'add', name: 'Side gig' })],
    'sector rename': [c('sector', { action: 'rename', sectorId: 'work', name: 'Day job' })],
    'sector remove': [c('sector', { action: 'remove', sectorId: 'productivity', reassign: 'work' }), c('sector', { action: 'remove', sectorId: 'empty' })],
    'sector width': [c('sector', { action: 'width', sectorId: 'work', degrees: 90 })],
    'sector size': [c('sector', { action: 'size', size: 'large' })],
    'pl add': [c('pl', { action: 'add', name: 'GO LIVE', date: due(doc, '2026-12-24') })],
    'pl date': [c('pl', { action: 'date', measure: 'pl-launch', date: due(doc, '2027-01-08') })],
    'pl rename': [c('pl', { action: 'rename', measure: 'pl-launch', name: 'LIFTOFF' })],
    'pl remove': [c('pl', { action: 'remove', measure: 'pl-launch' })],
    ...area('obj'), ...area('ea'), ...area('nai'),
    'intent': [c('intent', { text: 'Finish "the" taxes' })],
    'sitrep': [c('sitrep', { copy: false }), c('sitrep', { copy: true })],
    'vk bind': [c('vk', { action: 'bind', name: 'Life' })], 'vk unbind': [c('vk', { action: 'unbind' })], 'vk sync': [c('vk', { action: 'sync' })], 'vk status': [c('vk', { action: 'status' })],
  };
}
const key = (e: VerbSlot) => (e.form ? `${e.verb} ${e.form}` : e.verb);

/** The seed plus what some samples need: a pinned unit with a CP, an empty sector, empty areas, a Vikunja binding and a tz. */
function fixture(tz?: string): Doc {
  const doc = seedDoc(now);
  if (tz) doc.settings.tz = tz;
  doc.settings.vikunja = { project: 1, title: 'Life' };
  doc.units.push({ ...doc.units.find(u => u.id === 'knee')!, id: 'pinned', designation: 'PINNED', title: 'Pinned one', posOverride: true, cp: 'main' });
  doc.sectors.push({ id: 'empty', name: 'Empty one', startDeg: 0, widthDeg: 1 });
  for (const m of doc.measures) if (m.type !== 'pl') m.members = [];
  return doc;
}
/** Each sample runs on a doc where it is valid: leave needs members. */
function docFor(base: Doc, cmd: Command): Doc {
  const doc = structuredClone(base);
  if (cmd.args.action === 'leave') doc.measures.find(m => m.id === cmd.args.measure)!.members = ['records'];
  return doc;
}

describe.each([undefined, 'America/New_York'])('parse(format(c)) is c (tz %s)', tz => {
  const base = fixture(tz), all = samples(base);
  it('has samples for every table entry', () => {
    for (const e of VERB_SLOTS) expect(Object.hasOwn(all, key(e)), key(e)).toBe(true);
  });
  for (const [name, cmds] of Object.entries(all)) for (const cmd of cmds) {
    it(`${name}: ${JSON.stringify(cmd.args)}`, () => {
      const doc = docFor(base, cmd), text = format(cmd, doc);
      expect(text.startsWith(`/${cmd.verb} `) || text === `/${cmd.verb}`, text).toBe(true);
      const parsed = parse(text, doc, { now, vikunja: true });
      if (!parsed.ok) throw new Error(`${text}: ${parsed.error}`);
      // /moving onto a hostile becomes an attack; everything else keeps its verb.
      expect(parsed.cmd.verb, text).toBe(cmd.verb);
      expect(parsed.cmd.args, text).toEqual(cmd.args);
      if (cmd.verb !== 'vk') expect('error' in apply(doc, parsed.cmd, now), text).toBe(false);
    });
  }
});

describe('format', () => {
  const doc = fixture();
  it('names everything in full, independent of the selection', () => {
    expect(format(c('attack', { unit: 'records', target: 'obj-settled', role: 'main', planned: false }), doc)).toBe('/attack RECORDS OBJ "SETTLED IN" main');
    expect(format(c('moving', { unit: 'records', target: 'hq:household' }), doc)).toBe('/moving RECORDS to Household hq');
    expect(format(c('axis', { unit: 'move', target: 'obj-settled', via: ['pl-launch'] }), doc)).toBe('/axis MOVE to OBJ "SETTLED IN" via PL LAUNCH');
    expect(format(c('obj', { action: 'move', measure: 'obj-settled', sectorId: 'household', ring: 'mid' }), doc)).toBe('/obj move "SETTLED IN" to Household mid');
    expect(format(c('new', { fn: 'sec', title: 'Routine', sectorId: 'empty' }), doc)).toBe('/new security "Routine" in "Empty one"');
    expect(format(c('sector', { action: 'remove', sectorId: 'empty' }), doc)).toBe('/sector remove "Empty one"');
  });
  it('writes a date the parser reads back exactly', () => {
    expect(dateText('2026-12-01T17:00:00.000Z')).toBe('2026-12-01');
    expect(dateText('2026-12-01T12:30:00.000Z')).toBe('011230JDEC26');
    expect(dateText('2026-12-01T22:00:00.000Z', 'America/New_York')).toBe('2026-12-01');
  });
  it('names one order by kind, and has no text for a drag position or an order among several of its kind', () => {
    expect(format(c('halt', { unit: 'irsrsp', order: 'o-tax-main' }), doc)).toBe('/halt IRSRSP attack');
    const two = structuredClone(doc);
    two.orders.push({ id: 'l1', type: 'link', from: 'records', to: 'irsrsp', createdAt: '' }, { id: 'l2', type: 'link', from: 'records', to: 'knee', createdAt: '' });
    expect(tryFormat(c('halt', { unit: 'records', order: 'l1' }), two)).toBeNull();
    expect(tryFormat(c('move', { unit: 'records', r: 1, theta: 2 }), doc)).toBeNull();
  });
  it('gives each entry a short code', () => {
    expect(verbCode({ verb: 'obj', form: 'rename' })).toBe('/obj rename');
    expect(verbCode({ verb: 'move', form: 'near' })).toBe('/move … near');
    expect(verbCode({ verb: 'size' })).toBe('/size');
  });
});
