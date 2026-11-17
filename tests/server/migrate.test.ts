// D8: a server that synced with Vikunja before task sync became provider-neutral keeps its binding, links, webhook
// bookkeeping and tokens. The store below is built with the old schema and an old journal of `vk` ops.
import { describe, expect, it } from 'vitest';
import { Store } from '../../server/db';
import { Maps } from '../../server/maps';
import { SecretBox } from '../../server/secrets';
import { Credentials } from '../../server/tasksync/credentials';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { migrateTaskSync, migrateTokens, taskSyncSummary } from '../../server/tasksync/migrate';
import { FakeProvider } from './fake-provider';

const box = SecretBox.fromKey(Buffer.alloc(32, 5));
const tables = (store: Store) => (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(t => t.name);

/** A database as the server left it before: a map bound to project 39, three linked units, a token, webhooks. */
function oldStore(): Store {
  const store = new Store(':memory:');
  const at = '2026-11-01T12:00:00.000Z';
  let seq = 0;
  const op = (userId: string, source: string, cmd: object, via?: string) => store.db.prepare('INSERT INTO ops(map_id,seq,op_id,user_id,source,at,cmd,log,inverse,principal,via) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('main', ++seq, crypto.randomUUID(), userId, source, at, JSON.stringify(cmd), 'x', '{"units":[],"orders":[],"measures":[],"sectors":[],"top":{}}', `user:${userId}`, via ?? source);
  op('u1', 'web', { verb: 'new', args: { title: 'Roof leak', designation: 'LEAK', sectorId: 'household', affiliation: 'hostile' } });
  op('u1', 'web', { verb: 'new', args: { title: 'Taxes', designation: 'TAX', sectorId: 'work' } });
  op('u1', 'web', { verb: 'new', args: { title: 'Dentist', designation: 'DENT', sectorId: 'family' } });
  op('system', 'web', { verb: 'vk', args: { action: 'bound', project: 39, title: 'Ops', by: 'u1', sectors: { work: 40, household: 41, family: 42, wellness: 43, productivity: 44 } } }, 'vikunja');
  op('system', 'system', { verb: 'vk', args: { action: 'links', links: { u1: 101, u2: 102 } } }, 'vikunja');
  op('system', 'system', { verb: 'vk', args: { action: 'add', task: 103, title: 'Call plumber', sectorId: 'household' } }, 'vikunja');
  store.db.exec(`CREATE TABLE vk_tokens(user_id TEXT PRIMARY KEY,sealed TEXT NOT NULL,username TEXT NOT NULL,saved_at TEXT NOT NULL);
    CREATE TABLE vk_links(map_id TEXT NOT NULL,unit_id TEXT NOT NULL,task_id INTEGER NOT NULL,base TEXT NOT NULL,PRIMARY KEY(map_id,unit_id));
    CREATE TABLE vk_maps(map_id TEXT PRIMARY KEY,secret TEXT NOT NULL,hooks TEXT NOT NULL DEFAULT '[]',owner TEXT,hooks_checked TEXT,last_delivery TEXT);
    ALTER TABLE vk_maps ADD COLUMN relations TEXT;`);
  store.db.prepare('INSERT INTO vk_tokens VALUES(?,?,?,?)').run('u1', box.seal('tk_old_token', 'u1'), 'alice', at);
  const base = (title: string) => JSON.stringify({ title, due: null, note: '', progress: null, status: 'todo', sector: 'household', affiliation: 'pending' });
  for (const [unit, task, title] of [['u1', 101, 'Roof leak'], ['u2', 102, 'Taxes'], ['u4', 103, 'Call plumber']] as const) store.db.prepare('INSERT INTO vk_links VALUES(?,?,?,?)').run('main', unit, task, base(title));
  store.db.prepare('INSERT INTO vk_maps VALUES(?,?,?,?,?,?,?)').run('main', 's3cret', JSON.stringify([{ project: 40, id: 7 }, { project: 41, id: 8 }]), 'u1', at, at, JSON.stringify({ parents: { u2: 101, u1: null }, edges: ['["link","u1","u2"]'], refused: [] }));
  store.db.prepare('INSERT INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run('main', 3, '{"stale":true}', at);
  return store;
}

describe('D8 migration', () => {
  it('reports what it would move, without changing anything', () => {
    const store = oldStore();
    expect(taskSyncSummary(store)).toEqual(['map main: bound to Vikunja project 39, 3 units linked, 1 tokens']);
    expect(tables(store)).toEqual(expect.arrayContaining(['vk_links', 'vk_maps', 'vk_tokens']));
    expect(store.meta('tasksync_v1')).toBeUndefined();
  });

  it('moves links, maps and webhook bookkeeping into ts_*, drops the old tables, and the map replays bound to 39', () => {
    const store = oldStore();
    const registry = new ProviderRegistry([new FakeProvider({ id: 'vikunja', label: 'Vikunja' })]);
    const credentials = new Credentials(store, box, registry);
    migrateTaskSync(store);
    expect(tables(store).filter(t => t.startsWith('vk_'))).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT unit_id,remote_id,base FROM ts_links ORDER BY unit_id').all()).toEqual([
      { unit_id: 'u1', remote_id: '101', base: expect.stringContaining('"sector":"household"') },
      { unit_id: 'u2', remote_id: '102', base: expect.any(String) },
      { unit_id: 'u4', remote_id: '103', base: expect.stringContaining('"title":"Call plumber"') },
    ]);
    const row = store.db.prepare('SELECT * FROM ts_maps').get() as Record<string, string | null>;
    expect(row).toMatchObject({ map_id: 'main', provider: 'vikunja', secret: 's3cret', owner: 'u1', hooks: JSON.stringify([{ project: 40, id: 7 }, { project: 41, id: 8 }]), hooks_checked: '2026-11-01T12:00:00.000Z', last_delivery: '2026-11-01T12:00:00.000Z' });
    expect(JSON.parse(row.relations!)).toEqual({ parents: { u2: '101', u1: null }, edges: ['["link","u1","u2"]'], refused: [] });
    const doc = new Maps(store, 'UTC').get('main')!.doc;
    expect(doc.settings.taskSync).toEqual({ provider: 'vikunja', label: 'Vikunja', root: '39', title: 'Ops', by: 'u1' });
    expect(doc.sectors.map(s => s.remote)).toEqual(['40', '41', '42', '43', '44']);
    expect(Object.fromEntries(doc.units.map(u => [u.id, u.remote]))).toEqual({ u1: '101', u2: '102', u3: undefined, u4: '103' });
    expect(credentials.token('u1', 'vikunja')).toBe('tk_old_token');
    // Twice: nothing changes, and a token removed since does not come back.
    credentials.remove('u1', 'vikunja');
    const before = JSON.stringify([store.db.prepare('SELECT * FROM ts_links ORDER BY unit_id').all(), store.db.prepare('SELECT * FROM ts_maps').all()]);
    migrateTaskSync(store);
    new Credentials(store, box, registry);
    expect(JSON.stringify([store.db.prepare('SELECT * FROM ts_links ORDER BY unit_id').all(), store.db.prepare('SELECT * FROM ts_maps').all()])).toBe(before);
    expect(credentials.token('u1', 'vikunja')).toBeUndefined();
    expect(taskSyncSummary(store)).toEqual(['already migrated']);
  });

  it('keeps vk_tokens until its copy into ts_tokens has run', () => {
    const store = oldStore();
    migrateTaskSync(store);
    expect(tables(store)).toContain('vk_tokens');
    expect(tables(store).filter(t => t === 'vk_links' || t === 'vk_maps')).toEqual([]);
    new Credentials(store, box, new ProviderRegistry([new FakeProvider({ id: 'vikunja', label: 'Vikunja' })]));
    migrateTaskSync(store);
    expect(tables(store)).not.toContain('vk_tokens');
  });

  it('runs as the CLI does it, without the server: tokens first, then the rest', () => {
    const store = oldStore();
    migrateTokens(store, box);
    migrateTaskSync(store);
    expect(tables(store).filter(t => t.startsWith('vk_'))).toEqual([]);
    expect(store.db.prepare('SELECT user_id,provider,username FROM ts_tokens').all()).toEqual([{ user_id: 'u1', provider: 'vikunja', username: 'alice' }]);
  });

  it('does nothing on a server that never synced', () => {
    const store = new Store(':memory:');
    expect(taskSyncSummary(store)).toEqual(['nothing to migrate']);
    migrateTaskSync(store);
    expect(store.meta('tasksync_v1')).toBe('1');
  });
});
