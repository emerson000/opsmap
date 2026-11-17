// The Asana adapter: the provider contract over FakeAsana, then the sync engine over FakeAsana. Only made-up gids (D16).
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../server/db';
import { Maps } from '../../../server/maps';
import { SecretBox } from '../../../server/secrets';
import { AsanaProvider, asanaProvider } from '../../../server/providers/asana';
import { AsHttpError } from '../../../server/providers/asana/api';
import { PROVIDERS } from '../../../server/providers';
import { TaskSyncEngine } from '../../../server/tasksync/engine';
import { Credentials } from '../../../server/tasksync/credentials';
import { ProviderRegistry } from '../../../server/tasksync/registry';
import { RateLimited, RemoteAuthError } from '../../../server/tasksync/contract';
import { dayInstant } from '../../../server/tasksync/merge';
import { parse } from '../../../src/core/commands/grammar';
import { seedDoc } from '../../../src/core/model/seed';
import { DEFAULT_TZ } from '../../../src/core/model/time';
import { FakeAsana, TAG_COLORS } from './fake-asana';
import { providerContract } from '../provider-contract';

const TOKEN = '2/1001/5000:fake0000token';
const WS = '1001';

providerContract('asana over FakeAsana', () => {
  const as = new FakeAsana(); as.workspace(WS);
  return { provider: new AsanaProvider(() => as), token: TOKEN, deleteRemote: id => as.deleteTask(id) };
});

const user = { id: 'u1', email: 'a@dev.local', name: 'Alice', initials: 'AL', color: '#000' };
let store: Store, maps: Maps, as: FakeAsana, sync: TaskSyncEngine, registry: ProviderRegistry, credentials: Credentials;
const providers = ProviderRegistry.fromEnv({ ASANA_SYNC: '1' }).info();
const hub = () => maps.default;
const doc = () => hub().doc;
const tz = () => doc().settings.tz ?? DEFAULT_TZ;
const unit = (d: string) => doc().units.find(u => u.designation === d)!;
const byTask = (gid: string) => doc().units.find(u => u.remote === gid);
const sector = (name: string) => doc().sectors.find(s => s.name === name)!;
const run = (text: string) => {
  const p = parse(text, doc(), { now: new Date(), providers });
  if (!p.ok) throw new Error(p.error);
  return hub().submit(user.id, 'web', crypto.randomUUID(), p.cmd);
};
const bind = (name = 'Ops', extra: Record<string, unknown> = {}) => sync.request(hub().mapId, { action: 'bind', name, ...extra }, user, 'web');
const status = () => sync.request(hub().mapId, { action: 'status' }, user, 'web');
const taskOf = (d: string) => as.tasksById.get(unit(d).remote!)!;
const tagsOf = (gid: string) => as.tasksById.get(gid)!.tags.map(t => as.tagsById.get(t)!.name).sort();
const writes = () => as.calls.filter(c => !/^(me|projects|project|sections|tasks|subtasks|task|tags|webhooks) /.test(c + ' '));
const engine = (hookBase: string | undefined = 'https://opsmap.example', resolve = ['93.184.216.34']) =>
  new TaskSyncEngine(maps, registry, credentials, hookBase, 3_600_000, undefined, { resolve: async () => resolve });

beforeEach(async () => {
  store = new Store(':memory:');
  maps = new Maps(store, 'Europe/London');
  hub().import(user.id, seedDoc(new Date()));
  as = new FakeAsana(); as.workspace(WS, 'Home Org');
  registry = new ProviderRegistry([new AsanaProvider(() => as)]);
  credentials = new Credentials(store, SecretBox.fromKey(Buffer.alloc(32, 7)), registry);
  await credentials.save(user.id, 'asana', TOKEN);
  sync = engine();
});

