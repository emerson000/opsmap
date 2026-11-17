// /tasks: the provider-neutral task sync verb. Providers come from the server (ParseContext.providers); each brings
// its aliases (/vk, /asana). The document holds settings.taskSync and opaque string remote ids.
import { describe, expect, it } from 'vitest';
import { apply, type ApplyResult } from '../../src/core/commands/apply';
import { parse, SYNTAX, type ProviderInfo } from '../../src/core/commands/grammar';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { SYNC_FIELDS, type Command, type Doc } from '../../src/core/model/types';
import { exportJson, importJson } from '../../src/core/model/json';

const now = new Date('2026-11-09T17:00:00Z');
const vikunja: ProviderInfo = { id: 'vikunja', label: 'Vikunja', aliases: ['vk'], rootNoun: 'project' };
const asana: ProviderInfo = { id: 'asana', label: 'Asana', aliases: ['asana'], rootNoun: 'project' };
const both = [vikunja, asana];
const ok = (r: ApplyResult) => { if ('error' in r) throw new Error(r.error); return r; };
const tasks = (doc: Doc, args: Record<string, unknown>) => apply(doc, { verb: 'tasks', args }, now);
const bound = (provider = 'asana', label = 'Asana', title = 'Ops') => ok(tasks(seedDoc(now), { action: 'bound', provider, label, root: '1207', title, by: 'u1', containers: { work: 'S1', household: 'S2' } })).doc;

describe('/tasks in the grammar', () => {
  it('names the provider in /tasks bind', () => {
    expect(parse('/tasks bind asana "Ops"', seedDoc(now), { now, providers: both })).toMatchObject({ ok: true, cmd: { verb: 'tasks', args: { action: 'bind', provider: 'asana', name: 'Ops' } } });
  });
  it('takes the provider from an alias used as the verb', () => {
    expect(parse('/vk bind "Ops"', seedDoc(now), { now, providers: both })).toMatchObject({ ok: true, cmd: { verb: 'tasks', args: { action: 'bind', provider: 'vikunja', name: 'Ops' } } });
    const doc = bound();
    const sync = parse('/asana sync', doc, { now, providers: both });
    expect(sync).toMatchObject({ ok: true, cmd: { verb: 'tasks' } });
    if (sync.ok) expect(sync.cmd.args).toEqual({ action: 'sync' });
  });
  it('picks the only configured provider', () => {
    expect(parse('/tasks bind "Ops"', seedDoc(now), { now, providers: [asana] })).toMatchObject({ ok: true, cmd: { args: { action: 'bind', provider: 'asana', name: 'Ops' } }, preview: 'ASANA BIND OPS' });
  });
  it('asks which provider when several are configured', () => {
    expect(parse('/tasks bind "Ops"', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'Name the task service: /tasks bind ‹vikunja|asana› "‹project›"' });
  });
  it('refuses /tasks without a configured provider', () => {
    expect(parse('/tasks status', seedDoc(now), { now })).toMatchObject({ ok: false, error: 'No task service is configured on this server' });
    expect(parse('/tasks bind "Ops"', seedDoc(now), { now, providers: [] })).toMatchObject({ ok: false, error: 'No task service is configured on this server' });
  });
  it('gives the generic hints', () => {
    expect(parse('/tasks sync', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'This map is not bound to a task service: /tasks bind "‹project›"' });
    expect(parse('/tasks bind vikunja "Other"', bound('vikunja', 'Vikunja'), { now, providers: both })).toMatchObject({ ok: false, error: 'Bound to Vikunja project Ops: /tasks unbind first' });
    expect(parse('/vk status', bound('vikunja', 'Vikunja'), { now, providers: both })).toMatchObject({ ok: true, preview: 'VIKUNJA STATUS' });
  });
  it('refuses an alias of another service than the one the map is bound to', () => {
    const doc = bound('vikunja', 'Vikunja');
    for (const text of ['/asana unbind', '/asana sync', '/asana status', '/asana bind "Ops"'])
      expect(parse(text, doc, { now, providers: both }), text).toMatchObject({ ok: false, error: 'Bound to Vikunja project Ops: /tasks unbind first' });
    expect(parse('/vk unbind', doc, { now, providers: both })).toMatchObject({ ok: true, preview: 'VIKUNJA UNBOUND FROM OPS' });
    expect(parse('/tasks unbind', doc, { now, providers: both })).toMatchObject({ ok: true });
    // Unbound, an alias only picks the service to bind.
    expect(parse('/asana status', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'This map is not bound to a task service: /tasks bind "‹project›"' });
  });
  it('resolves provider aliases in /help', () => {
    expect(parse('/help vk', seedDoc(now), { now, providers: both })).toMatchObject({ ok: true, cmd: { verb: 'help', args: { verb: 'tasks' } }, preview: `/tasks ${SYNTAX.tasks}` });
    expect(parse('/help /asana', seedDoc(now), { now, providers: both })).toMatchObject({ ok: true, cmd: { args: { verb: 'tasks' } } });
    expect(parse('/help vk', seedDoc(now), { now })).toMatchObject({ ok: false, error: 'Unknown command: vk' });
  });
  it('parses /tasks unbind as an ordinary command', () => {
    expect(parse('/tasks unbind', bound(), { now, providers: both })).toMatchObject({ ok: true, cmd: { verb: 'tasks', args: { action: 'unbind' } }, preview: 'ASANA UNBOUND FROM OPS' });
  });
});

