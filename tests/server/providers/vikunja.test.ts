import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Store } from '../../../server/db';
import { Maps } from '../../../server/maps';
import { SecretBox } from '../../../server/secrets';
import { AFFILIATION_LABELS, htmlToText, textToHtml } from '../../../server/providers/vikunja/adapter';
import { VikunjaProvider } from '../../../server/providers/vikunja';
import { HOOK_PATHS } from '../../../server/providers';
import { TaskSyncEngine } from '../../../server/tasksync/engine';
import { Credentials } from '../../../server/tasksync/credentials';
import { ProviderRegistry } from '../../../server/tasksync/registry';
import { parse } from '../../../src/core/commands/grammar';
import { seedDoc } from '../../../src/core/model/seed';
import type { Doc, Unit } from '../../../src/core/model/types';
import { FakeVikunja } from './fake-vikunja';
/** A remote id in the document (an opaque string) as the fake Vikunja's number. */
const vkId = (x: { remote?: string } | undefined) => x?.remote === undefined ? undefined : Number(x.remote);
const providers = ProviderRegistry.fromEnv({ VIKUNJA_URL: 'https://todo.example' }).info();

const user = { id: 'u1', email: 'a@dev.local', name: 'Alice', initials: 'AL', color: '#000' };
let store: Store, maps: Maps, vk: FakeVikunja, sync: TaskSyncEngine, registry: ProviderRegistry, credentials: Credentials;
const hub = () => maps.default;
const doc = () => hub().doc;
const unit = (d: string) => doc().units.find(u => u.designation === d)!;
const byTask = (id: number) => doc().units.find(u => vkId(u) === id);
/** A user command on the map, as the browser would send it. */
const run = (text: string) => {
  const p = parse(text, doc(), { now: new Date(), providers });
  if (!p.ok) throw new Error(p.error);
  return hub().submit(user.id, 'web', crypto.randomUUID(), p.cmd);
};
const bind = () => sync.request(hub().mapId, { action: 'bind', name: 'Ops' }, user, 'web');
const taskOf = (d: string) => vk.tasksById.get(vkId(unit(d))!)!;
/** An engine on this store: `hookBase` is PUBLIC_URL; the address resolves as a public one. Long debounce: cycles run when a test asks. */
const engine = (hookBase: string | undefined, creds = credentials) => new TaskSyncEngine(maps, registry, creds, hookBase, 3_600_000, undefined, { resolve: async () => ['93.184.216.34'], hookPaths: HOOK_PATHS });
/** A delivery to the Vikunja hook: accepted (200) or not. */
const webhook = (mapId: string, body: string, signature: string | undefined) => sync.webhook('vikunja', mapId, new Headers(signature === undefined ? {} : { 'x-vikunja-signature': signature }), body).status === 200;

beforeEach(async () => {
  store = new Store(':memory:');
  maps = new Maps(store, 'Europe/London');
  hub().import(user.id, seedDoc(new Date()));
  vk = new FakeVikunja();
  registry = new ProviderRegistry([new VikunjaProvider('https://todo.example', () => vk)]);
  // Alice has connected her token; anyone else has none.
  credentials = new Credentials(store, SecretBox.fromKey(Buffer.alloc(32, 7)), registry);
  await credentials.save(user.id, 'vikunja', 'tk_good_token');
  // No debounce timers in tests: cycles run when a test asks.
  sync = engine('https://opsmap.example');
});

