// Task sync against the real Asana, through HttpAsApi and the engine. Opt-in: it runs only with ASANA_PAT_TOKEN and
// ASANA_TEST_PROJECT (a project gid) set, with `npm run test:asana-live`, and is skipped otherwise. No workspace,
// project or token is in this file (D16).
//
// It makes only tasks whose names start with `opsmap-live-`, and sections named `opsmap-live-…` for the map's two
// sectors, all in the test project. Tasks and sections already in the project are never written. afterAll deletes
// every task it made (subtasks and orphans too), the sections it made, and the tags it made that did not exist before.
// It prints counts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../server/db';
import { Maps } from '../../server/maps';
import { SecretBox } from '../../server/secrets';
import { AsanaProvider } from '../../server/providers/asana';
import { HttpAsApi, type AsTask } from '../../server/providers/asana/api';
import { IDENTITY_NAMES } from '../../server/providers/identity';
import { STATE_TAGS } from '../../server/providers/asana/adapter';
import { TaskSyncEngine } from '../../server/tasksync/engine';
import { Credentials } from '../../server/tasksync/credentials';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { parse } from '../../src/core/commands/grammar';
import { emptyDoc } from '../../src/core/model/seed';

const TOKEN = process.env.ASANA_PAT_TOKEN ?? '', PROJECT = process.env.ASANA_TEST_PROJECT ?? '';
const BASE = 'https://app.asana.com/api/1.0';
const PREFIX = 'opsmap-live-';
const RUN = `${PREFIX}${Date.now().toString(36)}`;
const SECTOR_A = `${RUN}-a`, SECTOR_B = `${RUN}-b`;
/** Tag names opsmap may make: identity and state. */
const OPSMAP_TAGS = new Set([...Object.values(IDENTITY_NAMES).map(n => n[0]), ...Object.values(STATE_TAGS)]);
const user = { id: 'u1', email: 'live@dev.local', name: 'Live', initials: 'LV', color: '#000' };

