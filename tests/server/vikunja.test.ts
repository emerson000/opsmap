import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Store } from '../../server/db';
import { Maps } from '../../server/maps';
import { AFFILIATION_LABELS, VikunjaSync, htmlToText, textToHtml } from '../../server/vikunja/sync';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import type { Doc, Unit } from '../../src/core/model/types';
import { FakeVikunja } from './fake-vikunja';

const user = { id: 'u1', email: 'a@dev.local', name: 'Alice', initials: 'AL', color: '#000' };
let store: Store, maps: Maps, vk: FakeVikunja, sync: VikunjaSync;
const hub = () => maps.default;
const doc = () => hub().doc;
const unit = (d: string) => doc().units.find(u => u.designation === d)!;
const byTask = (id: number) => doc().units.find(u => u.vk === id);
/** A user command on the map, as the browser would send it. */
const run = (text: string) => {
  const p = parse(text, doc(), { now: new Date(), vikunja: true });
  if (!p.ok) throw new Error(p.error);
  return hub().submit(user.id, 'web', crypto.randomUUID(), p.cmd);
};
const bind = () => sync.request(hub().mapId, { action: 'bind', name: 'Ops' }, user, 'web');
const taskOf = (d: string) => vk.tasksById.get(unit(d).vk!)!;

beforeEach(async () => {
  store = new Store(':memory:');
  maps = new Maps(store, 'America/New_York');
  hub().import(user.id, seedDoc(new Date()));
  vk = new FakeVikunja();
  // No debounce timers in tests: cycles run when a test asks.
  // Alice has connected her token; anyone else has none.
  sync = new VikunjaSync(maps, id => id === user.id ? vk : undefined, 'https://todo.example', 'https://opsmap.example', 3_600_000, 3_600_000);
});