describe('Vikunja sync', () => {
  it('binds the map to a project, each sector to a child project, with a Blocked bucket', async () => {
    const log = await bind();
    expect(log).toMatch(/^VIKUNJA BOUND TO OPS — \d+ pushed, \d+ pulled, \d+ tasks created, 0 new units$/);
    const root = [...vk.projectsById.values()].find(p => p.title === 'Ops')!;
    expect(doc().settings.taskSync).toEqual({ provider: 'vikunja', label: 'Vikunja', root: String(root.id), title: 'Ops', by: user.id });
    for (const s of doc().sectors) {
      const child = vk.projectsById.get(vkId(s)!)!;
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
    expect(doc().settings.taskSync?.root).toBe(String(root.id));
    expect(vkId(doc().sectors.find(s => s.name === 'Work')!)).toBe(work.id);
  });

  it('creates a task for each open unit and task, and none for persons, places or finished units', async () => {
    run('/done IRSRSP');
    await bind();
    const open = doc().units.filter(u => (u.kind === 'unit' || u.kind === 'event') && u.lifecycle !== 'done' && u.lifecycle !== 'dropped');
    expect(open.every(u => vkId(u) !== undefined)).toBe(true);
    expect(vkId(unit('IRSRSP'))).toBeUndefined();
    expect(doc().units.filter(u => u.kind === 'person' || u.kind === 'place').every(u => vkId(u) === undefined)).toBe(true);
    const leak = taskOf('LEAK');
    expect(leak.project_id).toBe(vkId(doc().sectors.find(s => s.id === unit('LEAK').sectorId)!));
    expect(leak.title).toBe('Roof leak');
    expect(new Date(leak.due_date!).toISOString()).toBe(unit('LEAK').dueAt);
    // A blocked friendly lands in Blocked, with its note as the description.
    expect(vk.bucketTitle(vkId(unit('PASSPORT'))!)).toBe('Blocked');
    expect(htmlToText(taskOf('PASSPORT').description)).toBe('Waiting on photo');
    // A hostile's progress is its damage: IRS at 70% strength is 30% done.
    expect(taskOf('IRS').percent_done).toBeCloseTo(0.3);
  });

  it('pulls title, due date, description, progress, buckets and done; done destroys a hostile', async () => {
    await bind();
    const irs = vkId(unit('IRS'))!, passport = vkId(unit('PASSPORT'))!;
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
    const tools = vkId(unit('TOOLS'))!;
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
    expect(vk.bucketTitle(vkId(unit('TOOLS'))!)).toBe('Blocked');
    expect(vk.tasksById.get(vkId(unit('MOVE'))!)!.done).toBe(true);
    run('/move LEAK to Work near');
    await sync.run(hub().mapId);
    expect(taskOf('LEAK').project_id).toBe(vkId(doc().sectors.find(s => s.name === 'Work')!));
    // Pushes do not come back as pulls.
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });

  it('moving a task to another sector project moves the unit', async () => {
    await bind();
    const work = doc().sectors.find(s => s.name === 'Work')!;
    vk.edit(vkId(unit('LEAK'))!, { project_id: vkId(work)! });
    await sync.run(hub().mapId);
    expect(unit('LEAK').sectorId).toBe(work.id);
    expect(unit('LEAK').posOverride).toBeUndefined();   // still follows its date
  });

  it('a task made in Vikunja arrives as a pending unit in that sector; done ones do not', async () => {
    await bind();
    const family = doc().sectors.find(s => s.name === 'Family')!;
    const t = vk.add(vkId(family)!, { title: 'Book dentist', due_date: '2026-11-20T17:00:00Z', description: '<p>Ask about Saturday</p>' });
    vk.add(vkId(family)!, { title: 'Old thing', done: true });
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
    expect(taskOf('CAR')).toMatchObject({ title: 'Car registration', project_id: vkId(doc().sectors.find(s => s.name === 'Family')!) });
  });

  it('when both sides changed the same field, the newer change wins; different fields both keep', async () => {
    await bind();
    const leak = vkId(unit('LEAK'))!;
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
    const id = vkId(unit('TOOLS'))!;
    vk.tasksById.delete(id);
    await sync.run(hub().mapId);
    expect(unit('TOOLS')).toMatchObject({ lifecycle: 'dropped' });
    expect(vkId(unit('TOOLS'))).toBeUndefined();
  });

  it('a sector added later gets its child project', async () => {
    await bind();
    run('/sector add Learning');
    await sync.run(hub().mapId);
    const s = doc().sectors.find(x => x.name === 'Learning')!;
    expect(vk.projectsById.get(vkId(s)!)?.parent_project_id).toBe(Number(doc().settings.taskSync!.root));
  });

  it('unbind keeps the tasks, removes the webhooks and stops syncing; undoing a bind unbinds', async () => {
    await bind();
    const children = doc().sectors.map(s => vkId(s)!);
    run('/vk unbind');
    expect(doc().settings.taskSync).toBeUndefined();
    expect(doc().units.every((u: Unit) => vkId(u) === undefined)).toBe(true);
    expect(await sync.run(hub().mapId)).toBe('not bound');
    expect(children.every(id => (vk.hooks.get(id) ?? []).length === 0)).toBe(true);
    expect(vk.tasksById.size).toBeGreaterThan(0);
  });

  it('accepts only webhooks signed with the map secret', async () => {
    await bind();
    const secret = (store.db.prepare('SELECT secret FROM ts_maps').get() as { secret: string }).secret;
    const body = JSON.stringify({ event_name: 'task.updated' });
    expect(webhook(hub().mapId, body, createHmac('sha256', secret).update(body).digest('hex'))).toBe(true);
    expect(webhook(hub().mapId, body, createHmac('sha256', 'wrong').update(body).digest('hex'))).toBe(false);
    expect(webhook(hub().mapId, body, undefined)).toBe(false);
    expect(webhook('other', body, 'x')).toBe(false);
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
    const tasks = vk.tasksById.size, linked = doc().units.filter(u => vkId(u) !== undefined).length;
    expect(linked).toBe(tasks);
    fail = false;
    expect(await sync.run(hub().mapId)).toMatch(/1 tasks created, 0 new units$/);
    expect(vk.tasksById.size).toBe(tasks + 1);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled, 0 tasks created, 0 new units$/);
  });

  it('removing a sector moves its units and their tasks; nothing is dropped', async () => {
    await bind();
    const work = doc().sectors.find(s => s.name === 'Work')!, household = doc().sectors.find(s => s.name === 'Household')!;
    const moved = doc().units.filter(u => u.sectorId === work.id && vkId(u) !== undefined).map(u => u.designation);
    expect(moved.length).toBeGreaterThan(0);
    run('/sector remove Work reassign Household');
    await sync.run(hub().mapId);
    for (const d of moved) {
      expect(unit(d).lifecycle).not.toBe('dropped');
      expect(taskOf(d).project_id).toBe(vkId(household));
    }
  });

  it('a document cannot carry a binding: imports and new maps drop it', async () => {
    await bind();
    const exported = structuredClone(doc());
    const info = maps.create(user.id, 'Copy', exported);
    const copy = maps.get(info.id)!.doc;
    expect(copy.settings.taskSync).toBeUndefined();
    expect(copy.sectors.every(s => vkId(s) === undefined) && copy.units.every(u => vkId(u) === undefined)).toBe(true);
    expect(await sync.run(info.id)).toBe('not bound');
  });

  it('the bind is the system’s: the binder’s /undo does not strip it; /vk unbind does', async () => {
    await bind();
    expect(() => hub().undo(user.id, crypto.randomUUID())).toThrow();
    expect(doc().settings.taskSync).toBeDefined();
  });

  it('two binds to different projects at once: the second is refused and nothing is dropped', async () => {
    const results = await Promise.allSettled([bind(), sync.request(hub().mapId, { action: 'bind', name: 'Other' }, user, 'web')]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(doc().settings.taskSync?.title).toBe('Ops');
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
    const id = vkId(unit('LEAK'))!, long = 'x'.repeat(20000);
    vk.edit(id, { description: `<p>${long}</p>` });
    await sync.run(hub().mapId);
    expect(unit('LEAK').note?.length).toBe(16000);
    expect(htmlToText(vk.tasksById.get(id)!.description).length).toBe(20000);
  });

  it('a task reopened into a bucket of the user’s own reopens the unit, and stays open', async () => {
    await bind();
    const id = vkId(unit('TOOLS'))!;
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
    const id = vkId(unit('LEAK'))!;
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
    expect(vkId(unit('LEAK'))).toBe(t.id);
    expect(unit('LEAK').note).toBe('History from Vikunja');
    expect(htmlToText(vk.tasksById.get(t.id)!.description)).toBe('History from Vikunja');
  });
  it('two tasks with one title do not pair up with a unit', async () => {
    const root = await vk.createProject('Ops', 0);
    const leak = unit('LEAK'), sector = doc().sectors.find(s => s.id === leak.sectorId)!;
    const child = await vk.createProject(sector.name, root.id);
    const a = vk.add(child.id, { title: leak.title }), b = vk.add(child.id, { title: leak.title });
    await bind();
    expect([a.id, b.id]).not.toContain(vkId(unit('LEAK')));
  });
  it('a hostile label and progress set in one Vikunja edit both arrive', async () => {
    await bind();
    const id = vkId(unit('TOOLS'))!, t = vk.tasksById.get(id)!;
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
    vk.projectsById.get(vkId(family)!)!.is_archived = true;
    vk.calls.length = 0;
    run('/rename PASSPORT "Passport renewal"');
    expect(await sync.run(hub().mapId)).not.toMatch(/failed/);
    expect(vk.calls.filter(c => c.startsWith('update') || c.startsWith('create'))).toEqual([]);
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/not synced, project archived in Vikunja: Family/);
  });
});

