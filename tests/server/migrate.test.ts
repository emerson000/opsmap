// D8: a server that synced with Vikunja before task sync became provider-neutral keeps its binding, links, webhook
// bookkeeping and tokens. The store below is built with the old schema and an old journal of `vk` ops.
import { describe, expect, it } from 'vitest';
import { Store } from '../../server/db';
import { Maps } from '../../server/maps';
import { Hub } from '../../server/hub';
import { apply } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { emptyDoc } from '../../src/core/model/seed';
import type { Command, Doc } from '../../src/core/model/types';
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
  store.db.prepare('INSERT INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run('main', 3, legacy(replayed(store, 3)), at);
  store.setMeta('snapshots_v2_reset', '1');
  return store;
}

/** The map after ops 1..upTo as the server of the time computed it: ops it refused are skipped (old rules let them through). */
function replayed(store: Store, upTo: number): Doc {
  let doc = emptyDoc('UTC');
  for (const op of store.db.prepare('SELECT cmd,at,user_id,via FROM ops WHERE map_id=? AND seq<=? ORDER BY seq').all('main', upTo) as { cmd: string; at: string; user_id: string; via: string }[]) {
    const result = apply(doc, JSON.parse(op.cmd) as Command, new Date(op.at), op.user_id, op.via);
    if (!('error' in result)) doc = result.doc;
  }
  return doc;
}
/** A document in the shape snapshots had before task sync was provider-neutral: settings.vikunja, numeric `vk` ids. */
function legacy(doc: Doc): string {
  const raw = JSON.parse(JSON.stringify(doc)) as { settings: Record<string, unknown>; sectors: Record<string, unknown>[]; units: Record<string, unknown>[] };
  const bound = raw.settings.taskSync as { root: string; title: string; by?: string } | undefined;
  delete raw.settings.taskSync;
  if (bound) raw.settings.vikunja = { project: Number(bound.root), title: bound.title, ...(bound.by ? { by: bound.by } : {}) };
  for (const x of [...raw.sectors, ...raw.units]) if (x.remote !== undefined) { x.vk = Number(x.remote); delete x.remote; }
  return JSON.stringify(raw);
}
const snapshots = (store: Store) => store.db.prepare('SELECT map_id,seq,doc FROM snapshots ORDER BY map_id,seq').all() as { map_id: string; seq: number; doc: string }[];