describe('Vikunja sync', () => {
  it('binds the map to a project, each sector to a child project, with a Blocked bucket', async () => {
    const log = await bind();
    expect(log).toMatch(/^VIKUNJA BOUND TO OPS — \d+ pushed, \d+ pulled, \d+ tasks created, 0 new units$/);
    const root = [...vk.projectsById.values()].find(p => p.title === 'Ops')!;
    expect(doc().settings.vikunja).toEqual({ project: root.id, title: 'Ops', by: user.id });
    for (const s of doc().sectors) {
      const child = vk.projectsById.get(s.vk!)!;
      expect(child.parent_project_id).toBe(root.id);
      expect(child.title).toBe(s.name);
      expect(vk.boards.get(child.id)!.buckets.map(b => b.title)).toEqual(['To-Do', 'Doing', 'Done', 'Blocked']);
      // Blocked sits between Doing and Done.
      expect(vk.boards.get(child.id)!.buckets.find(b => b.title === 'Blocked')!.position).toBe(250);
      expect(vk.hooks.get(child.id)![0].target_url).toBe(`https://opsmap.example/api/vikunja/hook/${hub().mapId}`);
    }
  });

  it('reuses an existing project and its children by title', async () => {
    const root = await vk.createProject('ops', 0);
    const work = await vk.createProject('work', root.id);
    await bind();
    expect(doc().settings.vikunja?.project).toBe(root.id);
    expect(doc().sectors.find(s => s.name === 'Work')!.vk).toBe(work.id);
  });

  it('creates a task for each open unit and task, and none for persons, places or finished units', async () => {
    run('/done IRSRSP');
    await bind();
    const open = doc().units.filter(u => (u.kind === 'unit' || u.kind === 'event') && u.lifecycle !== 'done' && u.lifecycle !== 'dropped');
    expect(open.every(u => u.vk !== undefined)).toBe(true);
    expect(unit('IRSRSP').vk).toBeUndefined();
    expect(doc().units.filter(u => u.kind === 'person' || u.kind === 'place').every(u => u.vk === undefined)).toBe(true);
    const leak = taskOf('LEAK');
    expect(leak.project_id).toBe(doc().sectors.find(s => s.id === unit('LEAK').sectorId)!.vk);
    expect(leak.title).toBe('Roof leak');
    expect(new Date(leak.due_date!).toISOString()).toBe(unit('LEAK').dueAt);
    // A blocked friendly lands in Blocked, with its note as the description.
    expect(vk.bucketTitle(unit('PASSPORT').vk!)).toBe('Blocked');
    expect(htmlToText(taskOf('PASSPORT').description)).toBe('Waiting on photo');
    // A hostile's progress is its damage: IRS at 70% strength is 30% done.
    expect(taskOf('IRS').percent_done).toBeCloseTo(0.3);
  });

  it('pulls title, due date, description, progress, buckets and done; done destroys a hostile', async () => {
    await bind();
    const irs = unit('IRS').vk!, passport = unit('PASSPORT').vk!;
    vk.edit(irs, { title: 'IRS letter', due_date: '2026-12-15T17:00:00Z', percent_done: 0.6, description: '<p>Call the agent</p>' });
    vk.drag(passport, 'Doing');
    expect(await sync.run(hub().mapId)).toMatch(/0 pushed, 2 pulled/);
    expect(unit('IRS')).toMatchObject({ title: 'IRS letter', dueAt: '2026-12-15T17:00:00.000Z', strength: 40, note: 'Call the agent' });
    expect(unit('PASSPORT').lifecycle).toBe('active');
    expect(doc().log.at(-1)?.text).toMatch(/^VIKUNJA: /);
    expect(doc().log.at(-1)?.via).toBe('vikunja');
    vk.drag(irs, 'Done');
    await sync.run(hub().mapId);
    expect(unit('IRS')).toMatchObject({ lifecycle: 'done', condition: 'destroyed' });
    // Nothing echoes back: the next cycle has nothing to do.
    vk.calls.length = 0;
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(vk.calls.filter(c => c.startsWith('update') || c.startsWith('move'))).toEqual([]);
  });

  it('reopening a task reopens the unit; Blocked blocks it', async () => {
    await bind();
    const tools = unit('TOOLS').vk!;
    vk.drag(tools, 'Done');
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('done');
    vk.edit(tools, { done: false });
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('todo');
    vk.drag(tools, 'Blocked');
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('blocked');
  });

  it('pushes opsmap changes: rename, due, note, BDA, block, done, sector move', async () => {
    await bind();
    run('/rename LEAK "Fix the roof leak"');
    run('/due LEAK 2026-12-20');
    run('/note LEAK "Roofer on Tuesday"');
    run('/bda LEAK 25%');
    run('/block TOOLS by "No reply"');
    run('/done MOVE');
    await sync.run(hub().mapId);
    const leak = taskOf('LEAK');
    expect(leak).toMatchObject({ title: 'Fix the roof leak', percent_done: 0.75 });
    expect(leak.due_date?.slice(0, 10)).toBe('2026-12-20');
    expect(htmlToText(leak.description)).toBe('Roofer on Tuesday');
    expect(vk.bucketTitle(unit('TOOLS').vk!)).toBe('Blocked');
    expect(vk.tasksById.get(unit('MOVE').vk!)!.done).toBe(true);
    run('/move LEAK to Work near');
    await sync.run(hub().mapId);
    expect(taskOf('LEAK').project_id).toBe(doc().sectors.find(s => s.name === 'Work')!.vk);
    // Pushes do not come back as pulls.
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });

  it('moving a task to another sector project moves the unit', async () => {
    await bind();
    const work = doc().sectors.find(s => s.name === 'Work')!;
    vk.edit(unit('LEAK').vk!, { project_id: work.vk! });
    await sync.run(hub().mapId);
    expect(unit('LEAK').sectorId).toBe(work.id);
    expect(unit('LEAK').posOverride).toBeUndefined();   // still follows its date
  });

  it('a task made in Vikunja arrives as a pending unit in that sector; done ones do not', async () => {
    await bind();
    const family = doc().sectors.find(s => s.name === 'Family')!;
    const t = vk.add(family.vk!, { title: 'Book dentist', due_date: '2026-11-20T17:00:00Z', description: '<p>Ask about Saturday</p>' });
    vk.add(family.vk!, { title: 'Old thing', done: true });
    expect(await sync.run(hub().mapId)).toMatch(/1 new units$/);
    const u = byTask(t.id)!;
    expect(u).toMatchObject({ title: 'Book dentist', affiliation: 'pending', sectorId: family.id, note: 'Ask about Saturday', dueAt: '2026-11-20T17:00:00.000Z' });
    expect(doc().units.some(x => x.title === 'Old thing')).toBe(false);
    expect(doc().log.at(-1)?.text).toMatch(/^VIKUNJA NEW /);
  });

  it('a unit captured in opsmap gets a task', async () => {
    await bind();
    run('/new hostile "Car registration" in Family near as CAR');
    await sync.run(hub().mapId);
    expect(taskOf('CAR')).toMatchObject({ title: 'Car registration', project_id: doc().sectors.find(s => s.name === 'Family')!.vk });
  });

  it('when both sides changed the same field, the newer change wins; different fields both keep', async () => {
    await bind();
    const leak = unit('LEAK').vk!;
    run('/rename LEAK "Ours"');
    run('/note LEAK "Our note"');
    vk.tick(60_000);
    vk.edit(leak, { title: 'Theirs, later' });
    await sync.run(hub().mapId);
    expect(unit('LEAK').title).toBe('Theirs, later');
    expect(htmlToText(vk.tasksById.get(leak)!.description)).toBe('Our note');
  });

  it('a task deleted in Vikunja drops its unit', async () => {
    await bind();
    const id = unit('TOOLS').vk!;
    vk.tasksById.delete(id);
    await sync.run(hub().mapId);
    expect(unit('TOOLS')).toMatchObject({ lifecycle: 'dropped' });
    expect(unit('TOOLS').vk).toBeUndefined();
  });

  it('a sector added later gets its child project', async () => {
    await bind();
    run('/sector add Learning');
    await sync.run(hub().mapId);
    const s = doc().sectors.find(x => x.name === 'Learning')!;
    expect(vk.projectsById.get(s.vk!)?.parent_project_id).toBe(doc().settings.vikunja!.project);
  });

  it('unbind keeps the tasks, removes the webhooks and stops syncing; undoing a bind unbinds', async () => {
    await bind();
    const children = doc().sectors.map(s => s.vk!);
    run('/vk unbind');
    expect(doc().settings.vikunja).toBeUndefined();
    expect(doc().units.every((u: Unit) => u.vk === undefined)).toBe(true);
    expect(await sync.run(hub().mapId)).toBe('not bound');
    expect(children.every(id => (vk.hooks.get(id) ?? []).length === 0)).toBe(true);
    expect(vk.tasksById.size).toBeGreaterThan(0);
  });

  it('accepts only webhooks signed with the map secret', async () => {
    await bind();
    const secret = (store.db.prepare('SELECT secret FROM vk_maps').get() as { secret: string }).secret;
    const body = JSON.stringify({ event_name: 'task.updated' });
    expect(sync.webhook(hub().mapId, body, createHmac('sha256', secret).update(body).digest('hex'))).toBe(true);
    expect(sync.webhook(hub().mapId, body, createHmac('sha256', 'wrong').update(body).digest('hex'))).toBe(false);
    expect(sync.webhook(hub().mapId, body, undefined)).toBe(false);
    expect(sync.webhook('other', body, 'x')).toBe(false);
  });

  it('status reports the binding', async () => {
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/not bound/);
    await bind();
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/^VIKUNJA: bound to Ops \(https:\/\/todo\.example\/projects\/\d+\) by u1 · 5 sectors · \d+ units linked · 5 webhooks, none delivered yet: .*VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true.* · last sync/);
  });
});