describe('Vikunja identity labels', () => {
  it('with identity switched off, linked tasks lose only their identity labels; other labels stay', async () => {
    await bind();
    const leak = vk.tasksById.get(vkId(unit('LEAK'))!)!, tools = vk.tasksById.get(vkId(unit('TOOLS'))!)!;
    leak.labels = [...(leak.labels ?? []), vk.label('errand')]; leak.updated = vk.tick();
    // Several identity labels go too.
    tools.labels = [vk.label('hostile'), vk.label('unknown'), vk.label('home')]; tools.updated = vk.tick();
    await sync.run(hub().mapId);
    expect(run('/tasks field identity off').log).toBe('VIKUNJA IDENTITY SYNC OFF');
    await sync.run(hub().mapId);
    expect(vk.labelsOf(leak.id)).toEqual(['errand']);
    expect(vk.labelsOf(tools.id)).toEqual(['home']);
    expect(doc().units.filter(u => vkId(u) !== undefined).every(u => vk.labelsOf(vkId(u)!).every(l => l === 'errand' || l === 'home'))).toBe(true);
    expect(unit('LEAK').affiliation).toBe('hostile');
    // While off, /id adds no label.
    run('/id LEAK friend');
    vk.calls.length = 0;
    await sync.run(hub().mapId);
    expect(vk.calls.filter(c => /label/i.test(c))).toEqual([]);
    expect(vk.labelsOf(leak.id)).toEqual(['errand']);
  });
  it('with identity switched off, a task made in Vikunja keeps its identity label', async () => {
    await bind();
    const family = doc().sectors.find(s => s.name === 'Family')!;
    const t = vk.add(vkId(family)!, { title: 'Parking ticket', labels: [vk.label('hostile'), vk.label('errand')] });
    await sync.run(hub().mapId);
    expect(byTask(t.id)).toMatchObject({ affiliation: 'hostile' });
    run('/tasks field identity off');
    await sync.run(hub().mapId);
    expect(vk.labelsOf(t.id)).toEqual(['errand', 'hostile']);
    expect(vk.labelsOf(vkId(unit('LEAK'))!)).toEqual([]);
  });
  it('each task gets one identity label, created on first use', async () => {
    await bind();
    expect(vk.labelsOf(vkId(unit('LEAK'))!)).toEqual(['hostile']);
    expect(vk.labelsOf(vkId(unit('IRSRSP'))!)).toEqual(['friendly']);
    expect(vk.labelsOf(vkId(unit('TOOLS'))!)).toEqual(['pending']);
    // One label per identity in use, each made once.
    const used = [...new Set(doc().units.filter(u => vkId(u) !== undefined).map(u => AFFILIATION_LABELS[u.affiliation].titles[0]))].sort();
    expect(vk.calls.filter(c => c.startsWith('createLabel')).map(c => c.slice('createLabel '.length)).sort()).toEqual(used);
  });
  it('a label set in Vikunja sets the identity; /id swaps the label; other and ambiguous labels are left alone', async () => {
    await bind();
    const id = vkId(unit('TOOLS'))!, t = vk.tasksById.get(id)!;
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
    expect(vk.labelsOf(vkId(unit('LEAK'))!)).toEqual(['Hostile']);
    const family = doc().sectors.find(s => s.name === 'Family')!;
    const t = vk.add(vkId(family)!, { title: 'Parking ticket', labels: [enemy] });
    await sync.run(hub().mapId);
    expect(byTask(t.id)!.affiliation).toBe('hostile');
  });
});