describe('Asana provider', () => {
  it('is on with ASANA_SYNC=1 or true, and registered next to Vikunja', () => {
    expect(asanaProvider({})).toBeUndefined();
    expect(asanaProvider({ ASANA_SYNC: '0' })).toBeUndefined();
    expect(asanaProvider({ ASANA_SYNC: '1' })?.descriptor.id).toBe('asana');
    expect(asanaProvider({ ASANA_SYNC: 'true' })?.descriptor.id).toBe('asana');
    expect(ProviderRegistry.fromEnv({ ASANA_SYNC: '1', VIKUNJA_URL: 'https://todo.example' }, PROVIDERS).list().map(p => p.descriptor.id).sort()).toEqual(['asana', 'vikunja']);
  });
  it('has the descriptor and capabilities of the plan', () => {
    const p = new AsanaProvider(() => as);
    expect(p.descriptor).toEqual({
      id: 'asana', label: 'Asana', aliases: ['asana'], rootNoun: 'project', containerNoun: 'section',
      tokenHelp: 'Create a personal access token in Asana (My settings → Apps → Developer apps) and paste it here.',
      urls: { root: 'https://app.asana.com/0/{root}', task: 'https://app.asana.com/0/{root}/{id}' },
    });
    expect([...p.capabilities.fields].sort()).toEqual(['affiliation', 'container', 'due', 'note', 'parent', 'status', 'title']);
    expect(p.capabilities).toMatchObject({ maxTitle: 1024, maxNote: 16000, pollMs: 120_000, idlePollMs: 600_000, webhooks: { https: true, publicAddress: true, handshakeTimeoutMs: 30_000 } });
    expect(p.capabilities.relations.size).toBe(0);
  });
  it('verifies a token with me(): the name is the user name; 401 is a refused token; malformed text makes no call', async () => {
    const p = new AsanaProvider(() => as);
    expect(await p.verify(TOKEN)).toEqual({ username: 'Alice' });
    as.failNext('me', new AsHttpError(401, 'Asana GET /users/me: Not Authorized'));
    await expect(p.verify(TOKEN)).rejects.toBeInstanceOf(RemoteAuthError);
    as.calls.length = 0;
    for (const bad of ['short', 'has a space in it ok', 'x'.repeat(513), `${TOKEN}\n`]) await expect(p.verify(bad)).rejects.toBeInstanceOf(RemoteAuthError);
    expect(as.calls).toEqual([]);
    as.rateLimit('me', 20);
    await expect(p.verify(TOKEN)).rejects.toEqual(new RateLimited(20));
  });
  it('makes every identity and state tag with a color Asana accepts', async () => {
    const s = new AsanaProvider(() => as).connect(TOKEN), root = await s.resolveRoot('Ops');
    const c = await s.ensureContainers(root, [{ sectorId: 'w', name: 'Work' }], {});
    for (const a of ['hostile', 'suspect', 'friend', 'assumed', 'neutral', 'unknown', 'pending'] as const) await s.createTask(root, { title: a, container: c.w, affiliation: a, status: a === 'unknown' ? 'active' : 'blocked' }, 'UTC');
    expect([...as.tagsById.values()].map(t => t.color).every(x => x !== undefined && TAG_COLORS.includes(x))).toBe(true);
    expect([...as.tagsById.values()].find(t => t.name === 'unknown')?.color).toBe('light-yellow');
    expect(as.tagsById.size).toBe(9);
  });
  it('maps refusals: 429 is RateLimited (Retry-After, else 60 s), 401 and 403 a refused token, 404 from getTask null', async () => {
    const s = new AsanaProvider(() => as).connect(TOKEN), root = await s.resolveRoot('Ops');
    as.rateLimit('sections', 30);
    await expect(s.ensureContainers(root, [{ sectorId: 'w', name: 'Work' }], {})).rejects.toEqual(new RateLimited(30));
    as.failNext('sections', new AsHttpError(429, 'Asana GET /projects/x/sections: Rate limit exceeded'));
    await expect(s.ensureContainers(root, [{ sectorId: 'w', name: 'Work' }], {})).rejects.toEqual(new RateLimited(60));
    for (const code of [401, 403]) { as.failNext('task', new AsHttpError(code, 'Asana GET /tasks/1: no')); await expect(s.getTask(root, '1', 'UTC')).rejects.toBeInstanceOf(RemoteAuthError); }
    expect(await s.getTask(root, '999999', 'UTC')).toBeNull();
  });
  it('snapshot reads subtasks recursively, once each, and leaves out tasks done more than 7 days ago', async () => {
    const s = new AsanaProvider(() => as).connect(TOKEN), root = await s.resolveRoot('Ops');
    const c = await s.ensureContainers(root, [{ sectorId: 'w', name: 'Work' }], {});
    const parent = as.add(root.id, { name: 'Parent', section: c.w });
    const child = await as.createTask({ name: 'Child', parent: parent.gid }), grandchild = await as.createTask({ name: 'Grandchild', parent: child.gid });
    // Multi-homed: in the project list and under its parent; read as a subtask, once.
    await as.addProject(child.gid, root.id, c.w);
    const old = as.add(root.id, { name: 'Old', section: c.w, completed: true }); as.tasksById.get(old.gid)!.completedAt = Date.now() - 8 * 86_400_000;
    const snap = await s.snapshot(root, c, 'UTC');
    expect(snap.tasks.map(t => t.title).sort()).toEqual(['Child', 'Grandchild', 'Parent']);
    expect(snap.tasks.find(t => t.id === child.gid)).toMatchObject({ parent: parent.gid, container: null });
    expect(snap.tasks.find(t => t.id === grandchild.gid)).toMatchObject({ parent: child.gid, container: null });
    expect(snap.tasks.find(t => t.id === parent.gid)).toMatchObject({ parent: null, container: c.w });
  });
  it('reads due_on as the day, and due_at as its day in the map zone', async () => {
    const s = new AsanaProvider(() => as).connect(TOKEN), root = await s.resolveRoot('Ops');
    const c = await s.ensureContainers(root, [{ sectorId: 'w', name: 'Work' }], {});
    const day = as.add(root.id, { name: 'Day', section: c.w, due_on: '2026-12-15' });
    const late = as.add(root.id, { name: 'Late', section: c.w, due_at: '2026-12-15T23:30:00.000Z' });
    expect((await s.getTask(root, day.gid, 'Europe/London'))?.due).toBe('2026-12-15');
    expect((await s.getTask(root, late.gid, 'Europe/London'))?.due).toBe('2026-12-15');
    expect((await s.getTask(root, late.gid, 'Europe/Berlin'))?.due).toBe('2026-12-16');
    // A write sets the day and clears the time.
    const t = (await s.getTask(root, late.gid, 'Europe/London'))!;
    await s.updateTask(root, t, { due: '2026-12-20' }, 'Europe/London');
    expect(as.tasksById.get(late.gid)).toMatchObject({ due_on: '2026-12-20', due_at: null });
  });
});