describe('/tasks in apply', () => {
  it('records the binding and the sector containers', () => {
    const r = ok(tasks(seedDoc(now), { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops', by: 'u1', containers: { work: 'S1' } }));
    expect(r.log).toBe('ASANA BOUND TO OPS');
    expect(r.doc.settings.taskSync).toEqual({ provider: 'asana', label: 'Asana', root: '1207', title: 'Ops', by: 'u1' });
    expect(r.doc.sectors.find(s => s.id === 'work')?.remote).toBe('S1');
  });
  it('rejects ids that are not plain strings', () => {
    expect(tasks(seedDoc(now), { action: 'bound', provider: 'asana', label: 'Asana', root: 'a/b', title: 'Ops' })).toMatchObject({ error: expect.stringMatching(/^Invalid/) });
    expect(tasks(bound(), { action: 'add', task: 12, title: 'X', sectorId: 'work' })).toMatchObject({ error: expect.stringMatching(/^Invalid/) });
  });
  it('adds, pulls, links and marks gone tasks with string ids', () => {
    let doc = bound();
    const add = ok(tasks(doc, { action: 'add', task: 'T1', title: 'Fix roof', sectorId: 'work', status: 'active' }));
    doc = add.doc;
    const fix = doc.units.find(u => u.remote === 'T1')!;expect(fix.lifecycle).toBe('active');
    expect(add.log).toMatch(new RegExp(`^ASANA NEW ${fix.designation}\\b.*; ${fix.designation} ACTIVE$`));
    expect(tasks(doc, { action: 'add', task: 'T1', title: 'Again', sectorId: 'work' })).toEqual({ error: 'That Asana task is already linked' });
    doc = ok(tasks(doc, { action: 'add', task: 'T2', title: 'Gutter', sectorId: 'work' })).doc;
    const gutter = doc.units.find(u => u.remote === 'T2')!;
    const tf = ok(apply(doc, { verb: 'reinforce', args: { unit: fix.id } }, now)).doc;
    const pulled = ok(tasks(tf, { action: 'pull', unit: gutter.id, changes: { title: 'Gutters', parentId: fix.id } }));
    expect(pulled.log).toMatch(new RegExp(`^ASANA: .*ATTACHED TO TF ${fix.designation}`));
    expect(pulled.doc.units.find(u => u.id === gutter.id)?.parentId).toBe(fix.id);
    const links = ok(tasks(pulled.doc, { action: 'links', links: { [gutter.id]: null } }));
    expect(links.log).toBe('ASANA LINKED 1 UNIT');expect(links.doc.units.find(u => u.id === gutter.id)?.remote).toBeUndefined();
    expect(tasks(pulled.doc, { action: 'links', links: { [gutter.id]: 'T1' } })).toMatchObject({ error: 'An Asana task links to one unit' });
    const gone = ok(tasks(pulled.doc, { action: 'gone', unit: fix.id }));
    expect(gone.log).toMatch(new RegExp(`^ASANA: ${fix.designation} TASK DELETED`));
    expect(gone.doc.units.find(u => u.id === fix.id)).toMatchObject({ lifecycle: 'dropped' });
    expect(gone.doc.units.find(u => u.id === fix.id)?.remote).toBeUndefined();
    const containers = ok(tasks(doc, { action: 'containers', containers: { work: 'S9', household: null } }));
    expect(containers.log).toBe('ASANA SECTORS WORK, HOUSEHOLD');
    expect(containers.doc.sectors.find(s => s.id === 'work')?.remote).toBe('S9');expect(containers.doc.sectors.find(s => s.id === 'household')?.remote).toBeUndefined();
  });
  it('allows one binding per map', () => {
    expect(tasks(bound('vikunja', 'Vikunja'), { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops' })).toEqual({ error: 'Bound to Vikunja project Ops: /tasks unbind first' });
    expect(tasks(bound('vikunja', 'Vikunja'), { action: 'bound', provider: 'vikunja', label: 'Vikunja', root: '1207', title: 'Ops', containers: { family: 'S3' } })).not.toHaveProperty('error');
  });
  it('unbinds and clears every remote id', () => {
    const doc = ok(tasks(bound(), { action: 'add', task: 'T1', title: 'Fix roof', sectorId: 'work' })).doc;
    const r = ok(tasks(doc, { action: 'unbind' }));
    expect(r.log).toBe('ASANA UNBOUND FROM OPS');
    expect(r.doc.settings.taskSync).toBeUndefined();
    expect(r.doc.sectors.some(s => s.remote !== undefined) || r.doc.units.some(u => u.remote !== undefined)).toBe(false);
    expect(tasks(seedDoc(now), { action: 'unbind' })).toEqual({ error: 'This map is not bound to a task service: /tasks bind "‹project›"' });
  });
  it('leaves requests to the server', () => {
    expect(tasks(bound(), { action: 'sync' } as Command['args'])).toEqual({ error: '/tasks sync runs on the server' });
  });
});

describe('/tasks autocomplete', () => {
  it('offers the actions and the provider ids', () => {
    const doc = seedDoc(now);
    expect(suggest('/tasks ', 7, doc, { providers: both }).items.map(s => s.insert)).toEqual(['bind', 'unbind', 'sync', 'status', 'field']);
    expect(suggest('/tasks bind ', 12, doc, { providers: both }).items.map(s => s.insert)).toEqual(['vikunja', 'asana']);
    expect(suggest('/', 1, doc, {}).items.map(s => s.insert)).not.toContain('tasks');
    expect(suggest('/', 1, doc, { providers: [asana] }).items.map(s => s.insert)).toContain('tasks');
    expect(suggest('/as', 3, doc, { providers: both }).items.map(s => s.insert)).toContain('asana');
  });
  it('leaves the service out of the ghost text after an alias', () => {
    const doc = seedDoc(now);
    expect(suggest('/vk ', 4, doc, { providers: both }).ghost).toBe(SYNTAX.tasks.replace('[‹service›] ', ''));
    expect(suggest('/asana ', 7, doc, { providers: both }).ghost).toBe(SYNTAX.tasks.replace('[‹service›] ', ''));
    expect(suggest('/tasks ', 7, doc, { providers: both }).ghost).toBe(SYNTAX.tasks);
  });
});

describe('/tasks field switches (D21)', () => {
  const vk = () => bound('vikunja', 'Vikunja');
  const run = (text: string, doc: Doc) => { const p = parse(text, doc, { now, providers: both }); if (!p.ok) throw new Error(p.error); return ok(apply(doc, p.cmd, now)); };
  it('parses /tasks field ‹name› on|off and logs it in capitals', () => {
    expect(parse('/tasks field identity off', vk(), { now, providers: both })).toMatchObject({ ok: true, cmd: { verb: 'tasks', args: { action: 'field', field: 'identity', on: false } }, preview: 'VIKUNJA IDENTITY SYNC OFF' });
    const off = run('/tasks field identity off', vk());
    expect(off.log).toBe('VIKUNJA IDENTITY SYNC OFF');
    expect(off.doc.settings.taskSync?.off).toEqual(['identity']);
    expect(off.doc.log.at(-1)).toMatchObject({ text: 'VIKUNJA IDENTITY SYNC OFF', cmd: '/tasks field identity off' });
    // Kept in SYNC_FIELDS order, whatever the order they were switched off.
    const two = run('/vk field state off', run('/tasks field progress off', off.doc).doc);
    expect(two.doc.settings.taskSync?.off).toEqual(['identity', 'state', 'progress']);
    const on = run('/tasks field identity on', two.doc);
    expect(on.log).toBe('VIKUNJA IDENTITY SYNC ON');
    expect(on.doc.settings.taskSync?.off).toEqual(['state', 'progress']);
    // All on again: nothing is stored.
    expect(run('/tasks field progress on', run('/tasks field state on', on.doc).doc).doc.settings.taskSync).not.toHaveProperty('off');
    expect(run('/tasks field DUE OFF', vk()).doc.settings.taskSync?.off).toEqual(['due']);
  });
  it('refuses a field it does not know, a missing on/off, and an unbound map', () => {
    expect(parse('/tasks field title off', vk(), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected identity, state, due, note or progress', at: 13 });
    expect(parse('/tasks field', vk(), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected identity, state, due, note or progress' });
    expect(parse('/tasks field note', vk(), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected on or off' });
    expect(parse('/tasks field note maybe', vk(), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected on or off', at: 18 });
    expect(parse('/tasks field identity off', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'This map is not bound to a task service: /tasks bind "‹project›"' });
    expect(parse('/asana field identity off', vk(), { now, providers: both })).toMatchObject({ ok: false, error: 'Bound to Vikunja project Ops: /tasks unbind first' });
    expect(tasks(vk(), { action: 'field', field: 'title', on: false })).toEqual({ error: 'Expected identity, state, due, note or progress' });
    expect(tasks(vk(), { action: 'field', field: 'note', on: 'yes' })).toEqual({ error: 'Expected on or off' });
  });
  it('binds with fields already off: /tasks bind … without ‹field›[,‹field›…]', () => {
    for (const text of ['/tasks bind asana "Ops" without identity,state', '/tasks bind asana "Ops" without identity, state', '/asana bind "Ops" without state,identity,state'])
      expect(parse(text, seedDoc(now), { now, providers: both }), text).toMatchObject({ ok: true, cmd: { args: { action: 'bind', provider: 'asana', name: 'Ops', off: ['identity', 'state'] } }, preview: 'ASANA BIND OPS' });
    expect(parse('/tasks bind asana "Ops" without title', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected identity, state, due, note or progress' });
    expect(parse('/tasks bind asana "Ops" without', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected identity, state, due, note or progress' });
    expect(parse('/tasks bind asana "Ops" without identity,', seedDoc(now), { now, providers: both })).toMatchObject({ ok: false, error: 'Expected identity, state, due, note or progress' });
    // Bound elsewhere: the same refusal as a plain bind.
    for (const text of ['/tasks bind vikunja "Other" without identity', '/asana bind "Ops" without identity'])
      expect(parse(text, vk(), { now, providers: both }), text).toMatchObject({ ok: false, error: 'Bound to Vikunja project Ops: /tasks unbind first' });
    expect(parse('/vk bind "Ops" without note', vk(), { now, providers: both })).toMatchObject({ ok: true, cmd: { args: { off: ['note'] } } });
  });
  it('records the switches given at bind; a rebind without them keeps the ones it has', () => {
    const doc = ok(tasks(seedDoc(now), { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops', off: ['state', 'identity'] })).doc;
    expect(doc.settings.taskSync?.off).toEqual(['identity', 'state']);
    expect(ok(tasks(doc, { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops' })).doc.settings.taskSync?.off).toEqual(['identity', 'state']);
    expect(ok(tasks(doc, { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops', off: ['due'] })).doc.settings.taskSync?.off).toEqual(['due']);
    expect(ok(tasks(doc, { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops', off: [] })).doc.settings.taskSync).not.toHaveProperty('off');
    expect(tasks(seedDoc(now), { action: 'bound', provider: 'asana', label: 'Asana', root: '1207', title: 'Ops', off: ['title'] })).toEqual({ error: 'Expected identity, state, due, note or progress' });
  });
  it('keeps the switches in an exported document and refuses unknown ones on import', () => {
    const doc = run('/tasks field identity off', vk()).doc;
    expect(importJson(exportJson(doc)).settings.taskSync?.off).toEqual(['identity']);
    const bad = structuredClone(doc); bad.settings.taskSync!.off = ['title' as never];
    expect(() => importJson(exportJson(bad))).toThrow('Invalid document');
  });
  it('exports SYNC_FIELDS in order', () => {
    expect(SYNC_FIELDS).toEqual(['identity', 'state', 'due', 'note', 'progress']);
  });
  it('offers field, the field names, on and off, and without after a bind', () => {
    const doc = vk();
    expect(suggest('/tasks ', 7, doc, { providers: both }).items.map(s => s.insert)).toContain('field');
    expect(suggest('/tasks field ', 13, doc, { providers: both }).items.map(s => s.insert)).toEqual(['identity', 'state', 'due', 'note', 'progress']);
    expect(suggest('/vk field identity ', 19, doc, { providers: both }).items.map(s => s.insert)).toEqual(['on', 'off']);
    expect(suggest('/tasks bind asana "Ops" ', 24, seedDoc(now), { providers: both }).items.map(s => s.insert)).toEqual(['without']);
    expect(suggest('/tasks bind asana "Ops" without ', 32, seedDoc(now), { providers: both }).items.map(s => s.insert)).toEqual(['identity', 'state', 'due', 'note', 'progress']);
    expect(suggest('/vk bind "Ops" without identity, ', 33, seedDoc(now), { providers: both }).items.map(s => s.insert)).toEqual(['state', 'due', 'note', 'progress']);
  });
});