describe('Vikunja relations', () => {
  const cycle = () => sync.run(hub().mapId);
  const id = (d: string) => vkId(unit(d))!;
  const links = () => doc().orders.filter(o => o.type === 'link').map(o => `${o.from}>${o.to}${o.kind ? ` ${o.kind}` : ''}`).sort();

  it('a task force attachment is the parent task: bind pushes existing ones; /attach and /detach follow', async () => {
    await bind();
    expect(vk.relatedOf(id('PACKING'), 'parenttask')).toEqual([id('MOVE')]);
    expect(vk.relatedOf(id('MOVE'), 'subtask')).toEqual([id('MOVERS'), id('PACKING')].sort());
    run('/attach TOOLS to MOVE');
    run('/detach MOVERS');
    await cycle();
    expect(vk.relatedOf(id('TOOLS'), 'parenttask')).toEqual([id('MOVE')]);
    expect(vk.relatedOf(id('MOVERS'), 'parenttask')).toEqual([]);
    // Attached to another task force: the old parent task is replaced.
    run('/attach TOOLS to Q4RPT');
    await cycle();
    expect(vk.relatedOf(id('TOOLS'), 'parenttask')).toEqual([id('Q4RPT')]);
    vk.calls.length = 0;
    expect(await cycle()).toMatch(/^0 pushed, 0 pulled/);
    expect(vk.calls.filter(c => c.includes('Relation'))).toEqual([]);
  });

  it('a subtask made in Vikunja attaches the unit to the parent task’s unit; removing it detaches', async () => {
    await bind();
    vk.relate(id('FILES'), id('Q4RPT'), 'parenttask');
    await cycle();
    expect(unit('FILES').parentId).toBe('q4rpt');
    expect(unit('Q4RPT').taskForce).toBe(true);
    expect(doc().log.at(-1)).toMatchObject({ text: 'VIKUNJA: FILES ATTACHED TO TF Q4RPT', via: 'vikunja' });
    // Made from the parent's side too.
    vk.relate(id('Q4RPT'), id('TOOLS'), 'subtask');
    await cycle();
    expect(unit('TOOLS').parentId).toBe('q4rpt');
    vk.unrelate(id('FILES'), id('Q4RPT'), 'parenttask');
    await cycle();
    expect(unit('FILES').parentId).toBeUndefined();
    expect(doc().log.at(-1)?.text).toBe('VIKUNJA: FILES DETACHED');
    // A task with two parent tasks is the user's to settle: the unit keeps its task force.
    vk.relate(id('TOOLS'), id('MOVE'), 'parenttask');
    await cycle();
    expect(unit('TOOLS').parentId).toBe('q4rpt');
  });

  it('link orders are relations: related, blocked by (dependency) and precedes (handoff); /halt removes them', async () => {
    await bind();
    run('/link RECORDS IRSRSP');
    run('/link LEAK RECORDS as dependency');
    run('/link Q4RPT TOOLS as handoff');
    await cycle();
    expect(vk.relatedOf(id('RECORDS'), 'related')).toEqual([id('IRSRSP')]);
    expect(vk.relatedOf(id('LEAK'), 'blocked')).toEqual([id('RECORDS')]);
    expect(vk.relatedOf(id('RECORDS'), 'blocking')).toEqual([id('LEAK')]);
    expect(vk.relatedOf(id('Q4RPT'), 'precedes')).toEqual([id('TOOLS')]);
    expect(await cycle()).toMatch(/^0 pushed, 0 pulled/);
    run('/halt LEAK link');
    await cycle();
    expect(vk.relatedOf(id('LEAK'), 'blocked')).toEqual([]);
    expect(vk.relatedOf(id('RECORDS'), 'related')).toEqual([id('IRSRSP')]);
  });

  it('relations made in Vikunja become link orders; removed there, the order is cancelled', async () => {
    await bind();
    vk.relate(id('IRSRSP'), id('RECORDS'), 'blocking');
    vk.relate(id('TOOLS'), id('Q4RPT'), 'follows');
    await cycle();
    expect(links()).toEqual(['q4rpt>tools handoff', 'records>irsrsp dependency']);
    expect(doc().log.some(l => l.text === 'VIKUNJA: LINKUP RECORDS / IRSRSP — DEPENDENCY' && l.via === 'vikunja')).toBe(true);
    vk.unrelate(id('RECORDS'), id('IRSRSP'), 'blocked');
    await cycle();
    expect(links()).toEqual(['q4rpt>tools handoff']);
    expect(doc().log.at(-1)?.text).toMatch(/^VIKUNJA: RECORDS HALTED: LINK ON IRSRSP CANCELLED$/);
  });

  it('a relation opsmap cannot take (a link across sectors) is reported once and left in Vikunja', async () => {
    await bind();
    vk.relate(id('TOOLS'), id('FILES'), 'related');
    expect(await cycle()).toMatch(/1 failed: relation .*Cross-sector orders require a task force/);
    expect(links()).toEqual([]);
    expect(await cycle()).not.toMatch(/failed/);
    expect(vk.relatedOf(id('TOOLS'), 'related')).toEqual([id('FILES')]);
  });

  it('a finished unit loses its link orders, but its task keeps its relations', async () => {
    await bind();
    run('/link RECORDS IRSRSP');
    await cycle();
    run('/done RECORDS');
    await cycle();
    expect(vk.relatedOf(id('IRSRSP'), 'related')).toEqual([id('RECORDS')]);
  });
});