describe('Asana sync: binding', () => {
  it('binding by name creates a section per sector and keeps Home, which status lists', async () => {
    const project = await as.createProject(WS, 'Ops'), home = await as.createSection(project.gid, 'Home');
    const groceries = as.add(project.gid, { name: 'Groceries', section: home.gid });
    as.add(project.gid, { name: 'Done long ago', section: home.gid, completed: true });
    const log = await bind('ops');
    expect(log).toMatch(/^ASANA BOUND TO OPS — \d+ pushed, \d+ pulled, \d+ tasks created, 0 new units$/);
    expect(doc().settings.taskSync).toEqual({ provider: 'asana', label: 'Asana', root: project.gid, title: 'Ops', by: user.id });
    const sections = await as.sections(project.gid);
    expect(sections.map(s => s.name).sort()).toEqual(['Family', 'Home', 'Household', 'Productivity', 'Wellness', 'Work']);
    for (const s of doc().sectors) expect(sections.find(x => x.gid === s.remote)?.name).toBe(s.name);
    expect(byTask(groceries.gid)).toBeUndefined();
    // Every open task-like unit has a task in its sector's section.
    const leak = taskOf('LEAK');
    expect(leak.memberships).toEqual([{ project: project.gid, section: sector('Household').remote }]);
    expect(await status()).toMatch(/^ASANA: bound to Ops \(https:\/\/app\.asana\.com\/0\/\d+\) by u1 · 5 sectors · \d+ units linked · .* · not synced: section Home \(1 task\)$/);
  });
  it('creates the project in the only workspace when there is none of that name', async () => {
    await bind('Ops');
    const made = [...as.projectsById.values()].filter(p => p.name === 'Ops');
    expect(made).toHaveLength(1);
    expect(made[0].workspaceGid).toBe(WS);
  });
  it('binding by URL works, and a name found in two workspaces is refused with both gids', async () => {
    as.workspace('1002');
    const a = await as.createProject(WS, 'Ops'), b = await as.createProject('1002', 'Ops');
    await expect(bind('Ops')).rejects.toThrow(new RegExp(`Several Asana projects named Ops: (${a.gid}, ${b.gid}|${b.gid}, ${a.gid})`));
    expect(doc().settings.taskSync).toBeUndefined();
    await bind(`https://app.asana.com/0/${b.gid}/list`);
    expect(doc().settings.taskSync).toMatchObject({ root: b.gid, title: 'Ops' });
  });
  it('a live project wins over an archived one of the same name; with several workspaces a new name needs a URL', async () => {
    const old = await as.createProject(WS, 'Ops'); as.projectsById.get(old.gid)!.archived = true;
    const live = await as.createProject(WS, 'Ops');
    const s = new AsanaProvider(() => as).connect(TOKEN);
    expect(await s.resolveRoot('Ops')).toEqual({ id: live.gid, title: 'Ops' });
    expect(await s.resolveRoot(live.gid)).toEqual({ id: live.gid, title: 'Ops' });
    expect(await s.resolveRoot(`https://app.asana.com/1/${WS}/project/${live.gid}/board`)).toEqual({ id: live.gid, title: 'Ops' });
    as.workspace('1002');
    await expect(s.resolveRoot('Brand new')).rejects.toThrow('Several Asana workspaces: bind by project URL');
  });
});

