import { describe, expect, it } from 'vitest';
import { AsHttpError } from '../../../server/providers/asana/api';
import { FakeAsana } from './fake-asana';

// The fake must keep the behaviors seen in the 2026-11-17 spike, because adapter tests rely on them.
const setup = async () => {
  const a = new FakeAsana(), ws = a.workspace('1001'), p = await a.createProject(ws, 'Ops'), s = await a.createSection(p.gid, 'Home');
  return { a, ws, p, s };
};
describe('FakeAsana (spike behavior)', () => {
  it('project lists omit plain subtasks, and a subtask has no memberships', async () => {
    const { a, p, s } = await setup();
    const top = await a.createTask({ name: 'P', projects: [p.gid] }); await a.addToSection(s.gid, top.gid);
    const kid = await a.createTask({ name: 'C', parent: top.gid });
    expect(kid.memberships).toEqual([]); expect(kid.parent?.gid).toBe(top.gid);
    expect((await a.tasks(p.gid)).map(t => t.name)).toEqual(['P']);
    expect((await a.subtasks(top.gid)).map(t => t.name)).toEqual(['C']);
    expect((await a.task(top.gid))!.num_subtasks).toBe(1);
  });
  it('a multi-homed subtask lists in the project; removeProject undoes it', async () => {
    const { a, p, s } = await setup();
    const top = await a.createTask({ name: 'P', projects: [p.gid] }), kid = await a.createTask({ name: 'C', parent: top.gid });
    await a.addProject(kid.gid, p.gid, s.gid);
    expect((await a.task(kid.gid))!.memberships).toEqual([{ project: { gid: p.gid, name: 'Ops' }, section: { gid: s.gid, name: 'Home' } }]);
    expect((await a.tasks(p.gid)).map(t => t.name).sort()).toEqual(['C', 'P']);
    await a.removeProject(kid.gid, p.gid);
    expect((await a.task(kid.gid))!.memberships).toEqual([]); expect((await a.task(kid.gid))!.parent?.gid).toBe(top.gid);
  });
  it('setParent keeps memberships; setParent(null) leaves none until addProject', async () => {
    const { a, p, s } = await setup();
    const top = await a.createTask({ name: 'P', projects: [p.gid] }), t = await a.createTask({ name: 'T', projects: [p.gid] }); await a.addToSection(s.gid, t.gid);
    await a.setParent(t.gid, top.gid);
    expect((await a.task(t.gid))!.memberships[0].section?.gid).toBe(s.gid); expect((await a.tasks(p.gid)).find(x => x.gid === t.gid)!.parent?.gid).toBe(top.gid);
    await a.removeProject(t.gid, p.gid); await a.setParent(t.gid, null);
    expect(await a.task(t.gid)).toMatchObject({ memberships: [], parent: null });
    await a.addProject(t.gid, p.gid, s.gid);
    expect((await a.task(t.gid))!.memberships).toHaveLength(1);
  });
  it('completing a parent does not complete its children', async () => {
    const { a, p } = await setup();
    const top = await a.createTask({ name: 'P', projects: [p.gid] }), kid = await a.createTask({ name: 'C', parent: top.gid });
    await a.updateTask(top.gid, { completed: true });
    expect((await a.task(kid.gid))!.completed).toBe(false); expect((await a.task(top.gid))!.completed).toBe(true);
  });
  it('a deleted task reads null, and deleting twice is a 404', async () => {
    const { a, p } = await setup();
    const t = await a.createTask({ name: 'X', projects: [p.gid] }); await a.deleteTask(t.gid);
    expect(await a.task(t.gid)).toBeNull(); expect(await a.deleteTask(t.gid).catch(e => e)).toMatchObject({ status: 404 });
  });
  it('tag creation needs a workspace; tags add and remove, also on subtasks', async () => {
    const { a, ws, p } = await setup();
    expect(await a.createTag('', 'x').catch(e => e)).toMatchObject({ status: 400, message: expect.stringContaining('workspace') });
    expect(await a.createTag('9999', 'x').catch(e => e)).toMatchObject({ status: 400 });
    const tag = await a.createTag(ws, 'doing'); expect((await a.tags(ws)).map(t => t.name)).toEqual(['doing']);
    const top = await a.createTask({ name: 'P', projects: [p.gid] }), kid = await a.createTask({ name: 'C', parent: top.gid });
    expect(await a.addTag(kid.gid, 'nope').catch(e => e)).toMatchObject({ status: 404 });
    await a.addTag(kid.gid, tag.gid); expect((await a.task(kid.gid))!.tags.map(t => t.name)).toEqual(['doing']);
    await a.removeTag(kid.gid, tag.gid); expect((await a.task(kid.gid))!.tags).toEqual([]);
  });
  it('completed_since: open tasks always, completed ones only at or after the time; now gives open only', async () => {
    const { a, p } = await setup();
    const old = await a.createTask({ name: 'old', projects: [p.gid] }), open = await a.createTask({ name: 'open', projects: [p.gid] }), recent = await a.createTask({ name: 'recent', projects: [p.gid] });
    await a.updateTask(old.gid, { completed: true }); a.tick(10000); const since = a.now(); a.tick(1000); await a.updateTask(recent.gid, { completed: true });
    expect((await a.tasks(p.gid)).map(t => t.name).sort()).toEqual(['old', 'open', 'recent']);
    expect((await a.tasks(p.gid, since)).map(t => t.name).sort()).toEqual(['open', 'recent']);
    expect((await a.tasks(p.gid, 'now')).map(t => t.name)).toEqual(['open']);
    const kid = await a.createTask({ name: 'kid', parent: open.gid }); await a.updateTask(kid.gid, { completed: true });
    expect(await a.subtasks(open.gid, 'now')).toEqual([]);
  });
  it('records calls, fails the next call once, and can simulate a rate limit', async () => {
    const { a, p } = await setup();
    a.calls.length = 0; await a.tasks(p.gid); expect(a.calls).toEqual([`tasks ${p.gid}`]);
    a.failNext('tasks', new Error('boom')); await expect(a.tasks(p.gid)).rejects.toThrow('boom'); await expect(a.tasks(p.gid)).resolves.toEqual([]);
    a.rateLimit('me', 12); expect(await a.me().catch(e => e)).toMatchObject({ status: 429, retryAfterS: 12 }); expect(await a.me()).toMatchObject({ gid: '1' });
    expect(new AsHttpError(429, 'x', 3).retryAfterS).toBe(3);
  });
  it('live probe: memberships alone are refused; projects with memberships land in the section; one membership per project', async () => {
    const { a, p, s } = await setup();
    await expect(a.createTask({ name: 'M', memberships: [{ project: p.gid, section: s.gid }] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('You should specify one of workspace, parent, projects') });
    const t = await a.createTask({ name: 'M', projects: [p.gid], memberships: [{ project: p.gid, section: s.gid }] });
    expect(t.memberships).toEqual([{ project: { gid: p.gid, name: 'Ops' }, section: { gid: s.gid, name: 'Home' } }]);
  });
  it('live probe: tag colors outside Asana’s set are refused; writing due_on clears due_at', async () => {
    const { a, ws, p } = await setup();
    await expect(a.createTag(ws, 'x', 'light-brown')).rejects.toMatchObject({ status: 400 });
    expect((await a.createTag(ws, 'y', 'light-yellow')).name).toBe('y');
    const t = await a.createTask({ name: 'D', projects: [p.gid], due_at: '2026-12-15T23:30:00.000Z' });
    expect(await a.updateTask(t.gid, { due_on: '2026-12-20' })).toMatchObject({ due_on: '2026-12-20', due_at: null });
  });
});
