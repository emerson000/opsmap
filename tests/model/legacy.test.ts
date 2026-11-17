// Legacy /vk ops in the journal keep replaying through apply() (they were recorded with numeric Vikunja ids) and give
// the neutral document: settings.taskSync and string remote ids. The log lines are the ones these ops gave before
// the change, recorded from the old code.
import { describe, expect, it } from 'vitest';
import { apply } from '../../src/core/commands/apply';
import { importJson } from '../../src/core/model/json';
import { legacyCommand } from '../../src/core/model/legacy';
import { seedDoc } from '../../src/core/model/seed';
import type { Command, Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const step = (doc: Doc, cmd: Command) => { const r = apply(doc, cmd, now); if ('error' in r) throw new Error(r.error); return r; };
const remotes = (doc: Doc) => Object.fromEntries(doc.units.filter(u => u.remote !== undefined).map(u => [u.id, u.remote]));

describe('replaying recorded /vk ops', () => {
  it('gives the neutral binding, string ids and the same log lines', () => {
    let doc = seedDoc(now);
    const [a, b] = doc.units;
    const logs: string[] = [];
    const run = (cmd: Command) => { const r = step(doc, cmd); doc = r.doc; logs.push(r.log); return doc; };
    run({ verb: 'vk', args: { action: 'bound', project: 39, title: 'Main', by: 'u1', sectors: { work: 40, household: 41 } } });
    expect(doc.settings.taskSync).toEqual({ provider: 'vikunja', label: 'Vikunja', root: '39', title: 'Main', by: 'u1' });
    expect(doc.settings).not.toHaveProperty('vikunja');
    run({ verb: 'vk', args: { action: 'sectors', sectors: { family: 42, wellness: 43, productivity: 44 } } });
    expect(doc.sectors.map(s => s.remote)).toEqual(['40', '41', '42', '43', '44']);
    run({ verb: 'vk', args: { action: 'links', links: { [a.id]: 501, [b.id]: 502 } } });
    expect(remotes(doc)).toEqual({ [a.id]: '501', [b.id]: '502' });
    run({ verb: 'vk', args: { action: 'add', task: 601, title: 'Fix the roof', sectorId: 'work', dueAt: '2026-11-20', note: 'Ladder', status: 'active' } });
    run({ verb: 'vk', args: { action: 'add', task: 602, title: 'Buy gutters', sectorId: 'work' } });
    const fix = doc.units.find(u => u.remote === '601')!, gutters = doc.units.find(u => u.remote === '602')!;
    run({ verb: 'vk', args: { action: 'pull', unit: gutters.id, changes: { title: 'Buy new gutters', status: 'blocked', dueAt: '2026-11-21', parentId: fix.id } } });
    run({ verb: 'vk', args: { action: 'relate', unit: fix.id, target: gutters.id, kind: 'handoff' } });
    run({ verb: 'vk', args: { action: 'unrelate', order: doc.orders.find(o => o.type === 'link')!.id } });
    run({ verb: 'vk', args: { action: 'gone', unit: fix.id } });
    expect(remotes(doc)).toEqual({ [a.id]: '501', [b.id]: '502', [gutters.id]: '602' });
    expect(JSON.stringify(doc)).not.toMatch(/"vk":|"vikunja":/);
    expect(importJson(JSON.stringify(doc))).toEqual(doc);
    run({ verb: 'vk', args: { action: 'unbind' }, raw: '/vk unbind' });
    expect(doc.settings.taskSync).toBeUndefined();
    expect(doc.sectors.some(s => s.remote !== undefined) || doc.units.some(u => u.remote !== undefined)).toBe(false);
    expect(logs).toEqual([
      'VIKUNJA BOUND TO MAIN',
      'VIKUNJA SECTORS FAMILY, WELLNESS, PRODUCTIVITY',
      'VIKUNJA LINKED 2 UNITS',
      'VIKUNJA NEW FIXTHERO — PENDING INFANTRY SECTION IN WORK; FIXTHERO ACTIVE',
      'VIKUNJA NEW BUYGUTTE — PENDING INFANTRY SECTION IN WORK',
      'VIKUNJA: BUYGUTTE RENAMED Buy new gutters; BUYGUTTE DUE 2026-11-21; BUYGUTTE BLOCKED; BUYGUTTE ATTACHED TO TF FIXTHERO',
      'VIKUNJA: LINKUP FIXTHERO / BUYGUTTE — HANDOFF',
      'VIKUNJA: FIXTHERO HALTED: LINK ON BUYGUTTE CANCELLED',
      'VIKUNJA: FIXTHERO TASK DELETED — FIXTHERO WITHDRAWN',
      'VIKUNJA UNBOUND FROM MAIN',
    ]);
    expect(doc.log.at(-1)).toMatchObject({ text: 'VIKUNJA UNBOUND FROM MAIN', cmd: '/vk unbind' });
  });
  it('translates each legacy action to the neutral one', () => {
    expect(legacyCommand({ verb: 'vk', args: { action: 'bound', project: 39, title: 'Main', sectors: { work: 40 } } })).toEqual({ verb: 'tasks', args: { action: 'bound', provider: 'vikunja', label: 'Vikunja', root: '39', title: 'Main', containers: { work: '40' } } });
    expect(legacyCommand({ verb: 'vk', args: { action: 'sectors', sectors: { work: 40, home: null } } })).toEqual({ verb: 'tasks', args: { action: 'containers', containers: { work: '40', home: null } } });
    expect(legacyCommand({ verb: 'vk', args: { action: 'add', task: 7, title: 'X', sectorId: 'work' }, raw: '/x' })).toEqual({ verb: 'tasks', args: { action: 'add', task: '7', title: 'X', sectorId: 'work' }, raw: '/x' });
    expect(legacyCommand({ verb: 'vk', args: { action: 'pull', unit: 'u1', changes: { title: 'T' } } })).toEqual({ verb: 'tasks', args: { action: 'pull', unit: 'u1', changes: { title: 'T' } } });
    expect(legacyCommand({ verb: 'new', args: { title: 'X' } })).toEqual({ verb: 'new', args: { title: 'X' } });
  });
  it('restores before-images recorded with the old fields in the neutral shape (undo, replayed reverts)', () => {
    let doc = step(seedDoc(now), { verb: 'vk', args: { action: 'bound', project: 39, title: 'Main', sectors: { work: 40 } } }).doc;
    doc = step(doc, { verb: 'vk', args: { action: 'links', links: { [doc.units[0].id]: 501 } } }).doc;
    const { remote: _r, ...unit } = doc.units[0], { remote: _s, ...sector } = doc.sectors[0];
    const renamed = step(doc, { verb: 'rename', args: { unit: unit.id, title: 'Renamed' } }).doc;
    const inverse = { units: [{ id: unit.id, index: 0, value: { ...unit, vk: 501 } }], orders: [], measures: [], sectors: [{ id: sector.id, index: 0, value: { ...sector, vk: 40 } }], top: { settings: { ...doc.settings, taskSync: undefined, vikunja: { project: 39, title: 'Main' } } } };
    const reverted = step(renamed, { verb: 'revert', args: { seq: 3, inverse } }).doc;
    expect(reverted.units[0]).toMatchObject({ title: doc.units[0].title, remote: '501' });expect(reverted.units[0]).not.toHaveProperty('vk');
    expect(reverted.sectors[0]).toMatchObject({ remote: '40' });
    expect(reverted.settings.taskSync).toEqual({ provider: 'vikunja', label: 'Vikunja', root: '39', title: 'Main' });expect(reverted.settings).not.toHaveProperty('vikunja');
  });
  it('refuses a malformed legacy id as before', () => {
    expect(apply(seedDoc(now), { verb: 'vk', args: { action: 'bound', project: 0, title: 'Main' } }, now)).toMatchObject({ error: expect.stringMatching(/^Invalid/) });
    expect(apply(seedDoc(now), { verb: 'vk', args: { action: 'bound', project: 1.5, title: 'Main' } }, now)).toMatchObject({ error: expect.stringMatching(/^Invalid/) });
  });
});

describe('importJson and legacy fields', () => {
  it('drops settings.vikunja and the vk ids', () => {
    const doc = seedDoc(now) as unknown as { settings: Record<string, unknown>; sectors: Record<string, unknown>[]; units: Record<string, unknown>[] };
    doc.settings.vikunja = { project: 39, title: 'Main', by: 'u1' };doc.sectors[0].vk = 40;doc.units[0].vk = 501;
    const imported = importJson(JSON.stringify(doc));
    expect(imported.settings).not.toHaveProperty('vikunja');expect(imported.sectors[0]).not.toHaveProperty('vk');expect(imported.units[0]).not.toHaveProperty('vk');
    expect(imported.settings.taskSync).toBeUndefined();expect(imported.sectors[0].remote).toBeUndefined();expect(imported.units[0].remote).toBeUndefined();
  });
  it('validates the neutral fields', () => {
    const doc = seedDoc(now);
    doc.settings.taskSync = { provider: 'asana', label: 'Asana', root: '1207', title: 'Ops' };doc.sectors[0].remote = 'S1';doc.units[0].remote = '99';
    expect(importJson(JSON.stringify(doc))).toEqual(doc);
    expect(() => importJson(JSON.stringify({ ...doc, units: doc.units.map((u, i) => i ? u : { ...u, remote: 'a b' }) }))).toThrow('Invalid document: remote');
    expect(() => importJson(JSON.stringify({ ...doc, settings: { ...doc.settings, taskSync: { provider: 'asana', root: '1' } } }))).toThrow('Invalid document: taskSync');
  });
});