describe('Asana sync: fields', () => {
  it('pulls name, due day (due_at read as the local day), notes and completed', async () => {
    await bind();
    const leak = unit('LEAK').remote!, tools = unit('TOOLS').remote!;
    await as.updateTask(leak, { name: 'Roof leak (attic)', notes: 'Call the roofer', due_on: '2026-12-20' });
    await as.updateTask(tools, { due_at: '2026-12-15T23:30:00.000Z' });
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 2 pulled/);
    expect(unit('LEAK')).toMatchObject({ title: 'Roof leak (attic)', note: 'Call the roofer', dueAt: dayInstant('2026-12-20', tz()) });
    expect(unit('TOOLS').dueAt).toBe('2026-12-15T23:30:00.000Z');
    expect(doc().log.at(-1)?.text).toMatch(/^ASANA: /);
    expect(doc().log.at(-1)?.via).toBe('asana');
    await as.updateTask(unit('Q4RPT').remote!, { completed: true });
    await sync.run(hub().mapId);
    expect(unit('Q4RPT').lifecycle).toBe('done');
    // Nothing echoes back.
    as.calls.length = 0;
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(writes()).toEqual([]);
  });
  it('pushes rename, due, note, done and a sector move', async () => {
    await bind();
    run('/rename LEAK "Fix the roof leak"');
    run('/due LEAK 2026-12-20');
    run('/note LEAK "Roofer on Tuesday"');
    run('/done MOVE');
    await sync.run(hub().mapId);
    expect(taskOf('LEAK')).toMatchObject({ name: 'Fix the roof leak', due_on: '2026-12-20', due_at: null, notes: 'Roofer on Tuesday' });
    expect(taskOf('MOVE').completed).toBe(true);
    run('/move LEAK to Work near');
    await sync.run(hub().mapId);
    expect(taskOf('LEAK').memberships).toEqual([{ project: doc().settings.taskSync!.root, section: sector('Work').remote }]);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('a task moved to another sector section moves the unit; one moved to Home goes back', async () => {
    await bind();
    const root = doc().settings.taskSync!.root;
    await as.addToSection(sector('Work').remote!, unit('LEAK').remote!);
    await sync.run(hub().mapId);
    expect(unit('LEAK').sectorId).toBe('work');
    const home = await as.createSection(root, 'Home');
    await as.addToSection(home.gid, unit('LEAK').remote!);
    await sync.run(hub().mapId);
    expect(unit('LEAK').sectorId).toBe('work');
    expect(taskOf('LEAK').memberships).toEqual([{ project: root, section: sector('Work').remote }]);
  });
  it('a task made in Asana arrives as a pending unit in its sector; done ones do not', async () => {
    await bind();
    const root = doc().settings.taskSync!.root;
    const t = as.add(root, { name: 'Book dentist', section: sector('Family').remote, notes: 'Ask about Saturday', due_on: '2026-11-20' });
    as.add(root, { name: 'Old thing', section: sector('Family').remote, completed: true });
    expect(await sync.run(hub().mapId)).toMatch(/1 new units$/);
    expect(byTask(t.gid)).toMatchObject({ title: 'Book dentist', affiliation: 'pending', sectorId: 'family', note: 'Ask about Saturday', dueAt: dayInstant('2026-11-20', tz()) });
    expect(doc().units.some(x => x.title === 'Old thing')).toBe(false);
    expect(doc().log.at(-1)?.text).toMatch(/^ASANA NEW /);
  });
  it('the tags doing and blocked map to state; a state written removes the other; tags are reused by name', async () => {
    const doing = await as.createTag(WS, 'Doing');
    as.calls.length = 0;
    await bind();
    // Created with their state, the existing Doing tag reused; blocked made once.
    expect(tagsOf(unit('Q4RPT').remote!)).toContain('Doing');
    expect(tagsOf(unit('PASSPORT').remote!)).toContain('blocked');
    expect(as.calls.filter(c => c.startsWith('createTag') && /doing/i.test(c))).toEqual([]);
    expect(as.calls.filter(c => c.startsWith('createTag') && /blocked/.test(c))).toHaveLength(1);
    const tools = unit('TOOLS').remote!, blocked = [...as.tagsById.values()].find(t => t.name === 'blocked')!;
    await as.addTag(tools, doing.gid);
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('active');
    await as.addTag(tools, blocked.gid); await as.removeTag(tools, doing.gid);
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('blocked');
    await as.removeTag(tools, blocked.gid);
    await sync.run(hub().mapId);
    expect(unit('TOOLS').lifecycle).toBe('todo');
    run('/block Q4RPT by "Waiting"');
    await sync.run(hub().mapId);
    expect(tagsOf(unit('Q4RPT').remote!).filter(t => /doing|blocked/i.test(t))).toEqual(['blocked']);
    run('/unblock Q4RPT');
    await sync.run(hub().mapId);
    expect(unit('Q4RPT').lifecycle).toBe('active');
    expect(tagsOf(unit('Q4RPT').remote!).filter(t => /doing|blocked/i.test(t))).toEqual(['Doing']);
  });
  it('identity tags are created on first use, and /id swaps them', async () => {
    await bind();
    expect(tagsOf(unit('LEAK').remote!)).toContain('hostile');
    expect(tagsOf(unit('IRSRSP').remote!)).toContain('friendly');
    expect(as.calls.filter(c => c.startsWith(`createTag ${WS} hostile`))).toHaveLength(1);
    expect([...as.tagsById.values()].find(t => t.name === 'hostile')?.color).toBe('light-red');
    for (const t of as.tagsById.values()) expect(t.workspace).toBe(WS);
    run('/id LEAK friend');
    await sync.run(hub().mapId);
    expect(tagsOf(unit('LEAK').remote!).filter(t => t === 'hostile' || t === 'friendly')).toEqual(['friendly']);
    // An identity tag set in Asana sets the identity.
    const neutral = await as.createTag(WS, 'Neutral'), friendly = [...as.tagsById.values()].find(t => t.name === 'friendly')!;
    await as.removeTag(unit('LEAK').remote!, friendly.gid); await as.addTag(unit('LEAK').remote!, neutral.gid);
    await sync.run(hub().mapId);
    expect(unit('LEAK').affiliation).toBe('neutral');
  });
  it('completed on a hostile runs /done: destroyed', async () => {
    await bind();
    await as.updateTask(unit('IRS').remote!, { completed: true });
    await sync.run(hub().mapId);
    expect(unit('IRS')).toMatchObject({ lifecycle: 'done', condition: 'destroyed' });
    as.calls.length = 0;
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('a dropped unit completes its task, and a remotely deleted task drops its unit', async () => {
    await bind();
    run('/drop TOOLS');
    await sync.run(hub().mapId);
    expect(taskOf('TOOLS').completed).toBe(true);
    const files = unit('FILES').remote!;
    await as.deleteTask(files);
    await sync.run(hub().mapId);
    expect(unit('FILES')).toMatchObject({ lifecycle: 'dropped' });
    expect(unit('FILES').remote).toBeUndefined();
  });
  it('/bda makes no Asana call (no progress field)', async () => {
    await bind();
    run('/bda LEAK 25%');
    as.calls.length = 0;
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(writes()).toEqual([]);
    expect(unit('LEAK').strength).toBe(25);
  });
});

describe('Asana sync: rate limits and delivery', () => {
  it('an HTTP 429 becomes RateLimited; links made so far are kept, and the next cycle finishes with no duplicates', async () => {
    const create = as.createTask.bind(as);
    let n = 0;
    as.createTask = async f => { if (++n === 4) throw new AsHttpError(429, 'Asana POST /tasks: Rate limit exceeded', 30); return create(f); };
    await expect(bind()).rejects.toBeInstanceOf(RateLimited);
    expect(await status()).toMatch(/last error: rate limited, retrying in 30s$/);
    const linked = doc().units.filter(u => u.remote !== undefined).length;
    expect(linked).toBe(3);
    expect(await sync.run(hub().mapId)).toMatch(/tasks created/);
    const names = [...as.tasksById.values()].map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(doc().units.filter(u => u.remote !== undefined).length);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled, 0 tasks created, 0 new units$/);
    expect(await status()).not.toMatch(/last error/);
  });
  it('registers no webhooks: on a LAN address it polls every 2 minutes and says why', async () => {
    sync = engine('http://192.168.1.5:8080', ['192.168.1.5']);
    await bind();
    expect(as.calls.filter(c => /webhook/i.test(c))).toEqual([]);
    expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'off', nextPollMs: 120_000 });
    expect(await status()).toMatch(/polling every 2 minutes \(.*Asana needs a public HTTPS address\)/);
  });
  it('with a public address it polls every 2 minutes, never failing a handshake it did not ask for', async () => {
    await bind();
    expect(as.calls.filter(c => /webhook/i.test(c))).toEqual([]);
    expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'pending', nextPollMs: 120_000 });
  });
});

