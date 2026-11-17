// The Asana adapter: the provider contract over FakeAsana, then the sync engine over FakeAsana. Only made-up gids (D16).
import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
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
/** The map a hook URL posts to (the nonce is in the query). */
const mapOf = (target: string) => decodeURIComponent(new URL(target).pathname.split('/hook/')[1]);
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
  // Asana's webhook handshake reaches the engine's hook while createWebhook is still open.
  as.handshake = (target, headers) => sync.webhook('asana', mapOf(target), headers, '', target);
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
});

/** Timers that run only when a test says so, on a clock the test moves. */
class Clock {
  t = Date.parse('2026-11-10T12:00:00Z');
  queue: { id: number; at: number; fn: () => void }[] = [];
  private n = 0;
  now = () => this.t;
  timers = { set: (fn: () => void, ms: number) => { const id = ++this.n; this.queue.push({ id, at: this.t + ms, fn }); return id; }, clear: (id: unknown) => { this.queue = this.queue.filter(x => x.id !== id); } };
}
describe('Asana webhooks', () => {
  let clock: Clock;
  const hookUrl = (base = 'https://opsmap.example') => `${base}/api/tasksync/asana/hook/${hub().mapId}`;
  const clocked = (hookBase: string | undefined = 'https://opsmap.example', resolve = ['93.184.216.34']) =>
    new TaskSyncEngine(maps, registry, credentials, hookBase, 3_600_000, undefined, { resolve: async () => resolve, now: clock.now, timers: clock.timers });
  const hookCalls = () => as.calls.filter(c => /webhook/i.test(c));
  const row = () => store.db.prepare('SELECT * FROM ts_maps WHERE map_id=?').get(hub().mapId) as { state: string | null; hooks: string | null; secret: string } | undefined;
  const only = () => { expect(as.hooks.size).toBe(1); return [...as.hooks.values()][0]; };
  const due = () => clock.queue.filter(x => x.at <= clock.t);
  /** Runs the timers that are due and waits for the cycles they start. */
  const fire = async () => { const now = due(); clock.queue = clock.queue.filter(x => !now.includes(x)); for (const x of now) x.fn(); await (sync as unknown as { chains: Map<string, Promise<unknown>> }).chains.get(hub().mapId); };
  const deliver = (gid: string, events: unknown[]) => { const d = as.delivery(gid, events); return sync.webhook('asana', hub().mapId, d.headers, d.body, d.url); };
  const NONCE = /^\?h=[A-Za-z0-9_-]{22}$/;
  /** The hook URL the engine gave, and the nonce Asana's webhook was made with. */
  const nonced = (target: string) => { expect(target.startsWith(hookUrl())).toBe(true); expect(target.slice(hookUrl().length)).toMatch(NONCE); return target.slice(hookUrl().length + 3); };
  const EVENT = { action: 'changed', resource: { gid: '7001', resource_type: 'task' } };
  let answers: { status: number; headers?: Record<string, string> }[];
  beforeEach(() => {
    clock = new Clock(); answers = [];
    sync = clocked();
    // The handshake reaches the engine's hook while createWebhook is still open, as Asana sends it.
    as.handshake = (target, headers) => { const r = sync.webhook('asana', mapOf(target), headers, '', target); answers.push(r); return r; };
  });

  it('binding registers one webhook on the project at PUBLIC_URL/api/tasksync/asana/hook/<map>: pending until a delivery', async () => {
    await bind();
    const project = doc().settings.taskSync!.root;
    expect(hookCalls()).toEqual([`webhooks ${WS}`, `createWebhook ${project} ${only().target}`]);
    nonced(only().target);
    expect(only()).toMatchObject({ active: true, resource: { gid: project } });
    expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'pending', nextPollMs: 120_000 });
    expect(await status()).toMatch(/· 1 webhook, none delivered yet · polling every 2 minutes · last sync/);
  });
  it('the handshake echoes X-Hook-Secret, and the secret is stored through WebhookResult.store, never shown', async () => {
    await bind();
    const gid = only().gid, secret = as.hookSecrets.get(gid)!, nonce = nonced(only().target);
    expect(answers).toEqual([{ status: 200, headers: { 'X-Hook-Secret': secret }, store: { secret, nonce }, trigger: false }]);
    expect(JSON.parse(row()!.state!)).toEqual({ secret, nonce });
    expect(JSON.parse(row()!.hooks!)).toEqual({ gid, nonce });
    expect(await status()).not.toContain(secret);
    expect(JSON.stringify(await sync.deliveryInfo(hub().mapId))).not.toContain(secret);
  });
  it('a handshake is refused with 401 when no webhook creation for the map is in flight, or one was already answered', async () => {
    await bind();
    const stored = row()!.state;
    const handshake = (secret: string, url = only().target) => sync.webhook('asana', hub().mapId, new Headers({ 'x-hook-secret': secret }), '', url);
    expect(handshake('f'.repeat(32))).toEqual({ status: 401, trigger: false });
    expect(row()!.state).toBe(stored);
    // A second handshake while the creation is still open (after the first stored its secret) is refused too.
    as.hooks.clear();
    as.handshake = (target, headers) => { const first = sync.webhook('asana', hub().mapId, headers, '', target); answers.push(handshake('e'.repeat(32), target)); return first; };
    answers = [];
    await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(answers).toEqual([{ status: 401, trigger: false }]);
    expect(JSON.parse(row()!.state!)).toEqual({ secret: as.hookSecrets.get(only().gid), nonce: nonced(only().target) });
    // A map that is not bound has no handshake to answer.
    expect(sync.webhook('asana', 'nope', new Headers({ 'x-hook-secret': 'a'.repeat(32) }), '', 'https://opsmap.example/api/tasksync/asana/hook/nope')).toEqual({ status: 401, trigger: false });
  });
  it('a forged handshake (no nonce, a wrong one, or first in the window) gets 401 and is never stored; Asana’s still succeeds (C1)', async () => {
    const forged: unknown[] = [];
    as.handshake = (target, headers) => {
      const forge = (url: string) => sync.webhook('asana', hub().mapId, new Headers({ 'x-hook-secret': 'evil'.repeat(8) }), '', url);
      // The attacker knows the map id (it is in the map URL) but not the nonce, which only Asana was sent.
      forged.push(forge(hookUrl()), forge(`${hookUrl()}?h=${'A'.repeat(22)}`), forge(`${hookUrl()}?h=`), forge(`${hookUrl()}?h=${new URL(target).searchParams.get('h')}x`));
      const r = sync.webhook('asana', mapOf(target), headers, '', target); answers.push(r); return r;
    };
    await bind();
    expect(forged).toEqual(Array(4).fill({ status: 401, trigger: false }));
    expect(answers).toHaveLength(1); expect(answers[0].status).toBe(200);
    expect(JSON.parse(row()!.state!).secret).toBe(as.hookSecrets.get(only().gid));
    expect(row()!.state).not.toContain('evil');
    expect(sync.delivery(hub().mapId).mode).toBe('pending');
  });
  it('a secret from a creation that then fails is dropped: the working one stays (C1 b)', async () => {
    await bind();
    const working = row()!.state, gid = only().gid;
    const create = as.createWebhook.bind(as);
    as.createWebhook = async (r, t) => { await create(r, t); throw new AsHttpError(400, 'Asana POST /webhooks: Something went wrong'); };
    as.hooks.clear();
    await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(answers.at(-1)!.status).toBe(200);
    expect(row()!.state).toBe(working);
    expect(sync.delivery(hub().mapId).mode).toBe('failed');
    expect(gid).not.toBe(only().gid);
  });
  it('no createWebhook error carries the nonce, raw or URL-encoded, whatever its status (fix 2)', async () => {
    for (const code of [400, 403, 500, 404]) {
      let nonce = '';
      as.createWebhook = async (_r, t) => {
        nonce = new URL(t).searchParams.get('h')!;
        throw new AsHttpError(code, `Asana POST /webhooks: target ${t} (${encodeURIComponent(t)}) h%3D${nonce} said no`);
      };
      await bind();
      const reason = sync.delivery(hub().mapId).reason;
      expect(nonce).toMatch(/^[\w-]{22}$/);
      expect(reason).not.toContain(nonce);
      expect(reason).toContain('‹target›');
      expect(await status()).not.toContain(nonce);
      run('/tasks unbind'); await sync.run(hub().mapId);
    }
  });
  it('preverify: the stored webhook’s nonce or the handshake in flight passes; anything else, or no map, fails', async () => {
    let during: boolean[] = [];
    as.handshake = (target, headers) => { during = [sync.preverify('asana', hub().mapId, target), sync.preverify('asana', hub().mapId, hookUrl())]; return sync.webhook('asana', mapOf(target), headers, '', target); };
    await bind();
    expect(during).toEqual([true, false]);
    const target = only().target;
    expect(sync.preverify('asana', hub().mapId, target)).toBe(true);
    for (const url of [hookUrl(), `${hookUrl()}?h=${'C'.repeat(22)}`, `${target}x`]) expect(sync.preverify('asana', hub().mapId, url)).toBe(false);
    expect(sync.preverify('asana', 'nope', target)).toBe(false);
    expect(sync.preverify('vikunja', hub().mapId, target)).toBe(false);
    run('/tasks unbind'); await sync.run(hub().mapId);
    expect(sync.preverify('asana', hub().mapId, target)).toBe(false);
  });
  it('a createWebhook error comes back fresh: no cause, nothing else that could hold the URL', async () => {
    as.createWebhook = async (_r, t) => { const e = new AsHttpError(500, 'Asana POST /webhooks: Server Error'); Object.assign(e, { cause: new Error(t), target: t }); throw e; };
    as.workspace(WS); const project = await as.createProject(WS, 'Hooks');
    const error = await new AsanaProvider(() => as).connect(TOKEN).ensureWebhooks!({ id: project.gid, title: 'Hooks' }, [], hookUrl(), 's'.repeat(64), null, false).then(() => undefined, (e: unknown) => e as Error & { cause?: unknown });
    expect(error!.message).toBe('Asana POST /webhooks: Server Error');
    expect(error!.cause).toBeUndefined();
    expect(JSON.stringify(Object.entries(error!))).not.toContain('?h=');
  });
  it('a signed delivery to the bare hook URL or another nonce gets 401 (C1)', async () => {
    await bind(); clock.queue = [];
    const d = as.delivery(only().gid, [EVENT]);
    for (const url of [hookUrl(), `${hookUrl()}?h=${'B'.repeat(22)}`, `${only().target}x`, `${hookUrl()}?h=x&h=${nonced(only().target)}`]) expect(sync.webhook('asana', hub().mapId, d.headers, d.body, url)).toEqual({ status: 401, trigger: false });
    expect(sync.webhook('asana', hub().mapId, d.headers, d.body)).toEqual({ status: 401, trigger: false });
    expect(sync.delivery(hub().mapId).mode).toBe('pending');
    expect(clock.queue).toEqual([]);
  });
  it('a signed delivery schedules a cycle and makes the mode live; the change arrives', async () => {
    await bind(); clock.queue = [];
    const leak = unit('LEAK').remote!;
    await as.updateTask(leak, { name: 'Roof leak, again' });
    expect(deliver(only().gid, [EVENT])).toMatchObject({ status: 200, trigger: true });
    expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'live', nextPollMs: 600_000 });
    expect(await status()).toMatch(/· 1 webhook · last delivery 12:00:00Z · last sync/);
    expect(clock.queue.map(x => x.at - clock.t)).toEqual([500]);
    clock.t += 500; await fire();
    expect(byTask(leak)!.title).toBe('Roof leak, again');
  });
  it('a heartbeat (events: []) makes the mode live but starts no cycle', async () => {
    await bind(); clock.queue = [];
    expect(deliver(only().gid, [])).toMatchObject({ status: 200, trigger: false });
    expect(sync.delivery(hub().mapId).mode).toBe('live');
    expect(clock.queue).toEqual([]);
  });
  it('unsigned, wrongly signed and tampered deliveries get 401 and change nothing', async () => {
    await bind(); clock.queue = [];
    const body = JSON.stringify({ events: [EVENT] }), good = as.delivery(only().gid, [EVENT]);
    const post = (headers: Record<string, string>, text = body) => sync.webhook('asana', hub().mapId, new Headers(headers), text, good.url);
    expect(post({})).toEqual({ status: 401, trigger: false });
    expect(post({ 'x-hook-signature': createHmac('sha256', 'not the secret').update(body).digest('hex') })).toEqual({ status: 401, trigger: false });
    expect(post({ 'x-hook-signature': 'abc' })).toEqual({ status: 401, trigger: false });
    // Compared exactly, as Asana sends it (lowercase hex): no case folding. (Headers itself drops surrounding spaces.)
    const sig = good.headers.get('x-hook-signature')!;
    expect(post({ 'x-hook-signature': sig.toUpperCase() })).toEqual({ status: 401, trigger: false });
    expect(post({ 'x-hook-signature': `${sig}00` })).toEqual({ status: 401, trigger: false });
    expect(post({ 'x-hook-signature': sig.slice(0, -2) })).toEqual({ status: 401, trigger: false });
    expect(post({ 'x-hook-signature': sig })).toMatchObject({ status: 200 });
    clock.queue = []; store.db.prepare('UPDATE ts_maps SET last_delivery=NULL').run();
    expect(post({ 'x-hook-signature': good.headers.get('x-hook-signature')! }, body.replace('changed', 'removed'))).toEqual({ status: 401, trigger: false });
    // The signature is over the body exactly as received: the same JSON spaced differently is not the signed body.
    expect(post({ 'x-hook-signature': good.headers.get('x-hook-signature')! }, JSON.stringify({ events: [EVENT] }, null, 1))).toEqual({ status: 401, trigger: false });
    expect(sync.delivery(hub().mapId).mode).toBe('pending');
    expect(clock.queue).toEqual([]);
  });
  it('a webhook deleted in Asana is made again on /tasks sync, and otherwise at the 10-minute check', async () => {
    await bind();
    as.hooks.clear(); as.calls.length = 0;
    await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(hookCalls().filter(c => c.startsWith('createWebhook'))).toHaveLength(1);
    nonced(only().target);
    as.hooks.clear(); as.calls.length = 0;
    clock.t += 9 * 60_000; await sync.run(hub().mapId);
    expect(hookCalls()).toEqual([]);
    clock.t += 60_000; await sync.run(hub().mapId);
    expect(hookCalls().filter(c => c.startsWith('createWebhook'))).toHaveLength(1);
    expect(sync.delivery(hub().mapId).mode).toBe('pending');
  });
  it('a webhook Asana deactivated is deleted and made again at the next check, with its new secret', async () => {
    await bind();
    const old = only().gid; as.deactivate(old); as.calls.length = 0;
    clock.t += 10 * 60_000; await sync.run(hub().mapId);
    const fresh = only();
    expect(hookCalls()).toEqual([`webhooks ${WS}`, `deleteWebhook ${old}`, `createWebhook ${doc().settings.taskSync!.root} ${fresh.target}`]);
    expect(fresh).toMatchObject({ active: true });
    expect(JSON.parse(row()!.state!)).toEqual({ secret: as.hookSecrets.get(fresh.gid), nonce: nonced(fresh.target) });
    expect(deliver(fresh.gid, [EVENT]).status).toBe(200);
  });
  it('a handshake Asana never gets an answer to: failed (not a refused token), polling every 2 minutes, retried later', async () => {
    for (const code of [400, 403] as const) {
      as.handshakeUnanswered = code;
      await bind();
      expect(as.hooks.size).toBe(0);
      expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'failed', nextPollMs: 120_000 });
      expect(await status()).toMatch(/webhooks failed: Asana could not complete the webhook handshake with PUBLIC_URL \(HTTP 40[03]: The remote server did not respond with the handshake secret\.\), retrying at \d\d:\d\d:\d\dZ · polling every 2 minutes/);
      expect(await status()).not.toMatch(/no token|last error/);
      run('/tasks unbind'); await sync.run(hub().mapId);
    }
    as.handshakeUnanswered = false;
    await bind(); clock.t += 10 * 60_000; await sync.run(hub().mapId);
    expect(sync.delivery(hub().mapId).mode).toBe('pending');
    expect(as.hooks.size).toBe(1);
  });
  it('unbinding deletes the webhook', async () => {
    await bind(); const gid = only().gid;
    run('/tasks unbind'); await sync.run(hub().mapId);
    expect(as.hooks.size).toBe(0);
    expect(hookCalls()).toContain(`deleteWebhook ${gid}`);
    expect(row()).toBeUndefined();
  });
  it('deleting the map removes its webhook', async () => {
    const info = maps.create(user.id, 'Second');
    await sync.request(info.id, { action: 'bind', name: 'Second' }, user, 'web');
    const gid = only().gid;
    expect(only().target).toMatch(new RegExp(`^https://opsmap\\.example/api/tasksync/asana/hook/${info.id}\\?h=[\\w-]{22}$`));
    maps.remove(info.id);
    await new Promise(r => setTimeout(r, 20));
    expect(as.hooks.size).toBe(0);
    expect(hookCalls()).toContain(`deleteWebhook ${gid}`);
    expect(store.db.prepare('SELECT * FROM ts_maps WHERE map_id=?').get(info.id)).toBeUndefined();
  });
  it.each([
    ['loopback', 'http://127.0.0.1:8080', ['127.0.0.1'], 'PUBLIC_URL is a loopback address'],
    ['a .ts.net name (100.x)', 'https://opsmap.ribbon.ts.net', ['100.101.1.2'], 'PUBLIC_URL is a private name (.ts.net)'],
    ['an http LAN address', 'http://192.168.1.5:8080', ['192.168.1.5'], 'PUBLIC_URL is a private address (192.168.1.5)'],
  ])('PUBLIC_URL %s: no webhook calls, status says why, and a rename arrives after one pollMs (Review Focus 6)', async (_name, base, ips, why) => {
    sync = clocked(base, ips);
    await bind();
    expect(as.calls.filter(c => c.startsWith('createWebhook'))).toEqual([]);
    expect(hookCalls()).toEqual([]);
    expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'off', nextPollMs: 120_000 });
    expect(await status()).toMatch(new RegExp(`^ASANA: .* · polling every 2 minutes \\(webhooks off: Asana needs a public HTTPS address; ${why.replace(/[().]/g, '\\$&')}\\) · last sync`));
    const leak = unit('LEAK').remote!;
    await as.updateTask(leak, { name: 'Renamed in Asana' });
    clock.queue = []; sync.poll(); expect(due()).toEqual([]);
    clock.t += 120_000; sync.poll(); await fire();
    expect(byTask(leak)!.title).toBe('Renamed in Asana');
  });
  it('a live webhook is deleted at the next check once PUBLIC_URL is private (a restart with a new config): off', async () => {
    await bind();
    const gid = only().gid; deliver(gid, [EVENT]);
    expect(sync.delivery(hub().mapId).mode).toBe('live');
    await sync.stop();
    sync = clocked('https://opsmap.ribbon.ts.net', ['100.101.1.2']); as.calls.length = 0;
    await sync.run(hub().mapId);
    expect(hookCalls()).toEqual([`deleteWebhook ${gid}`]);
    expect(as.hooks.size).toBe(0);
    expect(row()).toMatchObject({ hooks: null, state: null });
    expect(sync.delivery(hub().mapId)).toMatchObject({ mode: 'off', nextPollMs: 120_000 });
    expect(await status()).toMatch(/polling every 2 minutes \(webhooks off: Asana needs a public HTTPS address; PUBLIC_URL is a private name \(\.ts\.net\)\)/);
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

describe('Asana subtasks', () => {
  const root = () => doc().settings.taskSync!.root;
  const sectionOf = (d: string) => doc().sectors.find(s => s.id === unit(d).sectorId)!.remote!;
  const parentWrites = () => as.calls.filter(c => /^(setParent|removeProject|addProject) /.test(c));
  it('binding pushes existing attachments as subtasks: the parent is the task force’s task, with no project membership', async () => {
    await bind();
    const move = taskOf('MOVE');
    expect(move.memberships).toEqual([{ project: root(), section: sectionOf('MOVE') }]);
    for (const d of ['PACKING', 'MOVERS']) {
      expect(taskOf(d)).toMatchObject({ parent: move.gid, memberships: [] });
      expect(as.calls).toContain(`createTask ${unit(d).title} under ${move.gid}`);
      expect(as.calls).not.toContain(`createTask ${unit(d).title}`);
    }
    expect(parentWrites()).toEqual([]);
    as.calls.length = 0;
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(writes()).toEqual([]);
  });
  it('a refused parent with nothing agreed yet keeps the service’s attachment: a later opsmap edit pushes no parent', async () => {
    await bind();
    run('/attach FILES to MOVE');
    run('/attach LANDLORD to FILES');
    run('/attach TOOLS to LANDLORD');
    await sync.run(hub().mapId);
    const files = unit('FILES').remote!, tools = unit('TOOLS').remote!;
    await as.setParent(files, tools);
    as.tick(600_000);
    // Nothing agreed on parents yet, as in the first relations cycle after a rebind.
    sync.tables.setRelations(hub().mapId, { parents: {}, edges: [], refused: [] });
    expect(await sync.run(hub().mapId)).toMatch(/1 failed: FILES: Attachment would create a cycle/);
    run('/rename FILES "Sort the downloads"');
    as.tasksById.get(files)!.modified = Date.now() - 3_600_000;   // the opsmap edit is the newer change
    as.calls.length = 0;
    expect(await sync.run(hub().mapId)).not.toMatch(/failed/);
    expect(parentWrites()).toEqual([]);
    expect(as.tasksById.get(files)).toMatchObject({ parent: tools, name: 'Sort the downloads' });
    expect(unit('FILES').parentId).toBe('move');
  });
  it('a multi-homed subtask whose parent is not in the list (done long ago) still has its new children read', async () => {
    await bind();
    const tools = unit('TOOLS').remote!, move = unit('MOVE').remote!;
    await as.setParent(tools, move);   // multi-homed: keeps its section
    await sync.run(hub().mapId);
    await as.updateTask(move, { completed: true }); as.tasksById.get(move)!.completedAt = Date.now() - 8 * 86_400_000;
    await sync.run(hub().mapId);
    const kid = await as.createTask({ name: 'Try the trial', parent: tools });
    as.calls.length = 0;
    await sync.run(hub().mapId);
    expect(as.calls).toContain(`subtasks ${tools}`);
    expect(byTask(kid.gid)).toMatchObject({ parentId: 'tools', sectorId: unit('TOOLS').sectorId });
  });
  it('binding again after /tasks unbind links the subtasks by title under their parent, with no duplicates', async () => {
    await bind();
    const before = as.tasksById.size, packing = unit('PACKING').remote;
    run('/tasks unbind');
    expect(unit('PACKING').remote).toBeUndefined();
    await bind();
    expect(as.tasksById.size).toBe(before);
    expect(unit('PACKING').remote).toBe(packing);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled, 0 tasks created, 0 new units$/);
  });
  it('a new task force with a new member in one cycle: the parent is made first, then the child only as its subtask', async () => {
    await bind();
    run('/new "Plan the party" in Family near as PARTY');
    run('/new "Order the cake" in Family near as CAKE');
    run('/attach CAKE to PARTY');
    as.calls.length = 0;
    await sync.run(hub().mapId);
    const party = taskOf('PARTY'), cake = taskOf('CAKE');
    const made = as.calls.filter(c => c.startsWith('createTask '));
    expect(made).toEqual(['createTask Plan the party', `createTask Order the cake under ${party.gid}`]);
    expect(cake).toMatchObject({ parent: party.gid, memberships: [] });
    expect(parentWrites()).toEqual([]);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('/attach makes the task a subtask; /detach puts it back in its sector’s section in the same cycle', async () => {
    await bind();
    run('/attach TOOLS to MOVE');
    await sync.run(hub().mapId);
    expect(taskOf('TOOLS')).toMatchObject({ parent: unit('MOVE').remote, memberships: [] });
    expect(as.calls).toContain(`removeProject ${unit('TOOLS').remote} ${root()}`);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
    run('/detach TOOLS');
    await sync.run(hub().mapId);
    expect(taskOf('TOOLS')).toMatchObject({ parent: null, memberships: [{ project: root(), section: sectionOf('TOOLS') }] });
    as.calls.length = 0;
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(writes()).toEqual([]);
  });
  it('a subtask made in Asana under a linked task arrives attached, in the parent unit’s sector', async () => {
    await bind();
    const kid = await as.createTask({ name: 'Book the van', parent: unit('MOVE').remote! });
    const before = doc().log.length;
    await sync.run(hub().mapId);
    expect(byTask(kid.gid)).toMatchObject({ title: 'Book the van', sectorId: unit('MOVE').sectorId, parentId: unit('MOVE').id });
    const logs = doc().log.slice(before).map(l => l.text).join('\n');
    expect(logs).toMatch(new RegExp(`^ASANA NEW ${byTask(kid.gid)!.designation}`, 'm'));
    expect(logs).toMatch(new RegExp(`ATTACHED TO TF MOVE`));
    // It stays a plain subtask.
    await sync.run(hub().mapId);
    expect(as.tasksById.get(kid.gid)!.memberships).toEqual([]);
    expect(parentWrites().filter(c => c.includes(kid.gid))).toEqual([]);
  });
  it('a new parent in Asana re-attaches the unit; made top-level, it is detached and put back in its section', async () => {
    await bind();
    const packing = unit('PACKING').remote!;
    await as.setParent(packing, unit('TOOLS').remote!);
    await sync.run(hub().mapId);
    expect(unit('PACKING').parentId).toBe(unit('TOOLS').id);
    // Top-level again: Asana leaves it in no project.
    await as.setParent(packing, null);
    await sync.run(hub().mapId);
    expect(unit('PACKING').parentId).toBeUndefined();
    expect(taskOf('PACKING').memberships).toEqual([{ project: root(), section: sectionOf('PACKING') }]);
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('nested subtasks become nested task forces, 5 levels down at most, each read once', async () => {
    await bind();
    const chain: string[] = [];
    let parent = unit('LEAK').remote!;
    for (let i = 1; i <= 7; i++) { const t = await as.createTask({ name: `Level ${i}`, parent }); chain.push(t.gid); parent = t.gid; }
    as.calls.length = 0;
    await sync.run(hub().mapId);
    let up = unit('LEAK');
    for (const gid of chain.slice(0, 5)) { const u = byTask(gid)!; expect(u).toMatchObject({ parentId: up.id, sectorId: 'household' }); up = u; }
    for (const gid of chain.slice(0, 4)) expect(byTask(gid)!.taskForce).toBe(true);
    expect(byTask(chain[5])).toBeUndefined();
    expect(byTask(chain[6])).toBeUndefined();
    const reads = as.calls.filter(c => c.startsWith('subtasks '));
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads).not.toContain(`subtasks ${chain[4]}`);
  });
  it('a subtask under a task outside the project, or under an unlinked task, is ignored', async () => {
    await bind();
    const other = await as.createProject(WS, 'Elsewhere'), outside = as.add(other.gid, { name: 'Outside' });
    const stray = await as.createTask({ name: 'Stray', parent: outside.gid });
    await as.addProject(stray.gid, root(), sector('Work').remote);   // multi-homed into this project
    const home = await as.createSection(root(), 'Home'), unlinked = as.add(root(), { name: 'Chores', section: home.gid });
    await as.createTask({ name: 'Unlinked child', parent: unlinked.gid });
    as.calls.length = 0;
    await sync.run(hub().mapId);
    expect(doc().units.some(u => u.title === 'Stray' || u.title === 'Unlinked child' || u.title === 'Chores')).toBe(false);
    expect(as.calls).not.toContain(`subtasks ${stray.gid}`);
    expect(writes()).toEqual([]);
  });
  it('completing the parent finishes the task force; the child stays attached and open (Review Focus 2)', async () => {
    await bind();
    const before = unit('PACKING').lifecycle;
    await as.updateTask(unit('MOVE').remote!, { completed: true });
    await sync.run(hub().mapId);
    expect(unit('MOVE').lifecycle).toBe('done');
    expect(unit('PACKING')).toMatchObject({ parentId: 'move', lifecycle: before });
    expect(taskOf('PACKING')).toMatchObject({ completed: false, parent: unit('MOVE').remote });
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('deleting the parent drops the task force; children that survive stay attached, open and back in their section', async () => {
    await bind();
    as.onParentDelete = 'orphan';
    const packing = unit('PACKING').remote!, before = unit('PACKING').lifecycle;
    await as.deleteTask(unit('MOVE').remote!);
    as.calls.length = 0;
    await sync.run(hub().mapId);
    expect(unit('MOVE')).toMatchObject({ lifecycle: 'dropped' });
    expect(unit('MOVE').remote).toBeUndefined();
    expect(as.calls).toContain(`task ${packing}`);
    expect(unit('PACKING')).toMatchObject({ parentId: 'move', lifecycle: before, remote: packing });
    expect(as.tasksById.get(packing)).toMatchObject({ parent: null, completed: false, memberships: [{ project: root(), section: sectionOf('PACKING') }] });
    expect(await sync.run(hub().mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('deleting the parent with its subtasks: each child is read again, and only one that is gone is dropped', async () => {
    await bind();
    as.onParentDelete = 'cascade';
    const packing = unit('PACKING').remote!, movers = unit('MOVERS').remote!;
    await as.deleteTask(unit('MOVE').remote!);
    as.calls.length = 0;
    await sync.run(hub().mapId);
    for (const gid of [packing, movers]) expect(as.calls).toContain(`task ${gid}`);
    for (const d of ['MOVE', 'PACKING', 'MOVERS']) { expect(unit(d).lifecycle).toBe('dropped'); expect(unit(d).remote).toBeUndefined(); }
    expect(unit('LEAK').remote).toBeDefined();
  });
  it('a multi-homed subtask is read as a subtask and stays in the project (Review Focus 3)', async () => {
    await bind();
    const tools = unit('TOOLS').remote!, move = unit('MOVE').remote!;
    // Made a subtask in Asana: it keeps its section, so it is in the project list and under MOVE.
    await as.setParent(tools, move);
    as.calls.length = 0;
    await sync.run(hub().mapId);
    expect(unit('TOOLS').parentId).toBe('move');
    expect(doc().units.filter(u => u.remote === tools)).toHaveLength(1);
    expect(as.calls.filter(c => c === `subtasks ${move}`)).toHaveLength(1);
    run('/rename TOOLS "Review the new tool"');
    await sync.run(hub().mapId);
    expect(as.tasksById.get(tools)).toMatchObject({ name: 'Review the new tool', parent: move });
    expect(as.tasksById.get(tools)!.memberships.map(m => m.project)).toEqual([root()]);
    expect(as.calls.filter(c => c.startsWith('removeProject'))).toEqual([]);
    // Moved to another task force from opsmap: still the user's multi-homing, so it stays in the project.
    run('/attach TOOLS to LEAK');
    await sync.run(hub().mapId);
    expect(as.tasksById.get(tools)).toMatchObject({ parent: unit('LEAK').remote });
    expect(as.tasksById.get(tools)!.memberships.map(m => m.project)).toEqual([root()]);
  });
  it('a parent or section write returns the task as Asana has it now, with a fresh modified_at', async () => {
    const s = new AsanaProvider(() => as).connect(TOKEN), root = await s.resolveRoot('Ops');
    const c = await s.ensureContainers(root, [{ sectorId: 'w', name: 'Work' }], {});
    const parent = await s.createTask(root, { title: 'Parent', container: c.w }, 'UTC'), child = await s.createTask(root, { title: 'Child', container: c.w }, 'UTC');
    as.tick(60_000);
    const attached = await s.updateTask(root, child, { parent: parent.id }, 'UTC');
    expect(attached).toMatchObject({ parent: parent.id, container: null, updatedAt: new Date(as.tasksById.get(child.id)!.modified).toISOString() });
    expect(Date.parse(attached.updatedAt)).toBeGreaterThan(Date.parse(child.updatedAt));
    as.tick(60_000);
    const detached = await s.updateTask(root, attached, { parent: null, container: c.w }, 'UTC');
    expect(detached).toMatchObject({ parent: null, container: c.w, updatedAt: new Date(as.tasksById.get(child.id)!.modified).toISOString() });
    expect(Date.parse(detached.updatedAt)).toBeGreaterThan(Date.parse(attached.updatedAt));
  });
  it('an attachment opsmap refuses (a cycle) is reported once by /tasks sync and left in Asana', async () => {
    await bind();
    // TOOLS → LANDLORD (a person, not synced) → FILES in opsmap; then in Asana FILES becomes a subtask of TOOLS.
    run('/attach TOOLS to LANDLORD');
    run('/attach LANDLORD to FILES');
    await sync.run(hub().mapId);
    const files = unit('FILES').remote!, tools = unit('TOOLS').remote!;
    await as.setParent(files, tools);
    const first = await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(first).toMatch(/1 failed: FILES: Attachment would create a cycle/);
    as.calls.length = 0;
    const second = await sync.request(hub().mapId, { action: 'sync' }, user, 'web');
    expect(second).not.toMatch(/failed/);
    expect(await status()).not.toMatch(/last error/);
    expect(as.tasksById.get(files)!.parent).toBe(tools);
    expect(parentWrites()).toEqual([]);
    expect(unit('FILES').parentId).toBeUndefined();
    // The cycle gone in opsmap: the next cycle attaches it.
    run('/detach LANDLORD');
    await sync.run(hub().mapId);
    expect(unit('FILES').parentId).toBe('tools');
  });
});