describe('D8 migration', () => {
  it('reports what it would move, without changing anything', () => {
    const store = oldStore();
    expect(taskSyncSummary(store)).toEqual(['map main: snapshots 3 ok; bound to Vikunja project 39; 3 units linked, 3 in the document; 1 tokens']);
    expect(tables(store)).toEqual(expect.arrayContaining(['vk_links', 'vk_maps', 'vk_tokens']));
    expect(store.meta('tasksync_v1')).toBeUndefined();
  });

  it('moves links, maps and webhook bookkeeping into ts_*, drops the old tables, and the map replays bound to 39', () => {
    const store = oldStore();
    const registry = new ProviderRegistry([new FakeProvider({ id: 'vikunja', label: 'Vikunja' })]);
    const credentials = new Credentials(store, box, registry);
    migrateTaskSync(store);
    expect(tables(store).filter(t => t.startsWith('vk_'))).toEqual([]);
    expect(snapshots(store).map(r => r.seq)).toEqual([3]);
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

  it('keeps vk_tokens when the key cannot open them (a new key), says how many, and copies them on a start with the right key', () => {
    const store = oldStore(), lines: string[] = [];
    migrateTokens(store, SecretBox.fromKey(Buffer.alloc(32, 9)), line => lines.push(line));
    expect(lines).toEqual(['Task sync: 1 Vikunja token could not be opened with this secret key; it stays in vk_tokens until a start with the right key']);
    expect(lines.join()).not.toContain('tk_old_token');
    expect(store.meta('ts_tokens_from_vk')).toBeUndefined();
    migrateTaskSync(store);
    expect(tables(store)).toContain('vk_tokens');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ts_tokens').get()).toEqual({ n: 0 });
    const registry = new ProviderRegistry([new FakeProvider({ id: 'vikunja', label: 'Vikunja' })]);
    const credentials = new Credentials(store, box, registry);
    expect(credentials.token('u1', 'vikunja')).toBe('tk_old_token');
    expect(store.meta('ts_tokens_from_vk')).toBe('1');
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

  it('is one transaction: a row that does not fit leaves every old table and the meta key as they were', () => {
    const store = oldStore();
    // A map row without a secret (ts_maps requires one).
    store.db.exec(`ALTER TABLE vk_maps RENAME TO vk_maps_old;
      CREATE TABLE vk_maps(map_id TEXT PRIMARY KEY,secret TEXT,hooks TEXT NOT NULL DEFAULT '[]',owner TEXT,hooks_checked TEXT,last_delivery TEXT,relations TEXT);
      INSERT INTO vk_maps SELECT * FROM vk_maps_old; DROP TABLE vk_maps_old;
      INSERT INTO vk_maps(map_id,secret) VALUES('other',NULL);`);
    const before = JSON.stringify([store.db.prepare('SELECT * FROM vk_links ORDER BY unit_id').all(), store.db.prepare('SELECT * FROM vk_maps ORDER BY map_id').all()]);
    expect(() => migrateTaskSync(store)).toThrow(/NOT NULL/);
    expect(JSON.stringify([store.db.prepare('SELECT * FROM vk_links ORDER BY unit_id').all(), store.db.prepare('SELECT * FROM vk_maps ORDER BY map_id').all()])).toBe(before);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ts_links').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ts_maps').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()).toEqual({ n: 1 });
    expect(store.meta('tasksync_v1')).toBeUndefined();
  });

  it('does nothing on a server that never synced', () => {
    const store = new Store(':memory:');
    expect(taskSyncSummary(store)).toEqual(['nothing to migrate']);
    migrateTaskSync(store);
    expect(store.meta('tasksync_v1')).toBe('1');
  });
});

/** Production's case: the journal cannot be replayed from empty (op 4 is an /unpin that today's rules refuse), so the
 *  snapshot after it is the only reliable state. The migration upgrades snapshots in place and never clears them. */
function unreplayableStore(): Store {
  const store = new Store(':memory:');
  const at = '2026-11-01T12:00:00.000Z';
  let seq = 0;
  const op = (cmd: object, userId = 'u1', via = 'web') => store.db.prepare('INSERT INTO ops(map_id,seq,op_id,user_id,source,at,cmd,log,inverse,principal,via) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('main', ++seq, crypto.randomUUID(), userId, 'web', at, JSON.stringify(cmd), 'x', '{"units":[],"orders":[],"measures":[],"sectors":[],"top":{}}', `user:${userId}`, via);
  const text = (raw: string) => { const p = parse(raw, emptyDoc('UTC')); if (!p.ok) throw new Error(p.error); return p.cmd; };
  op(text('/new hostile "Roof leak" as LEAK'));
  op(text('/new pending "Taxes" as TAX'));
  op(text('/new pending "Dentist" as DENT'));
  op({ verb: 'unpin', args: { unit: 'u1' }, raw: '/unpin LEAK' });
  op({ verb: 'vk', args: { action: 'bound', project: 39, title: 'Ops', by: 'u1', sectors: { work: 40, household: 41, family: 42, wellness: 43, productivity: 44 } } }, 'system', 'vikunja');
  op({ verb: 'vk', args: { action: 'links', links: { u1: 101, u2: 102 } } }, 'system', 'vikunja');
  store.db.prepare('INSERT INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run('main', 6, legacy(replayed(store, 6)), at);
  op({ verb: 'vk', args: { action: 'add', task: 103, title: 'Call plumber', sectorId: 'household' } }, 'system', 'vikunja');
  op({ verb: 'vk', args: { action: 'links', links: { u3: 104 } } }, 'system', 'vikunja');
  store.db.exec(`CREATE TABLE vk_links(map_id TEXT NOT NULL,unit_id TEXT NOT NULL,task_id INTEGER NOT NULL,base TEXT NOT NULL,PRIMARY KEY(map_id,unit_id));
    CREATE TABLE vk_maps(map_id TEXT PRIMARY KEY,secret TEXT NOT NULL,hooks TEXT NOT NULL DEFAULT '[]',owner TEXT,hooks_checked TEXT,last_delivery TEXT,relations TEXT);`);
  for (const [unit, task] of [['u1', 101], ['u2', 102], ['u4', 103], ['u3', 104]] as const) store.db.prepare('INSERT INTO vk_links VALUES(?,?,?,?)').run('main', unit, task, '{}');
  store.db.prepare('INSERT INTO vk_maps(map_id,secret,owner) VALUES(?,?,?)').run('main', 's3cret', 'u1');
  store.setMeta('snapshots_v2_reset', '1');
  return store;
}

describe('D8 migration on a journal that cannot be replayed from empty', () => {
  it('fails the old way: clearing the snapshots and replaying the whole journal', () => {
    const store = unreplayableStore();
    store.db.exec('DELETE FROM snapshots');
    expect(() => new Hub(store, 'main', 'UTC')).toThrow('Replay failed at operation 4');
    expect(taskSyncSummary(store)).toEqual(['map main: no snapshots; binding unknown (Replay failed at operation 4); 4 units linked']);
  });

  it('upgrades the snapshot in place, keeps its row, and boots from it with the later legacy ops', () => {
    const store = unreplayableStore();
    expect(taskSyncSummary(store)).toEqual(['map main: snapshots 6 ok; bound to Vikunja project 39; 4 units linked, 4 in the document']);
    expect(store.meta('tasksync_v1')).toBeUndefined();
    migrateTaskSync(store);
    const rows = snapshots(store);
    expect(rows.map(r => [r.map_id, r.seq])).toEqual([['main', 6]]);
    const stored = JSON.parse(rows[0].doc);
    expect(stored.settings.vikunja).toBeUndefined();
    expect(stored.settings.taskSync).toEqual({ provider: 'vikunja', label: 'Vikunja', root: '39', title: 'Ops', by: 'u1' });
    expect(rows[0].doc).not.toMatch(/"vk":/);
    const hub = new Maps(store, 'UTC').get('main')!;
    expect(hub.seq).toBe(8);
    expect(hub.doc.settings.taskSync).toEqual({ provider: 'vikunja', label: 'Vikunja', root: '39', title: 'Ops', by: 'u1' });
    expect(hub.doc.sectors.map(s => s.remote)).toEqual(['40', '41', '42', '43', '44']);
    expect(hub.doc.units.map(u => [u.id, u.designation, u.remote])).toEqual([['u1', 'LEAK', '101'], ['u2', 'TAX', '102'], ['u3', 'DENT', '104'], ['u4', expect.any(String), '103']]);
    expect(snapshots(store).map(r => r.seq)).toEqual([6]);
    expect(taskSyncSummary(store)).toEqual(['already migrated']);
  });

  it('aborts the whole migration on a snapshot that does not upgrade, naming the map and seq', () => {
    const store = unreplayableStore();
    store.db.prepare('INSERT INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run('main', 7, '{"stale":true}', '2026-11-01T12:00:00.000Z');
    const before = JSON.stringify(snapshots(store));
    expect(taskSyncSummary(store)[0]).toMatch(/^map main: snapshots 6 ok, 7 fails \(Invalid document: unsupported version\);/);
    expect(() => migrateTaskSync(store)).toThrow('Snapshot of map main at seq 7 does not upgrade: Invalid document: unsupported version');
    expect(JSON.stringify(snapshots(store))).toBe(before);
    expect(store.meta('tasksync_v1')).toBeUndefined();
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='vk_links'").get()).toEqual({ n: 1 });
  });

  it('deletes an older snapshot that does not upgrade, reports it, and migrates from the latest', () => {
    const store = unreplayableStore(), lines: string[] = [];
    store.db.prepare('INSERT INTO snapshots(map_id,seq,doc,at) VALUES(?,?,?,?)').run('main', 5, '{"stale":true}', '2026-11-01T12:00:00.000Z');
    expect(taskSyncSummary(store)[0]).toMatch(/^map main: snapshots 5 fails, deleted on migrate \(Invalid document: unsupported version\), 6 ok;/);
    migrateTaskSync(store, line => lines.push(line));
    expect(lines).toEqual(['Task sync: deleted snapshot of map main at seq 5, an older one that does not upgrade (Invalid document: unsupported version); the map starts from seq 6']);
    expect(snapshots(store).map(r => r.seq)).toEqual([6]);
    expect(store.meta('tasksync_v1')).toBe('1');
    expect(new Maps(store, 'UTC').get('main')!.doc.settings.taskSync).toMatchObject({ provider: 'vikunja', root: '39' });
  });

  it('upgrades the snapshots of a server where D8 already ran without them (its own meta key)', () => {
    const store = unreplayableStore();
    store.setMeta('tasksync_v1', '1');
    migrateTaskSync(store);
    expect(JSON.parse(snapshots(store)[0].doc).settings.taskSync).toMatchObject({ provider: 'vikunja', root: '39' });
    expect(store.meta('tasksync_snapshots_v1')).toBe('1');
  });
});

describe('Hub startup', () => {
  it('keeps the snapshots of a database that never recorded snapshots_v2_reset', () => {
    const store = unreplayableStore();
    store.db.prepare("DELETE FROM meta WHERE key='snapshots_v2_reset'").run();
    migrateTaskSync(store);
    const before = snapshots(store).map(r => r.seq);
    const hub = new Maps(store, 'UTC').get('main')!;
    expect(hub.seq).toBe(8);
    expect(hub.doc.settings.taskSync).toMatchObject({ provider: 'vikunja', root: '39' });
    expect(snapshots(store).map(r => r.seq)).toEqual(before);
    expect(before).toEqual([6]);
  });
  it('deletes no snapshot and reads a legacy one with its binding, even before the migration', () => {
    const store = unreplayableStore();
    const before = JSON.stringify(snapshots(store));
    const hub = new Hub(store, 'main', 'UTC');
    expect(hub.seq).toBe(8);
    expect(hub.doc.settings.taskSync).toMatchObject({ provider: 'vikunja', root: '39' });
    expect(hub.doc.units.filter(u => u.remote).length).toBe(4);
    new Maps(store, 'UTC');
    expect(JSON.stringify(snapshots(store))).toBe(before);
  });
});