describe('Asana identity switch (D21)', () => {
  it('with identity off, no hostile tag is ever created or added', async () => {
    await bind('Ops', { off: ['identity'] });
    run('/new hostile "Parking ticket" in Family near as TICKET');
    run('/id TOOLS hostile');
    await sync.run(hub().mapId);
    expect(as.calls.filter(c => /^createTag \d+ (hostile|enemy)/i.test(c))).toEqual([]);
    expect([...as.tagsById.values()].some(t => t.name === 'hostile')).toBe(false);
    expect(as.calls.filter(c => c.startsWith('addTag')).every(c => !/hostile/.test(c))).toBe(true);
    for (const t of as.tasksById.values()) expect(t.tags.map(g => as.tagsById.get(g)!.name)).not.toContain('hostile');
  });
  it('a multi-homed task keeps its other tags and its other project when identity cleanup runs', async () => {
    await bind();
    const other = await as.createProject(WS, 'Shared with the team'), leak = unit('LEAK').remote!;
    await as.addProject(leak, other.gid);
    const errand = await as.createTag(WS, 'errand'); await as.addTag(leak, errand.gid);
    await sync.run(hub().mapId);
    expect(tagsOf(leak)).toEqual(['errand', 'hostile']);
    expect(run('/tasks field identity off').log).toBe('ASANA IDENTITY SYNC OFF');
    await sync.run(hub().mapId);
    expect(tagsOf(leak)).toEqual(['errand']);
    expect(taskOf('LEAK').memberships.map(m => m.project).sort()).toEqual([doc().settings.taskSync!.root, other.gid].sort());
    expect(unit('LEAK').affiliation).toBe('hostile');
    // Other identity tags it did not write stay: a task made in Asana with its own identity tag.
    const hostileTag = [...as.tagsById.values()].find(t => t.name === 'hostile')!;
    const made = as.add(doc().settings.taskSync!.root, { name: 'Parking fine', section: sector('Family').remote });
    await as.addTag(made.gid, hostileTag.gid);
    await sync.run(hub().mapId);
    await sync.run(hub().mapId);
    expect(tagsOf(made.gid)).toEqual(['hostile']);
  });
});