describe('Vikunja webhooks', () => {
  const target = () => `https://opsmap.example/api/vikunja/hook/${hub().mapId}`;
  const hooksOn = (project: number) => vk.hooks.get(project) ?? [];
  const sign = (body: string) => {
    const secret = (store.db.prepare('SELECT secret FROM ts_maps').get() as { secret: string }).secret;
    return createHmac('sha256', secret).update(body).digest('hex');
  };
  it('bind registers one webhook per sector project, for tasks and their relations created, updated and deleted', async () => {
    await bind();
    for (const s of doc().sectors) {
      expect(hooksOn(vkId(s)!)).toHaveLength(1);
      expect(hooksOn(vkId(s)!)[0]).toMatchObject({ target_url: target(), events: ['task.created', 'task.updated', 'task.deleted', 'task.relation.created', 'task.relation.deleted'] });
    }
  });
  it('a webhook deleted or changed in Vikunja is made again: at once on /vk sync, otherwise every 10 minutes', async () => {
    await bind();
    const work = vkId(doc().sectors.find(s => s.name === 'Work')!)!, family = vkId(doc().sectors.find(s => s.name === 'Family')!)!;
    vk.hooks.set(work, []);
    vk.hooks.set(family, [{ ...hooksOn(family)[0], events: ['task.created'] }]);
    await sync.run(hub().mapId);                       // a routine cycle within 10 minutes does not ask Vikunja
    expect(hooksOn(work)).toHaveLength(0);
    await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(hooksOn(work)).toHaveLength(1);
    expect(hooksOn(family)).toHaveLength(1);
    expect(hooksOn(family)[0].events).toEqual(['task.created', 'task.updated', 'task.deleted', 'task.relation.created', 'task.relation.deleted']);
  });
  it('a new sector gets its webhook on the next cycle', async () => {
    await bind();
    run('/sector add Learning');
    await sync.run(hub().mapId);
    expect(hooksOn(vkId(doc().sectors.find(s => s.name === 'Learning')!)!)).toHaveLength(1);
  });
  it('a signed delivery syncs within a moment and shows in /vk status', async () => {
    await bind();
    const body = JSON.stringify({ event_name: 'task.updated', data: { task: { id: vkId(unit('LEAK')) } } });
    vk.edit(vkId(unit('LEAK'))!, { title: 'Changed in Vikunja' });
    expect(webhook(hub().mapId, body, sign(body))).toBe(true);
    await new Promise(r => setTimeout(r, 700));
    await sync.run(hub().mapId);                       // wait for the scheduled cycle to settle
    expect(unit('LEAK').title).toBe('Changed in Vikunja');
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/5 webhooks · last delivery \d\d:\d\d:\d\dZ/);
  });
  it('deleting the map removes its webhooks', async () => {
    const info = maps.create(user.id, 'Second');
    const second = maps.get(info.id)!;
    await sync.request(info.id, { action: 'bind', name: 'Second' }, user, 'web');
    const projects = second.doc.sectors.map(s => vkId(s)!);
    expect(projects.every(p => hooksOn(p).length === 1)).toBe(true);
    maps.remove(info.id);
    await new Promise(r => setTimeout(r, 20));
    expect(projects.every(p => hooksOn(p).length === 0)).toBe(true);
    expect(store.db.prepare('SELECT * FROM ts_maps WHERE map_id=?').get(info.id)).toBeUndefined();
  });
  it('without a reachable PUBLIC_URL there are no webhooks, and status says it polls', async () => {
    const local = engine(undefined);
    await local.request(hub().mapId, { action: 'bind', name: 'Ops' }, user, 'web');
    expect(doc().sectors.every(s => hooksOn(vkId(s)!).length === 0)).toBe(true);
    expect(await local.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/polling every minute \(webhooks need PUBLIC_URL/);
    await local.stop();
  });
});

