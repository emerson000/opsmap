// The Vikunja adapter's part of D12: child projects of the bound project that match no sector are reported, with
// their open tasks, and the engine lists them in status. Archived sector projects stay as before.
import { describe, expect, it } from 'vitest';
import { Store } from '../../../server/db';
import { Maps } from '../../../server/maps';
import { SecretBox } from '../../../server/secrets';
import { VikunjaProvider } from '../../../server/providers/vikunja';
import { HOOK_PATHS } from '../../../server/providers';
import { TaskSyncEngine } from '../../../server/tasksync/engine';
import { Credentials } from '../../../server/tasksync/credentials';
import { ProviderRegistry } from '../../../server/tasksync/registry';
import { seedDoc } from '../../../src/core/model/seed';
import { FakeVikunja } from './fake-vikunja';

const user = { id: 'u1', email: 'a@dev.local', name: 'Alice', initials: 'AL', color: '#000' };
describe('Vikunja adapter: unmatched child projects', () => {
  it('lists open tasks in a child project that is no sector, and leaves them out of the map', async () => {
    const store = new Store(':memory:'), maps = new Maps(store, 'Europe/London'), vk = new FakeVikunja();
    maps.default.import(user.id, seedDoc(new Date()));
    const registry = new ProviderRegistry([new VikunjaProvider('https://todo.example', () => vk)]);
    const credentials = new Credentials(store, SecretBox.fromKey(Buffer.alloc(32, 4)), registry);
    await credentials.save(user.id, 'vikunja', 'tk_good_token');
    const sync = new TaskSyncEngine(maps, registry, credentials, 'https://opsmap.example', 3_600_000, undefined, { resolve: async () => ['93.184.216.34'], hookPaths: HOOK_PATHS });
    const mapId = maps.default.mapId, status = () => sync.request(mapId, { action: 'status' }, user, 'web');
    await sync.request(mapId, { action: 'bind', name: 'Ops' }, user, 'web');
    expect(await status()).not.toMatch(/not synced/);
    const root = Number(maps.default.doc.settings.taskSync!.root);
    const home = await vk.createProject('Home', root), old = await vk.createProject('Old', root), elsewhere = await vk.createProject('Elsewhere', 0);
    vk.add(home.id, { title: 'Laundry' }); vk.add(home.id, { title: 'Dishes' }); vk.add(home.id, { title: 'Ironed', done: true });
    vk.add(old.id, { title: 'Gone', done: true }); vk.add(elsewhere.id, { title: 'Not ours' });
    vk.projectsById.set(old.id, { ...vk.projectsById.get(old.id)!, is_archived: false });
    await sync.run(mapId);
    expect(maps.default.doc.units.some(u => ['Laundry', 'Dishes', 'Not ours'].includes(u.title))).toBe(false);
    expect(await status()).toMatch(/ · not synced: project Home \(2 tasks\)( · |$)/);
    expect(await status()).not.toMatch(/Old|Elsewhere/);
    expect(vk.hooks.get(vk.projectsById.get(Number(maps.default.doc.sectors[0].remote))!.id)![0].target_url).toBe(`https://opsmap.example/api/vikunja/hook/${mapId}`);
    await sync.stop();
  });
});
