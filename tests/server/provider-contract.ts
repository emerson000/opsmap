// The suite every task provider adapter must pass (server/tasksync/contract.ts). It drives the adapter only through
// the contract, so the engine can rely on these behaviors for any provider. `deleteRemote` removes a task the way a
// user would in the service itself; a subject without it fails that test unless it says `noRemoteDelete` (and why).
import { describe, expect, it } from 'vitest';
import type { FieldKey, ProviderSession, RemoteTask, TaskProvider, TaskWrite } from '../../server/tasksync/contract';

export interface ContractSubject { provider: TaskProvider; token: string; deleteRemote?: (id: string) => Promise<void>; /** Why this subject cannot delete a task remotely. */ noRemoteDelete?: string }

const TZ = 'Europe/London';
/** The fields of a task that the provider declares, for comparing what went in with what came back. */
const declared = (t: RemoteTask, fields: ReadonlySet<FieldKey>) => ({
  ...(fields.has('title') ? { title: t.title } : {}), ...(fields.has('note') ? { note: t.note } : {}), ...(fields.has('due') ? { due: t.due } : {}),
  ...(fields.has('status') ? { status: t.status } : {}), ...(fields.has('progress') ? { progress: t.progress } : {}),
  ...(fields.has('container') ? { container: t.container } : {}),
});

