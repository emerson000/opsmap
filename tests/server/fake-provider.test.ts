import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { FakeProvider, fakeProvider } from './fake-provider';
import { providerContract } from './provider-contract';
import { RateLimited, RemoteAuthError } from '../../server/tasksync/contract';

providerContract('fake', () => { const provider = new FakeProvider(); return { provider, token: 'fake-alice', deleteRemote: async id => provider.remoteDelete(id) }; });
providerContract('fake without progress, parent or relations', () => ({ provider: new FakeProvider({ fields: ['title', 'due', 'note', 'status', 'container'], relations: [] }), token: 'fake-alice' }));

describe('FakeProvider', () => {
  it('is registered only for tests that ask for it', () => {
    expect(fakeProvider({ NODE_ENV: 'test', OPSMAP_FAKE_PROVIDER: '1' })).toBeInstanceOf(FakeProvider);
    expect(fakeProvider({ NODE_ENV: 'test' })).toBeUndefined();
    expect(fakeProvider({ NODE_ENV: 'production', OPSMAP_FAKE_PROVIDER: '1' })).toBeUndefined();
    expect(fakeProvider({ OPSMAP_FAKE_PROVIDER: '1' })).toBeUndefined();
  });

  it('verifies fake-‹user› tokens and refuses others', async () => {
    const p = new FakeProvider();
    expect(await p.verify('fake-alice')).toEqual({ username: 'alice' });
    await expect(p.verify('tk_other')).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(p.connect('tk_other').resolveRoot('Ops')).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it('records calls, fails on request, and moves its clock with tick()', async () => {
    const p = new FakeProvider(), s = p.connect('fake-alice');
    const root = await s.resolveRoot('Ops');
    const c = await s.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
    expect(p.calls.map(x => x.method)).toEqual(['resolveRoot', 'ensureContainers']);
    p.failNext('createTask', new RateLimited(30));
    await expect(s.createTask(root, { title: 'A', container: c.work }, 'UTC')).rejects.toThrow('rate limited, retrying in 30s');
    const a = await s.createTask(root, { title: 'A', container: c.work }, 'UTC');
    p.tick(60_000);
    const b = await s.updateTask(root, a, { title: 'B' }, 'UTC');
    expect(Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).toBe(60_000);
  });

  it('lists the tasks of unmatched containers and changes made in the service', async () => {
    const p = new FakeProvider(), s = p.connect('fake-alice');
    const root = await s.resolveRoot('Ops');
    const c = await s.ensureContainers(root, [{ sectorId: 'work', name: 'Work' }], {});
    const home = p.remoteContainer(root.id, 'Home');
    p.remoteCreate(root.id, { title: 'Laundry', container: home.id });
    const t = p.remoteCreate(root.id, { title: 'Report', container: c.work });
    const child = p.remoteCreate(root.id, { title: 'Draft', container: null, parent: t.id });
    p.remoteUpdate(t.id, { status: 'done' });
    const snap = await s.snapshot(root, c, 'UTC');
    expect(snap.tasks.map(x => x.title).sort()).toEqual(['Draft', 'Report']);
    expect(snap.tasks.find(x => x.id === t.id)!.status).toBe('done');
    expect(snap.tasks.find(x => x.id === child.id)).toMatchObject({ parent: t.id, container: null });
    expect(snap.unmatched).toEqual([{ container: home, open: 1 }]);
  });

  it('accepts only webhook deliveries signed with the secret', () => {
    const p = new FakeProvider(), body = '{"event":"changed"}';
    const sig = createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(p.receiveWebhook(new Headers({ 'x-fake-signature': sig }), body, 's3cret', null)).toEqual({ status: 200, trigger: true });
    expect(p.receiveWebhook(new Headers({ 'x-fake-signature': sig }), body, 'other', null)).toEqual({ status: 401, trigger: false });
    expect(p.receiveWebhook(new Headers(), body, 's3cret', null)).toEqual({ status: 401, trigger: false });
  });
});