describe('Vikunja sync: failures and safety', () => {
  it('a failing task creation does not duplicate tasks: links are kept, the rest goes on, the next cycle finishes', async () => {
    const create = vk.createTask.bind(vk);
    let n = 0, fail = true;
    vk.createTask = async (p, f) => { if (fail && ++n === 3) throw new Error('boom'); return create(p, f); };
    expect(await bind()).toMatch(/· 1 failed: \w+: boom$/);
    const tasks = vk.tasksById.size, linked = doc().units.filter(u => u.vk !== undefined).length;
    expect(linked).toBe(tasks);
    fail = false;
    expect(await sync.run(hub().mapId)).toMatch(/1 tasks created, 0 new units$/);
    expect(vk.tasksById.size).toBe(tasks + 1);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled, 0 tasks created, 0 new units$/);
  });

  it('removing a sector moves its units and their tasks; nothing is dropped', async () => {
    await bind();
    const work = doc().sectors.find(s => s.name === 'Work')!, household = doc().sectors.find(s => s.name === 'Household')!;
    const moved = doc().units.filter(u => u.sectorId === work.id && u.vk !== undefined).map(u => u.designation);
    expect(moved.length).toBeGreaterThan(0);
    run('/sector remove Work reassign Household');
    await sync.run(hub().mapId);
    for (const d of moved) {
      expect(unit(d).lifecycle).not.toBe('dropped');
      expect(taskOf(d).project_id).toBe(household.vk);
    }
  });

  it('a document cannot carry a binding: imports and new maps drop it', async () => {
    await bind();
    const exported = structuredClone(doc());
    const info = maps.create(user.id, 'Copy', exported);
    const copy = maps.get(info.id)!.doc;
    expect(copy.settings.vikunja).toBeUndefined();
    expect(copy.sectors.every(s => s.vk === undefined) && copy.units.every(u => u.vk === undefined)).toBe(true);
    expect(await sync.run(info.id)).toBe('not bound');
  });

  it('the bind is the system’s: the binder’s /undo does not strip it; /vk unbind does', async () => {
    await bind();
    expect(() => hub().undo(user.id, crypto.randomUUID())).toThrow();
    expect(doc().settings.vikunja).toBeDefined();
  });

  it('two binds to different projects at once: the second is refused and nothing is dropped', async () => {
    const results = await Promise.allSettled([bind(), sync.request(hub().mapId, { action: 'bind', name: 'Other' }, user, 'web')]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(doc().settings.vikunja?.title).toBe('Ops');
    expect(doc().units.some(u => u.lifecycle === 'dropped')).toBe(false);
  });

  it('unbind then bind again links the same tasks instead of doubling them', async () => {
    await bind();
    const tasks = vk.tasksById.size, units = doc().units.length;
    run('/vk unbind');
    await sync.run(hub().mapId);
    await bind();
    expect(vk.tasksById.size).toBe(tasks);
    expect(doc().units.length).toBe(units);
  });

  it('a long Vikunja description is not cut short in Vikunja', async () => {
    await bind();
    const id = unit('LEAK').vk!, long = 'x'.repeat(20000);
    vk.edit(id, { description: `<p>${long}</p>` });
    await sync.run(hub().mapId);
    expect(unit('LEAK').note?.length).toBe(16000);
    expect(htmlToText(vk.tasksById.get(id)!.description).length).toBe(20000);
  });

  it('a task reopened into a bucket of the user’s own reopens the unit, and stays open', async () => {
    await bind();
    const id = unit('TOOLS').vk!;
    vk.drag(id, 'Done');
    await sync.run(hub().mapId);
    const t = vk.tasksById.get(id)!, board = vk.boards.get(t.project_id)!;
    board.buckets.push({ id: 9999, title: 'Review', position: 260 });
    vk.bucketOfTask.set(id, 9999); t.done = false; t.updated = vk.tick();
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('todo');
    run('/note TOOLS "Unrelated"');
    await sync.run(hub().mapId);
    expect(vk.tasksById.get(id)!.done).toBe(false);
  });
});