describe('Vikunja tokens', () => {
  it('a map syncs with the token of the user who bound it; others need none to sync, but need their own to bind', async () => {
    const bob = { ...user, id: 'u2', name: 'Bob' };
    await expect(sync.request(hub().mapId, { action: 'bind', name: 'Ops' }, bob, 'web')).rejects.toThrow(/No Vikunja token for u2/);
    await bind();
    expect(doc().settings.taskSync?.by).toBe(user.id);
    expect(await sync.request(hub().mapId, { action: 'sync' }, bob, 'web')).toMatch(/^VIKUNJA SYNC — /);
    // The binder's token is gone: syncing says so instead of using anyone else's.
    const orphan = engine(undefined, new Credentials(store, SecretBox.fromKey(Buffer.alloc(32, 9)), registry));
    await expect(orphan.run(hub().mapId)).rejects.toThrow(/No Vikunja token for u1: connect it in the menu → Vikunja/);
    expect(await orphan.request(hub().mapId, { action: 'status' }, bob, 'web')).toMatch(/by u1 \(no token: connect it in the menu → Vikunja\)/);
    await orphan.stop();
  });
});

describe('/vk commands', () => {
  const d = (): Doc => seedDoc(new Date());
  it('exist only when the server has Vikunja', () => {
    expect(parse('/tasks status', d())).toMatchObject({ ok: false, error: 'No task service is configured on this server' });
    expect(parse('/vk status', d())).toMatchObject({ ok: false, error: 'Unknown command: vk' });
    expect(parse('/vk bind "Ops"', d(), { providers })).toMatchObject({ ok: true, cmd: { verb: 'tasks', args: { action: 'bind', provider: 'vikunja', name: 'Ops' } }, preview: 'VIKUNJA BIND OPS' });
    expect(parse('/vk sync', d(), { providers })).toMatchObject({ ok: false, error: 'This map is not bound to a task service: /tasks bind "‹project›"' });
    expect(parse('/vk frobnicate', d(), { providers })).toMatchObject({ ok: false });
  });
  it('users may submit only unbind; the rest is the server’s', () => {
    expect(() => hub().submit(user.id, 'web', crypto.randomUUID(), { verb: 'vk', args: { action: 'bound', project: 1, title: 'X', sectors: {} } })).toThrow('Invalid or privileged command');
    expect(() => hub().submit(user.id, 'web', crypto.randomUUID(), { verb: 'tasks', args: { action: 'bound', provider: 'vikunja', label: 'Vikunja', root: '1', title: 'X', containers: {} } })).toThrow('Invalid or privileged command');
  });
  it('notes round-trip through Vikunja HTML', () => {
    for (const note of ['One line', 'Two\nlines', 'a < b & "c"']) expect(htmlToText(textToHtml(note))).toBe(note);
    expect(htmlToText('<p>Hello <strong>there</strong></p><ul><li>one</li><li>two</li></ul>')).toBe('Hello there\none\ntwo');
  });
});