/** A DELETE the client has no method for (sections and tags are only cleaned up here). 404 counts as gone. */
async function remove(path: string): Promise<void> {
  const res = await fetch(BASE + path, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path.replace(/\d+/g, '‹gid›')}: HTTP ${res.status}`);
}

describe.skipIf(!TOKEN || !PROJECT)('Asana live', () => {
  const api = new HttpAsApi(TOKEN);
  const made = new Set<string>();
  let ws = '', tagsBefore = new Set<string>(), sectionsBefore = new Set<string>(), tasksBefore = new Set<string>();
  let store: Store, maps: Maps, sync: TaskSyncEngine;
  const hub = () => maps.default, doc = () => hub().doc;
  const unit = (d: string) => doc().units.find(u => u.designation === d)!;
  const section = (name: string) => doc().sectors.find(s => s.name === name)!.remote!;
  const track = () => { for (const u of doc().units) if (u.remote) made.add(u.remote); };
  const run = (text: string) => {
    const p = parse(text, doc(), { now: new Date(), providers: [{ id: 'asana', label: 'Asana', aliases: ['asana'], rootNoun: 'project' }] });
    if (!p.ok) throw new Error(p.error);
    return hub().submit(user.id, 'web', crypto.randomUUID(), p.cmd);
  };
  const cycle = async () => { const out = await sync.run(hub().mapId, true); track(); expect(out).not.toMatch(/failed|rate limited/); return out; };
  const task = async (gid: string) => (await api.task(gid))!;
  const inSection = (t: AsTask) => t.memberships.find(m => m.project?.gid === PROJECT)?.section?.gid;

  beforeAll(async () => {
    const project = await api.project(PROJECT);
    ws = project.workspace!.gid;
    tagsBefore = new Set((await api.tags(ws)).map(t => t.gid));
    sectionsBefore = new Set((await api.sections(PROJECT)).map(s => s.gid));
    tasksBefore = new Set((await api.tasks(PROJECT)).map(t => t.gid));
    store = new Store(':memory:');
    maps = new Maps(store, 'UTC');
    const start = emptyDoc('UTC');
    start.sectors = [{ id: 'la', name: SECTOR_A, startDeg: 270, widthDeg: 180 }, { id: 'lb', name: SECTOR_B, startDeg: 90, widthDeg: 180 }];
    hub().import(user.id, start);
    const registry = new ProviderRegistry([new AsanaProvider()]);
    const credentials = new Credentials(store, SecretBox.fromKey(Buffer.alloc(32, 7)), registry);
    await credentials.save(user.id, 'asana', TOKEN);
    // No PUBLIC_URL: no webhooks, polling only. Pushes wait for an explicit cycle.
    sync = new TaskSyncEngine(maps, registry, credentials, undefined, 3_600_000);
  }, 60_000);

  afterAll(async () => {
    await sync?.stop();
    // Every task this run linked, plus anything named opsmap-live-… in the project or under such a task.
    const all = await api.tasks(PROJECT);
    for (const t of all) if (t.name.startsWith(PREFIX) && !tasksBefore.has(t.gid)) made.add(t.gid);
    for (const gid of [...made]) for (const c of await api.subtasks(gid).catch(() => [])) if (c.name.startsWith(PREFIX)) made.add(c.gid);
    let tasks = 0, sections = 0, tags = 0;
    for (const gid of made) {
      const t = await api.task(gid);
      if (!t || !t.name.startsWith(PREFIX) || tasksBefore.has(gid)) continue;
      await api.deleteTask(gid); tasks++;
    }
    for (const s of await api.sections(PROJECT)) if (!sectionsBefore.has(s.gid) && s.name.startsWith(PREFIX)) { await remove(`/sections/${s.gid}`); sections++; }
    for (const t of await api.tags(ws)) if (!tagsBefore.has(t.gid) && OPSMAP_TAGS.has(t.name.toLowerCase())) { await remove(`/tags/${t.gid}`); tags++; }
    console.log(`asana-live cleanup: ${tasks} tasks, ${sections} sections, ${tags} tags deleted`);
    const left = (await api.tasks(PROJECT)).filter(t => !tasksBefore.has(t.gid)).length, leftSections = (await api.sections(PROJECT)).filter(s => !sectionsBefore.has(s.gid)).length;
    console.log(`asana-live after cleanup: ${left} new tasks, ${leftSections} new sections in the project`);
    expect([left, leftSections]).toEqual([0, 0]);
  }, 180_000);

  it('binds by project gid and makes one section per sector, leaving the other sections alone', async () => {
    const log = await sync.request(hub().mapId, { action: 'bind', provider: 'asana', name: PROJECT }, user, 'web');
    expect(log).toMatch(/^ASANA BOUND TO /);
    expect(doc().settings.taskSync).toMatchObject({ provider: 'asana', root: PROJECT });
    const sections = await api.sections(PROJECT);
    for (const name of [SECTOR_A, SECTOR_B]) expect(sections.find(s => s.name === name)?.gid).toBe(section(name));
    for (const gid of sectionsBefore) expect(sections.some(s => s.gid === gid)).toBe(true);
    expect(await sync.request(hub().mapId, { action: 'status' }, user, 'web')).toMatch(/· 2 sectors · 0 units linked · polling every 2 minutes \(/);
  }, 60_000);

  it('makes a task in its sector’s section, and an attached unit a subtask with no project membership', async () => {
    run(`/new "${RUN} solo" as SOLO in ${SECTOR_A}`);
    run(`/new "${RUN} force" as FORCE in ${SECTOR_B}`);
    run(`/new "${RUN} one" as ONE in ${SECTOR_B}`);
    run(`/new "${RUN} two" as TWO in ${SECTOR_B}`);
    run(`/new "${RUN} three" as THREE in ${SECTOR_B}`);
    run(`/new "${RUN} four" as FOUR in ${SECTOR_B}`);
    for (const d of ['ONE', 'TWO', 'THREE', 'FOUR']) run(`/attach ${d} to FORCE`);
    await cycle();
    for (const d of ['SOLO', 'FORCE', 'ONE', 'TWO', 'THREE', 'FOUR']) expect(unit(d).remote).toBeDefined();
    // Made with projects plus memberships: it lands in the section.
    const solo = await task(unit('SOLO').remote!);
    expect(solo.name).toBe(`${RUN} solo`);
    expect(inSection(solo)).toBe(section(SECTOR_A));
    // The pending identity tag, made with a color Asana accepts.
    expect(solo.tags.map(t => t.name)).toContain('pending');
    expect(inSection(await task(unit('FORCE').remote!))).toBe(section(SECTOR_B));
    const members = ['ONE', 'TWO', 'THREE', 'FOUR'];
    for (const d of members) expect(await task(unit(d).remote!)).toMatchObject({ parent: { gid: unit('FORCE').remote }, memberships: [] });
    expect((await api.subtasks(unit('FORCE').remote!)).map(t => t.gid).sort()).toEqual(members.map(d => unit(d).remote).sort());
    // Subtasks are not in the project's list.
    expect((await api.tasks(PROJECT)).some(t => t.gid === unit('ONE').remote)).toBe(false);
    expect(await cycle()).toMatch(/^0 pushed, 0 pulled/);
  }, 120_000);

  it('reads a due_at as its day, and writes a due day with due_on, which clears the time', async () => {
    const gid = unit('SOLO').remote!;
    await api.updateTask(gid, { due_at: '2026-12-18T15:00:00.000Z' });
    await cycle();
    expect(unit('SOLO').dueAt).toBe('2026-12-18T15:00:00.000Z');
    run('/due SOLO 2026-12-20');
    await cycle();
    expect(await task(gid)).toMatchObject({ due_on: '2026-12-20', due_at: null });
  }, 120_000);

  it('a subtask completed in Asana finishes its unit, which stays attached', async () => {
    await api.updateTask(unit('ONE').remote!, { completed: true });
    await cycle();
    expect(unit('ONE')).toMatchObject({ lifecycle: 'done', parentId: unit('FORCE').id });
    expect(unit('FORCE').lifecycle).toBe('todo');
  }, 120_000);

  it('a subtask made top-level in Asana (in no project) is detached and put back in its sector’s section', async () => {
    const two = unit('TWO').remote!;
    await api.setParent(two, null);
    expect(await task(two)).toMatchObject({ parent: null, memberships: [] });
    await cycle();
    expect(unit('TWO').parentId).toBeUndefined();
    expect(inSection(await task(two))).toBe(section(SECTOR_B));
  }, 120_000);

  it('a subtask the user also put in the project stays there, read as a subtask', async () => {
    const three = unit('THREE').remote!;
    await api.addProject(three, PROJECT, section(SECTOR_B));
    expect(await cycle()).toMatch(/^0 pushed, 0 pulled/);
    expect(unit('THREE').parentId).toBe(unit('FORCE').id);
    expect(await task(three)).toMatchObject({ parent: { gid: unit('FORCE').remote } });
  }, 120_000);

  it('deleting a parent in Asana deletes its plain subtasks within seconds; one also in the project survives in its section', async () => {
    const force = unit('FORCE').remote!, three = unit('THREE').remote!, four = unit('FOUR').remote!;
    await api.deleteTask(force);
    // Asana's side: at first the child is top-level in no project; a few seconds later it is gone. The multi-homed one stays.
    for (let i = 0; i < 20 && await api.task(four); i++) await new Promise(r => setTimeout(r, 2000));
    expect(await api.task(four)).toBeNull();
    expect(await task(three)).toMatchObject({ parent: null });
    await cycle();
    expect(unit('FORCE')).toMatchObject({ lifecycle: 'dropped' });
    expect(unit('FORCE').remote).toBeUndefined();
    expect(unit('FOUR')).toMatchObject({ lifecycle: 'dropped' });
    expect(unit('FOUR').remote).toBeUndefined();
    expect(unit('THREE')).toMatchObject({ remote: three, lifecycle: 'todo' });
    expect(inSection(await task(three))).toBe(section(SECTOR_B));
  }, 120_000);

  it('unbinds', async () => {
    run('/tasks unbind');
    expect(doc().settings.taskSync).toBeUndefined();
  }, 60_000);
});