describe('Vikunja sync: second review', () => {
  it('a description longer than opsmap keeps is never cut in Vikunja, now or later', async () => {
    await bind();
    const id = unit('LEAK').vk!;
    vk.edit(id, { description: `<p>${'x'.repeat(20000)}</p>` });
    await sync.run(hub().mapId); await sync.run(hub().mapId);
    expect(htmlToText(vk.tasksById.get(id)!.description)).toHaveLength(20000);
    expect(unit('LEAK').note).toHaveLength(16000);
  });
  it('linking a same-title task keeps what Vikunja has where opsmap has nothing', async () => {
    const root = await vk.createProject('Ops', 0);
    const leak = unit('LEAK'), sector = doc().sectors.find(s => s.id === leak.sectorId)!;
    run('/note LEAK ""');
    const child = await vk.createProject(sector.name, root.id);
    const t = vk.add(child.id, { title: leak.title, description: '<p>History from Vikunja</p>', updated: '2020-01-01T00:00:00Z' });
    await bind();
    expect(unit('LEAK').vk).toBe(t.id);
    expect(unit('LEAK').note).toBe('History from Vikunja');
    expect(htmlToText(vk.tasksById.get(t.id)!.description)).toBe('History from Vikunja');
  });
  it('two tasks with one title do not pair up with a unit', async () => {
    const root = await vk.createProject('Ops', 0);
    const leak = unit('LEAK'), sector = doc().sectors.find(s => s.id === leak.sectorId)!;
    const child = await vk.createProject(sector.name, root.id);
    const a = vk.add(child.id, { title: leak.title }), b = vk.add(child.id, { title: leak.title });
    await bind();
    expect([a.id, b.id]).not.toContain(unit('LEAK').vk);
  });
  it('a hostile label and progress set in one Vikunja edit both arrive', async () => {
    await bind();
    const id = unit('TOOLS').vk!, t = vk.tasksById.get(id)!;
    t.labels = [vk.label('hostile')]; vk.edit(id, { percent_done: 0.4 });
    await sync.run(hub().mapId);
    expect(unit('TOOLS')).toMatchObject({ affiliation: 'hostile', strength: 60 });
    expect(vk.tasksById.get(id)!.percent_done).toBeCloseTo(0.4);
  });
  it('a unit undone while its task is being made leaves no task and does not come back', async () => {
    await bind();
    run('/new "Alpha thing"'); run('/new "Bravo thing"');
    const create = vk.createTask.bind(vk); let n = 0;
    vk.createTask = async (p, f) => { const r = await create(p, f); if (++n === 2) hub().undo(user.id, crypto.randomUUID()); return r; };
    await sync.run(hub().mapId);
    vk.createTask = create;
    await sync.run(hub().mapId);
    expect(doc().units.filter(u => /thing/.test(u.title)).map(u => u.title)).toEqual(['Alpha thing']);
    expect([...vk.tasksById.values()].filter(t => /thing/.test(t.title)).map(t => t.title)).toEqual(['Alpha thing']);
  });
  it('a sector whose project is archived in Vikunja is left alone and reported', async () => {
    await bind();
    const family = doc().sectors.find(s => s.name === 'Family')!;
    vk.projectsById.get(family.vk!)!.is_archived = true;
    vk.calls.length = 0;
    run('/rename PASSPORT "Passport renewal"');
    expect(await sync.run(hub().mapId)).not.toMatch(/failed/);
    expect(vk.calls.filter(c => c.startsWith('update') || c.startsWith('create'))).toEqual([]);
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/not synced, project archived in Vikunja: Family/);
  });
});