export function providerContract(name: string, make: () => ContractSubject) {
  describe(`task provider contract: ${name}`, () => {
    const open = () => { const subject = make(); return { ...subject, session: subject.provider.connect(subject.token) as ProviderSession }; };
    const unique = (base: string) => `${base} ${Math.random().toString(36).slice(2, 8)}`;

    it('has a descriptor and capabilities the sync can use', async () => {
      const { provider, token } = make();
      const d = provider.descriptor, c = provider.capabilities;
      expect(d.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(d.label.length).toBeGreaterThan(0);
      for (const alias of d.aliases) expect(alias).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(d.urls.task).toContain('{id}');
      expect(c.fields.has('title')).toBe(true);
      expect(c.maxTitle).toBeGreaterThan(0);
      expect(c.idlePollMs).toBeGreaterThanOrEqual(c.pollMs);
      expect((await provider.verify(token)).username.length).toBeGreaterThan(0);
    });

    it('resolveRoot finds a root by name and creates one when it is missing', async () => {
      const { session } = open(), title = unique('Ops');
      const created = await session.resolveRoot(title);
      expect(created).toMatchObject({ title });
      expect(await session.resolveRoot(title.toLowerCase())).toEqual(created);
      expect(await session.resolveRoot(title)).toEqual(created);
    });

    it('ensureContainers is idempotent', async () => {
      const { session } = open(), root = await session.resolveRoot(unique('Ops'));
      const names = [{ sectorId: 'work', name: 'Work' }, { sectorId: 'home', name: 'Home' }];
      const first = await session.ensureContainers(root, names, {});
      expect(Object.keys(first).sort()).toEqual(['home', 'work']);
      expect(first.work).not.toBe(first.home);
      expect(await session.ensureContainers(root, names, first)).toEqual(first);
      // Found again by name when nothing is known.
      expect(await session.ensureContainers(root, names, {})).toEqual(first);
    });

    it('create, snapshot and update round-trip every declared field', async () => {
      const { provider, session } = open(), fields = provider.capabilities.fields;
      const root = await session.resolveRoot(unique('Ops'));
      const c = await session.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }, { sectorId: 'home', name: 'Home' }], {});
      const write: TaskWrite & { title: string; container: string } = { title: 'Roof leak', container: c.work, note: 'Call the roofer', due: '2026-12-01', status: 'active', progress: 0.4, affiliation: 'hostile' };
      const created = await session.createTask(root, write, TZ);
      const want = declared({ ...created, title: 'Roof leak', note: 'Call the roofer', due: '2026-12-01', status: 'active', progress: 0.4, container: c.work }, fields);
      expect(declared(created, fields)).toEqual(want);
      const seen = (await session.snapshot(root, c, TZ)).tasks.find(t => t.id === created.id)!;
      expect(seen).toBeDefined();
      expect(declared(seen, fields)).toEqual(want);
      const changes: TaskWrite = { title: 'Roof fixed', note: 'Done by Bob', due: '2026-12-02', status: 'blocked', progress: 0.9, container: c.home };
      const updated = await session.updateTask(root, seen, changes, TZ);
      const after = declared({ ...updated, ...changes } as RemoteTask, fields);
      expect(declared(updated, fields)).toEqual(after);
      expect(declared((await session.getTask(root, created.id, TZ))!, fields)).toEqual(after);
    });

    it('a created child has its parent, and no container or its parent’s', async ({ skip }) => {
      const { provider, session } = open();
      if (!provider.capabilities.fields.has('parent')) skip();
      const root = await session.resolveRoot(unique('Ops'));
      const c = await session.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
      const parent = await session.createTask(root, { title: 'Move house', container: c.work }, TZ);
      const child = await session.createTask(root, { title: 'Book the van', container: c.work, parent: parent.id }, TZ);
      // A provider that keeps subtasks in a container of their own (Vikunja) reports it; one that nests them under
      // the parent (Asana) reports none, and the sync then takes the parent's sector.
      expect(child.parent).toBe(parent.id);
      expect([null, c.work]).toContain(child.container);
      const seen = (await session.snapshot(root, c, TZ)).tasks.find(t => t.id === child.id);
      expect(seen).toMatchObject({ parent: parent.id, container: child.container });
    });

    it('getTask returns null after a remote delete', async ({ skip }) => {
      const subject = open();
      if (subject.noRemoteDelete) skip(subject.noRemoteDelete);
      expect(subject.deleteRemote, 'deleteRemote (or noRemoteDelete with a reason)').toBeTypeOf('function');
      const root = await subject.session.resolveRoot(unique('Ops'));
      const c = await subject.session.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
      const task = await subject.session.createTask(root, { title: 'Gone soon', container: c.work }, TZ);
      expect(await subject.session.getTask(root, task.id, TZ)).not.toBeNull();
      await subject.deleteRemote!(task.id);
      expect(await subject.session.getTask(root, task.id, TZ)).toBeNull();
    });

    it('ignores a field in TaskWrite that the provider does not declare', async () => {
      const { provider, session } = open(), fields = provider.capabilities.fields;
      const root = await session.resolveRoot(unique('Ops'));
      const c = await session.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
      const plain = await session.createTask(root, { title: 'Plain', container: c.work }, TZ);
      const full = await session.createTask(root, { title: 'Full', container: c.work, note: 'n', due: '2026-12-01', status: 'blocked', progress: 0.5, affiliation: 'hostile' }, TZ);
      // Every undeclared field reads as it does on a task created without it.
      for (const key of ['note', 'due', 'status', 'progress'] as const) if (!fields.has(key)) expect(full[key], key).toEqual(plain[key]);
      if (!fields.has('affiliation')) expect(full.affiliations).toEqual(plain.affiliations);
    });

    it('the identity in affiliation shows up in affiliations', async ({ skip }) => {
      const { provider, session } = open();
      if (!provider.capabilities.fields.has('affiliation')) skip();
      const root = await session.resolveRoot(unique('Ops'));
      const c = await session.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
      const task = await session.createTask(root, { title: 'Leaky sink', container: c.work, affiliation: 'hostile' }, TZ);
      expect(task.affiliations).toContain('hostile');
      const changed = await session.updateTask(root, task, { affiliation: 'friend' }, TZ);
      expect(changed.affiliations).toContain('friend');
      expect((await session.getTask(root, task.id, TZ))!.affiliations).toContain('friend');
    });

    it('writing affiliation null removes the identity opsmap manages', async ({ skip }) => {
      const { provider, session } = open();
      if (!provider.capabilities.fields.has('affiliation')) skip();
      const root = await session.resolveRoot(unique('Ops'));
      const c = await session.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
      const task = await session.createTask(root, { title: 'Leaky sink', container: c.work, affiliation: 'hostile' }, TZ);
      expect((await session.updateTask(root, task, { affiliation: null }, TZ)).affiliations).toEqual([]);
      expect((await session.getTask(root, task.id, TZ))!.affiliations).toEqual([]);
    });
  });
}