describe('Vikunja identity labels', () => {
  it('each task gets one identity label, created on first use', async () => {
    await bind();
    expect(vk.labelsOf(unit('LEAK').vk!)).toEqual(['hostile']);
    expect(vk.labelsOf(unit('IRSRSP').vk!)).toEqual(['friendly']);
    expect(vk.labelsOf(unit('TOOLS').vk!)).toEqual(['pending']);
    // One label per identity in use, each made once.
    const used = [...new Set(doc().units.filter(u => u.vk !== undefined).map(u => AFFILIATION_LABELS[u.affiliation].titles[0]))].sort();
    expect(vk.calls.filter(c => c.startsWith('createLabel')).map(c => c.slice('createLabel '.length)).sort()).toEqual(used);
  });
  it('a label set in Vikunja sets the identity; /id swaps the label; other and ambiguous labels are left alone', async () => {
    await bind();
    const id = unit('TOOLS').vk!, t = vk.tasksById.get(id)!;
    t.labels = [vk.label('hostile'), vk.label('errand')]; t.updated = vk.tick();
    await sync.run(hub().mapId);
    expect(unit('TOOLS').affiliation).toBe('hostile');
    run('/id TOOLS friend');
    await sync.run(hub().mapId);
    expect(vk.labelsOf(id)).toEqual(['errand', 'friendly']);
    // Several identity labels: ambiguous, so neither side changes; the user settles it in Vikunja.
    t.labels = [...(t.labels ?? []), vk.label('unknown')]; t.updated = vk.tick();
    await sync.run(hub().mapId);
    expect(unit('TOOLS').affiliation).toBe('friend');
    expect(vk.labelsOf(id)).toEqual(['errand', 'friendly', 'unknown']);
  });
  it('a task made with a label arrives with that identity; existing labels are reused by title', async () => {
    const enemy = vk.label('Hostile');
    await bind();
    expect(vk.labelsOf(unit('LEAK').vk!)).toEqual(['Hostile']);
    const family = doc().sectors.find(s => s.name === 'Family')!;
    const t = vk.add(family.vk!, { title: 'Parking ticket', labels: [enemy] });
    await sync.run(hub().mapId);
    expect(byTask(t.id)!.affiliation).toBe('hostile');
  });
});

describe('Vikunja webhooks', () => {
  const target = () => `https://opsmap.example/api/vikunja/hook/${hub().mapId}`;
  const hooksOn = (project: number) => vk.hooks.get(project) ?? [];
  const sign = (body: string) => {
    const secret = (store.db.prepare('SELECT secret FROM vk_maps').get() as { secret: string }).secret;
    return createHmac('sha256', secret).update(body).digest('hex');
  };
  it('bind registers one webhook per sector project, for task created, updated and deleted', async () => {
    await bind();
    for (const s of doc().sectors) {
      expect(hooksOn(s.vk!)).toHaveLength(1);
      expect(hooksOn(s.vk!)[0]).toMatchObject({ target_url: target(), events: ['task.created', 'task.updated', 'task.deleted'] });
    }
  });
  it('a webhook deleted or changed in Vikunja is made again: at once on /vk sync, otherwise every 10 minutes', async () => {
    await bind();
    const work = doc().sectors.find(s => s.name === 'Work')!.vk!, family = doc().sectors.find(s => s.name === 'Family')!.vk!;
    vk.hooks.set(work, []);
    vk.hooks.set(family, [{ ...hooksOn(family)[0], events: ['task.created'] }]);
    await sync.run(hub().mapId);                       // a routine cycle within 10 minutes does not ask Vikunja
    expect(hooksOn(work)).toHaveLength(0);
    await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(hooksOn(work)).toHaveLength(1);
    expect(hooksOn(family)).toHaveLength(1);
    expect(hooksOn(family)[0].events).toEqual(['task.created', 'task.updated', 'task.deleted']);
  });
  it('a new sector gets its webhook on the next cycle', async () => {
    await bind();
    run('/sector add Learning');
    await sync.run(hub().mapId);
    expect(hooksOn(doc().sectors.find(s => s.name === 'Learning')!.vk!)).toHaveLength(1);
  });
  it('a signed delivery syncs within a moment and shows in /vk status', async () => {
    await bind();
    const body = JSON.stringify({ event_name: 'task.updated', data: { task: { id: unit('LEAK').vk } } });
    vk.edit(unit('LEAK').vk!, { title: 'Changed in Vikunja' });
    expect(sync.webhook(hub().mapId, body, sign(body))).toBe(true);
    await new Promise(r => setTimeout(r, 700));
    await sync.run(hub().mapId);                       // wait for the scheduled cycle to settle
    expect(unit('LEAK').title).toBe('Changed in Vikunja');
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/5 webhooks · last delivery \d\d:\d\d:\d\dZ/);
  });
  it('deleting the map removes its webhooks', async () => {
    const info = maps.create(user.id, 'Second');
    const second = maps.get(info.id)!;
    await sync.request(info.id, { action: 'bind', name: 'Second' }, user, 'web');
    const projects = second.doc.sectors.map(s => s.vk!);
    expect(projects.every(p => hooksOn(p).length === 1)).toBe(true);
    maps.remove(info.id);
    await new Promise(r => setTimeout(r, 20));
    expect(projects.every(p => hooksOn(p).length === 0)).toBe(true);
    expect(store.db.prepare('SELECT * FROM vk_maps WHERE map_id=?').get(info.id)).toBeUndefined();
  });
  it('without a reachable PUBLIC_URL there are no webhooks, and status says it polls', async () => {
    const local = new VikunjaSync(maps, id => id === user.id ? vk : undefined, 'https://todo.example', undefined, 3_600_000, 3_600_000);
    await local.request(hub().mapId, { action: 'bind', name: 'Ops' }, user, 'web');
    expect(doc().sectors.every(s => hooksOn(s.vk!).length === 0)).toBe(true);
    expect(await local.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/polling every minute \(webhooks need PUBLIC_URL/);
    await local.stop();
  });
});

describe('Vikunja tokens', () => {
  it('a map syncs with the token of the user who bound it; others need none to sync, but need their own to bind', async () => {
    const bob = { ...user, id: 'u2', name: 'Bob' };
    await expect(sync.request(hub().mapId, { action: 'bind', name: 'Ops' }, bob, 'web')).rejects.toThrow(/No Vikunja token for u2/);
    await bind();
    expect(doc().settings.vikunja?.by).toBe(user.id);
    expect(await sync.request(hub().mapId, { action: 'sync' }, bob, 'web')).toMatch(/^VIKUNJA SYNC — /);
    // The binder's token is gone: syncing says so instead of using anyone else's.
    const orphan = new VikunjaSync(maps, () => undefined, 'https://todo.example', undefined, 3_600_000, 3_600_000);
    await expect(orphan.run(hub().mapId)).rejects.toThrow(/No Vikunja token for u1: connect it in the menu → Vikunja/);
    expect(await orphan.request(hub().mapId, { action: 'status' }, bob, 'web')).toMatch(/by u1 \(no token: connect it in the menu → Vikunja\)/);
    await orphan.stop();
  });
});

describe('/vk commands', () => {
  const d = (): Doc => seedDoc(new Date());
  it('exist only when the server has Vikunja', () => {
    expect(parse('/vk status', d())).toMatchObject({ ok: false, error: 'Vikunja sync is not configured on this server' });
    expect(parse('/vk bind "Ops"', d(), { vikunja: true })).toMatchObject({ ok: true, cmd: { verb: 'vk', args: { action: 'bind', name: 'Ops' } } });
    expect(parse('/vk sync', d(), { vikunja: true })).toMatchObject({ ok: false, error: /not bound/ });
    expect(parse('/vk frobnicate', d(), { vikunja: true })).toMatchObject({ ok: false });
  });
  it('users may submit only unbind; the rest is the server’s', () => {
    expect(() => hub().submit(user.id, 'web', crypto.randomUUID(), { verb: 'vk', args: { action: 'bound', project: 1, title: 'X', sectors: {} } })).toThrow('Invalid or privileged command');
  });
  it('notes round-trip through Vikunja HTML', () => {
    for (const note of ['One line', 'Two\nlines', 'a < b & "c"']) expect(htmlToText(textToHtml(note))).toBe(note);
    expect(htmlToText('<p>Hello <strong>there</strong></p><ul><li>one</li><li>two</li></ul>')).toBe('Hello there\none\ntwo');
  });
});
