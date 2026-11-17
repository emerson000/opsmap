// The provider-neutral task sync engine, on the in-memory provider: capabilities, rate limits, unmatched containers,
// subtasks, and how changes are delivered (D18–D20) with a fake clock, fake timers and a stubbed DNS.
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Store } from '../../server/db';
import { Maps } from '../../server/maps';
import { SecretBox } from '../../server/secrets';
import { TaskSyncEngine, type EngineOptions } from '../../server/tasksync/engine';
import { pollOverride } from '../../server/tasksync/delivery';
import { Credentials } from '../../server/tasksync/credentials';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { RateLimited, type ProviderSession } from '../../server/tasksync/contract';
import { parse } from '../../src/core/commands/grammar';
import { seedDoc } from '../../src/core/model/seed';
import { FakeProvider, type FakeOptions } from './fake-provider';

const user = { id: 'u1', email: 'a@dev.local', name: 'Alice', initials: 'AL', color: '#000' };
const PUBLIC = 'https://opsmap.example.com';

/** Timers that run only when a test says so, on a clock the test moves. */
class Clock {
  t = Date.parse('2026-11-10T12:00:00Z');
  queue: { id: number; at: number; fn: () => void }[] = [];
  private n = 0;
  now = () => this.t;
  timers = { set: (fn: () => void, ms: number) => { const id = ++this.n; this.queue.push({ id, at: this.t + ms, fn }); return id; }, clear: (id: unknown) => { this.queue = this.queue.filter(x => x.id !== id); } };
  advance(ms: number) { this.t += ms; }
}

async function setup(o: { fake?: FakeOptions; hookBase?: string; ips?: string[]; options?: Partial<EngineOptions>; pollOverrideMs?: number } = {}) {
  const store = new Store(':memory:'), maps = new Maps(store, 'Europe/London'), clock = new Clock();
  const hub = maps.default; hub.import(user.id, seedDoc(new Date(clock.t)));
  const fake = new FakeProvider({ webhooks: { https: true, publicAddress: true }, ...o.fake });
  const registry = new ProviderRegistry([fake]), credentials = new Credentials(store, SecretBox.fromKey(Buffer.alloc(32, 3)), registry);
  await credentials.save(user.id, 'fake', 'fake-alice');
  const ips = o.ips ?? ['93.184.216.34'];
  const engine = new TaskSyncEngine(maps, registry, credentials, 'hookBase' in o ? o.hookBase : PUBLIC, 3_600_000, o.pollOverrideMs, { now: clock.now, resolve: async () => ips, timers: clock.timers, ...o.options });
  const mapId = hub.mapId, doc = () => hub.doc, unit = (d: string) => doc().units.find(u => u.designation === d)!;
  const run = (text: string) => { const p = parse(text, doc(), { now: new Date(clock.t), providers: registry.info() }); if (!p.ok) throw new Error(p.error); return hub.submit(user.id, 'web', crypto.randomUUID(), p.cmd); };
  const bind = () => engine.request(mapId, { action: 'bind', provider: 'fake', name: 'Ops' }, user, 'web');
  const status = () => engine.request(mapId, { action: 'status' }, user, 'web');
  const calls = (method: string) => fake.calls.filter(c => c.method === method);
  const root = () => doc().settings.taskSync!.root;
  const sign = (body: string) => createHmac('sha256', (store.db.prepare('SELECT secret FROM ts_maps WHERE map_id=?').get(mapId) as { secret: string }).secret).update(body).digest('hex');
  const deliver = (body = '{"event":"changed"}') => engine.webhook('fake', mapId, new Headers({ 'x-fake-signature': sign(body) }), body);
  const planned = () => clock.queue.filter(x => x.at <= clock.t + 2000);
  return { store, maps, hub, clock, fake, registry, credentials, engine, mapId, doc, unit, run, bind, status, calls, root, deliver, planned };
}

describe('task sync engine: capabilities', () => {
  it('a provider without progress gets no BDA writes, and its progress is ignored', async () => {
    const t = await setup({ fake: { fields: ['title', 'due', 'note', 'status', 'container', 'affiliation', 'parent'] } });
    await t.bind();
    t.fake.calls.length = 0;
    t.run('/bda LEAK 25%');
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.calls('updateTask')).toEqual([]);
    const strength = t.unit('LEAK').strength;
    t.fake.remoteUpdate(t.unit('LEAK').remote!, { progress: 0.9 });
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.unit('LEAK').strength).toBe(strength);
    expect(t.calls('createTask').every(c => !('progress' in (c.args[1] as object)))).toBe(true);
  });

  it('a provider without relations gets no relation calls from /link', async () => {
    const t = await setup({ fake: { relations: [] } });
    await t.bind();
    t.fake.calls.length = 0;
    t.run('/link RECORDS IRSRSP');
    expect(await t.engine.run(t.mapId)).not.toMatch(/failed/);
    expect(t.calls('relate')).toEqual([]);
  });

  it('rate limited partway through: the links made so far are kept, status says so, and the next cycle makes no duplicates', async () => {
    const t = await setup();
    let limit = true, n = 0;
    const connect = t.fake.connect.bind(t.fake);
    t.fake.connect = (token: string): ProviderSession => {
      const s = connect(token);
      return { ...s, createTask: async (...a) => { if (limit && ++n === 3) throw new RateLimited(30); return s.createTask(...a); } };
    };
    await expect(t.bind()).rejects.toThrow('rate limited, retrying in 30s');
    expect(t.doc().units.filter(u => u.remote !== undefined)).toHaveLength(2);
    expect(t.fake.tasks.size).toBe(2);
    expect(await t.status()).toMatch(/last error: rate limited, retrying in 30s/);
    expect(t.clock.queue.some(x => x.at === t.clock.t + 30_000)).toBe(true);
    limit = false;
    await t.engine.run(t.mapId);
    const linked = t.doc().units.filter(u => u.remote !== undefined);
    expect(t.fake.tasks.size).toBe(linked.length);
    expect(new Set(linked.map(u => u.remote)).size).toBe(linked.length);
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled, 0 tasks created, 0 new units$/);
    expect(await t.status()).not.toMatch(/last error/);
  });

  it('lists containers that match no sector, and moves a linked task back out of one', async () => {
    const t = await setup();
    await t.bind();
    const home = t.fake.remoteContainer(t.root(), 'Home');
    t.fake.remoteCreate(t.root(), { title: 'Laundry', container: home.id });
    t.fake.remoteCreate(t.root(), { title: 'Dishes', container: home.id });
    await t.engine.run(t.mapId);
    expect(t.doc().units.some(u => u.title === 'Laundry')).toBe(false);
    expect(await t.status()).toMatch(/ · not synced: section Home \(2 tasks\)/);
    const leak = t.unit('LEAK'), sector = t.doc().sectors.find(s => s.id === leak.sectorId)!;
    t.fake.remoteUpdate(leak.remote!, { container: home.id });
    await t.engine.run(t.mapId);
    expect(t.fake.tasks.get(leak.remote!)!.container).toBe(sector.remote);
    expect(t.unit('LEAK').sectorId).toBe(sector.id);
  });

  it('a child under a linked task arrives in its parent’s sector, attached; a child under an unlinked task is ignored', async () => {
    const t = await setup();
    await t.bind();
    const move = t.unit('MOVE');
    const child = t.fake.remoteCreate(t.root(), { title: 'Book the van', container: null, parent: move.remote! });
    const home = t.fake.remoteContainer(t.root(), 'Home');
    const outside = t.fake.remoteCreate(t.root(), { title: 'Outside', container: home.id });
    t.fake.remoteCreate(t.root(), { title: 'Orphan child', container: null, parent: outside.id });
    await t.engine.run(t.mapId);
    const u = t.doc().units.find(x => x.remote === child.id)!;
    expect(u).toMatchObject({ title: 'Book the van', sectorId: move.sectorId, parentId: move.id });
    expect(t.doc().units.some(x => x.title === 'Orphan child')).toBe(false);
    // The task had no identity: it gets the unit's (pending) once, then nothing echoes.
    expect(await t.engine.run(t.mapId)).toMatch(/^1 pushed, 0 pulled/);
    expect(t.fake.tasks.get(child.id)!.affiliations).toEqual(['pending']);
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
  });

  it('a new task force and its new member: the parent task is made first, and the member is made under it', async () => {
    const t = await setup();
    await t.bind();
    t.run('/new "Plan the party" in Family near as PARTY');
    t.run('/new "Order the cake" in Family near as CAKE');
    t.run('/attach CAKE to PARTY');
    t.fake.calls.length = 0;
    await t.engine.run(t.mapId);
    const made = t.calls('createTask').map(c => c.args[1] as { title: string; parent?: string });
    expect(made.map(f => f.title)).toEqual(['Plan the party', 'Order the cake']);
    expect(made[1].parent).toBe(t.unit('PARTY').remote);
    expect(made[0].parent).toBeUndefined();
    expect(t.calls('updateTask')).toEqual([]);
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
  });
  it('a member kept only under its parent is detached into its sector’s container in the same write', async () => {
    const t = await setup();
    await t.bind();
    const packing = t.unit('PACKING'), container = t.doc().sectors.find(s => s.id === packing.sectorId)!.remote!;
    expect(t.fake.tasks.get(packing.remote!)).toMatchObject({ parent: t.unit('MOVE').remote, container: null });
    t.run('/detach PACKING');
    t.fake.calls.length = 0;
    await t.engine.run(t.mapId);
    expect(t.calls('updateTask').map(c => c.args[2])).toEqual([{ parent: null, container }]);
    expect(t.fake.tasks.get(packing.remote!)).toMatchObject({ parent: null, container });
  });
  it('pulled ops carry the provider id as via', async () => {
    const t = await setup();
    await t.bind();
    t.fake.remoteUpdate(t.unit('LEAK').remote!, { title: 'Roof leak, again' });
    await t.engine.run(t.mapId);
    expect(t.doc().log.at(-1)).toMatchObject({ text: expect.stringMatching(/^FAKE: /), via: 'fake' });
    expect(t.hub.since(0).at(-1)).toMatchObject({ via: 'fake', source: 'system' });
  });
});

describe('task sync engine: delivery modes', () => {
  it.each([
    ['unset', undefined, ['93.184.216.34'], 'webhooks need PUBLIC_URL to be an address Fake can reach'],
    ['loopback', 'http://127.0.0.1:8080', ['127.0.0.1'], 'webhooks off: Fake needs a public HTTPS address; PUBLIC_URL is a loopback address'],
    ['a .lan name', 'http://opsmap.lan', ['192.168.1.20'], 'webhooks off: Fake needs a public HTTPS address; PUBLIC_URL is a private name (.lan)'],
    ['a tailnet name', 'https://opsmap.ribbon.ts.net', ['100.101.1.2'], 'webhooks off: Fake needs a public HTTPS address; PUBLIC_URL is a private name (.ts.net)'],
    ['a name that resolves to a tailnet address', 'https://ops.example.com', ['100.101.1.2'], 'webhooks off: Fake needs a public HTTPS address; PUBLIC_URL is a private address (100.101.1.2)'],
  ])('PUBLIC_URL %s: off, with no webhook calls, no error and the reason in status', async (_name, hookBase, ips, reason) => {
    const t = await setup({ hookBase, ips });
    expect(await t.bind()).not.toMatch(/failed/);
    expect(t.calls('ensureWebhooks')).toEqual([]);
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'off', reason, nextPollMs: 60_000 });
    expect(await t.status()).toContain(`polling every minute (${reason})`);
  });

  it('TASKSYNC_WEBHOOKS=off turns webhooks off even for a public HTTPS address', async () => {
    const t = await setup({ options: { webhooks: 'off' } });
    await t.bind();
    expect(t.calls('ensureWebhooks')).toEqual([]);
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'off', reason: 'webhooks are off (TASKSYNC_WEBHOOKS=off)' });
  });

  it('TASKSYNC_WEBHOOKS=on registers on a private address; auto does only when the provider allows it', async () => {
    const lan = await setup({ hookBase: 'http://192.168.1.20:8080', ips: ['192.168.1.20'], options: { webhooks: 'on' }, fake: { webhooks: { https: false, publicAddress: false } } });
    await lan.bind();
    expect(lan.calls('ensureWebhooks')).toHaveLength(1);
    expect(lan.calls('ensureWebhooks')[0].args[2]).toBe(`http://192.168.1.20:8080/api/tasksync/fake/hook/${lan.mapId}`);
    expect(lan.engine.delivery(lan.mapId)).toMatchObject({ mode: 'pending', nextPollMs: 60_000 });
    expect(await lan.status()).toMatch(/5 webhooks, none delivered yet · polling every minute/);
    const auto = await setup({ hookBase: 'http://192.168.1.20:8080', ips: ['192.168.1.20'], fake: { webhooks: { https: false, publicAddress: false } } });
    await auto.bind();
    expect(auto.engine.delivery(auto.mapId).mode).toBe('pending');
    const strict = await setup({ hookBase: 'http://192.168.1.20:8080', ips: ['192.168.1.20'] });
    await strict.bind();
    expect(strict.engine.delivery(strict.mapId).mode).toBe('off');
    const forced = await setup({ hookBase: 'http://192.168.1.20:8080', ips: ['192.168.1.20'], options: { webhooks: 'on' } });
    await forced.bind();
    expect(forced.engine.delivery(forced.mapId).mode).toBe('pending');
  });

  it('pending polls every pollMs; a signed delivery makes it live at idlePollMs; 15 minutes without one returns it to pending', async () => {
    const t = await setup();
    await t.bind();
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'pending', nextPollMs: 60_000 });
    t.clock.queue = [];
    t.clock.advance(59_000); t.engine.poll();
    expect(t.planned()).toEqual([]);
    t.clock.advance(1_000); t.engine.poll();
    expect(t.planned()).toHaveLength(1);
    await t.engine.run(t.mapId); t.clock.queue = [];
    expect(t.deliver()).toMatchObject({ status: 200, trigger: true });
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'live', nextPollMs: 300_000, lastDelivery: new Date(t.clock.t).toISOString() });
    expect(t.planned()).toHaveLength(1);
    await t.engine.run(t.mapId); t.clock.queue = [];
    t.clock.advance(60_000); t.engine.poll();
    expect(t.planned()).toEqual([]);
    t.clock.advance(240_000); t.engine.poll();
    expect(t.planned()).toHaveLength(1);
    await t.engine.run(t.mapId); t.clock.queue = [];
    t.clock.advance(15 * 60_000 - 300_000);
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'pending', nextPollMs: 60_000 });
    const unsigned = t.engine.webhook('fake', t.mapId, new Headers({ 'x-fake-signature': 'nope' }), '{}');
    expect(unsigned).toMatchObject({ status: 401, trigger: false });
  });

  it('registration refused: failed with the reason, retried at the 10-minute check with backoff to 6 hours, and polling goes on', async () => {
    const t = await setup();
    t.fake.failNext('ensureWebhooks', new Error('Fake refused the webhook'));
    expect(await t.bind()).not.toMatch(/failed/);
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'failed', reason: 'Fake refused the webhook', nextPollMs: 60_000, retryAt: new Date(t.clock.t + 10 * 60_000).toISOString() });
    expect(await t.status()).toMatch(/webhooks failed: Fake refused the webhook, retrying at \d\d:\d\d:\d\dZ · polling every minute/);
    t.clock.advance(5 * 60_000);
    await t.engine.run(t.mapId);
    expect(t.calls('ensureWebhooks')).toHaveLength(1);
    t.clock.queue = []; t.clock.advance(60_000); t.engine.poll();
    expect(t.planned()).toHaveLength(1);
    let wait = 10 * 60_000;
    for (let i = 0; i < 8; i++) {
      t.clock.advance(wait);
      t.fake.failNext('ensureWebhooks', new Error('Fake refused the webhook'));
      await t.engine.run(t.mapId);
      expect(t.calls('ensureWebhooks')).toHaveLength(2 + i);
      wait = Math.min(wait * 2, 6 * 3_600_000);
      expect(t.engine.delivery(t.mapId).retryAt).toBe(new Date(t.clock.t + wait).toISOString());
    }
    expect(wait).toBe(6 * 3_600_000);
    t.clock.advance(wait);
    await t.engine.run(t.mapId);
    expect(t.engine.delivery(t.mapId).mode).toBe('pending');
  });

  it('no handshake within handshakeTimeoutMs: failed, and tried again at the next check', async () => {
    const t = await setup({ fake: { webhooks: { https: true, publicAddress: true, handshakeTimeoutMs: 30_000 } } });
    await t.bind();
    expect(t.engine.delivery(t.mapId).mode).toBe('pending');
    t.clock.advance(31_000);
    expect(t.engine.delivery(t.mapId)).toMatchObject({ mode: 'failed', reason: 'no handshake from Fake within 30 s', nextPollMs: 60_000 });
    await t.engine.run(t.mapId);
    expect(t.calls('ensureWebhooks')).toHaveLength(1);
    t.clock.advance(10 * 60_000);
    await t.engine.run(t.mapId);
    expect(t.calls('ensureWebhooks')).toHaveLength(2);
    expect(t.deliver()).toMatchObject({ status: 200 });
    t.clock.advance(31_000);
    expect(t.engine.delivery(t.mapId).mode).toBe('live');
  });

  it('a handshake that arrives while ensureWebhooks is still open is kept: the mode never goes to failed', async () => {
    const t = await setup({ fake: { webhooks: { https: true, publicAddress: true, handshakeTimeoutMs: 30_000 } } });
    t.fake.duringEnsureWebhooks = () => { expect(t.deliver()).toMatchObject({ status: 200 }); };
    await t.bind();
    expect(t.calls('ensureWebhooks')).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      t.clock.advance(31_000);
      expect(t.engine.delivery(t.mapId).mode).not.toBe('failed');
      await t.engine.run(t.mapId);
      expect(t.engine.delivery(t.mapId).mode).not.toBe('failed');
    }
    t.clock.advance(10 * 60_000);
    await t.engine.run(t.mapId);
    expect(t.engine.delivery(t.mapId).mode).not.toBe('failed');
  });

  it('after a missing handshake, status says when it retries, and the retry registers again (force)', async () => {
    const t = await setup({ fake: { webhooks: { https: true, publicAddress: true, handshakeTimeoutMs: 30_000 } } });
    await t.bind();
    t.clock.advance(31_000);
    expect(await t.status()).toMatch(/webhooks failed: no handshake from Fake within 30 s, retrying at \d\d:\d\d:\d\dZ · polling every minute/);
    await t.engine.run(t.mapId);
    expect(await t.status()).toMatch(/retrying at \d\d:\d\d:\d\dZ/);
    t.clock.advance(10 * 60_000);
    await t.engine.run(t.mapId);
    expect(t.calls('ensureWebhooks').map(c => c.args[3])).toEqual([true, true]);
  });

  it('when webhooks are not live, a nudge pulls within 2 s, at most once per 20 s per map; when live it does nothing', async () => {
    const t = await setup({ hookBase: undefined });
    await t.bind(); t.clock.queue = [];
    t.engine.nudge(t.mapId);
    expect(t.planned()).toHaveLength(1);
    t.clock.queue = []; t.clock.advance(5_000);
    t.engine.nudge(t.mapId);
    expect(t.clock.queue).toEqual([]);
    t.clock.advance(15_000);
    t.engine.nudge(t.mapId);
    expect(t.planned()).toHaveLength(1);
    const live = await setup();
    await live.bind(); live.deliver(); await live.engine.run(live.mapId); live.clock.queue = [];
    live.engine.nudge(live.mapId);
    expect(live.clock.queue).toEqual([]);
  });

  it('TASKSYNC_POLL_SECONDS overrides pollMs, never below 15 s', async () => {
    expect(pollOverride({ TASKSYNC_POLL_SECONDS: '15' })).toBe(15_000);
    expect(pollOverride({ TASKSYNC_POLL_SECONDS: '5' })).toBe(15_000);
    expect(pollOverride({ TASKSYNC_POLL_SECONDS: '90' })).toBe(90_000);
    expect(pollOverride({ TASKSYNC_POLL_SECONDS: 'soon' })).toBeUndefined();
    expect(pollOverride({})).toBeUndefined();
    const t = await setup({ hookBase: undefined, pollOverrideMs: 5_000 });
    await t.bind();
    expect(t.engine.delivery(t.mapId).nextPollMs).toBe(15_000);
    expect(await t.status()).toContain('polling every 15 seconds');
  });

  it('a bound map whose owner has no token is not polled, and status says no token', async () => {
    const t = await setup({ hookBase: undefined });
    await t.bind();
    t.credentials.remove(user.id, 'fake');
    t.clock.queue = []; t.clock.advance(3_600_000); t.engine.poll();
    expect(t.clock.queue).toEqual([]);
    expect(await t.status()).toMatch(/by u1 \(no token: connect it in the menu → Fake\)/);
  });
});

describe('task sync engine: field switches (D21)', () => {
  const nulls = (t: Awaited<ReturnType<typeof setup>>) => t.calls('updateTask').filter(c => (c.args[2] as { affiliation?: unknown }).affiliation === null);
  const affiliationWrites = (t: Awaited<ReturnType<typeof setup>>) => t.calls('updateTask').filter(c => (c.args[2] as { affiliation?: unknown }).affiliation !== undefined);
  const taskOf = (t: Awaited<ReturnType<typeof setup>>, d: string) => t.fake.tasks.get(t.unit(d).remote!)!;

  it('/tasks field is a user op: it logs, and /undo turns the field back on', async () => {
    const t = await setup();
    await t.bind();
    const op = t.run('/tasks field identity off');
    expect(op.log).toBe('FAKE IDENTITY SYNC OFF');
    expect(t.doc().settings.taskSync?.off).toEqual(['identity']);
    t.hub.undo(user.id, crypto.randomUUID());
    expect(t.doc().settings.taskSync).not.toHaveProperty('off');
    expect(t.doc().settings.taskSync).toMatchObject({ provider: 'fake', title: 'Ops' });
  });

  it('switching identity off removes the identity from every linked task, once', async () => {
    const t = await setup();
    await t.bind();
    const linked = t.doc().units.filter(u => u.remote !== undefined);
    expect(linked.every(u => t.fake.tasks.get(u.remote!)!.affiliations.length === 1)).toBe(true);
    t.fake.calls.length = 0;
    t.run('/tasks field identity off');
    await t.engine.run(t.mapId);
    expect(nulls(t).map(c => c.args[1] as string).sort()).toEqual(linked.map(u => u.remote!).sort());
    expect(linked.every(u => t.fake.tasks.get(u.remote!)!.affiliations.length === 0)).toBe(true);
    // The units keep their identity.
    expect(t.unit('LEAK').affiliation).toBe('hostile');
    t.fake.calls.length = 0;
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.calls('updateTask')).toEqual([]);
  });

  it('with identity off, /id writes nothing remotely and a remote identity does not change the unit', async () => {
    const t = await setup();
    await t.bind();
    t.run('/tasks field identity off');
    await t.engine.run(t.mapId);
    t.fake.calls.length = 0;
    t.run('/id IRSRSP neutral');
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(affiliationWrites(t)).toEqual([]);
    t.fake.remoteUpdate(t.unit('LEAK').remote!, { affiliations: ['friend'] });
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.unit('LEAK').affiliation).toBe('hostile');
    expect(taskOf(t, 'LEAK').affiliations).toEqual(['friend']);
  });

  it('switching identity back on pushes opsmap\'s identity, and the old remote value never comes back', async () => {
    const t = await setup();
    await t.bind();
    t.run('/tasks field identity off');
    await t.engine.run(t.mapId);
    // Meanwhile someone labels LEAK's task friendly in the service, and opsmap changes IRSRSP.
    t.fake.remoteUpdate(t.unit('LEAK').remote!, { affiliations: ['friend'] });
    t.run('/id IRSRSP neutral');
    await t.engine.run(t.mapId);
    t.run('/tasks field identity on');
    t.fake.calls.length = 0;
    await t.engine.run(t.mapId);
    expect(t.unit('LEAK').affiliation).toBe('hostile');
    expect(taskOf(t, 'LEAK').affiliations).toEqual(['hostile']);
    expect(taskOf(t, 'IRSRSP').affiliations).toEqual(['neutral']);
    expect(t.doc().units.filter(u => u.remote !== undefined).every(u => t.fake.tasks.get(u.remote!)!.affiliations[0] === u.affiliation)).toBe(true);
    t.fake.calls.length = 0;
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.unit('LEAK').affiliation).toBe('hostile');
  });

  it('a field switched back on before a cycle ran is not cleaned up', async () => {
    const t = await setup();
    await t.bind();
    t.run('/tasks field identity off');
    t.run('/tasks field identity on');
    t.fake.calls.length = 0;
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(nulls(t)).toEqual([]);
  });

  it('state switched back on is re-based too: opsmap\'s state wins once', async () => {
    const t = await setup();
    await t.bind();
    t.run('/tasks field state off');
    await t.engine.run(t.mapId);
    t.fake.remoteUpdate(t.unit('IRSRSP').remote!, { status: 'done' });
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.unit('IRSRSP').lifecycle).toBe('active');
    t.run('/tasks field state on');
    await t.engine.run(t.mapId);
    expect(t.unit('IRSRSP').lifecycle).toBe('active');
    expect(taskOf(t, 'IRSRSP').status).toBe('active');
  });

  it('with identity off, new tasks carry no identity and new remote tasks arrive as pending', async () => {
    const t = await setup();
    await t.engine.request(t.mapId, { action: 'bind', provider: 'fake', name: 'Ops', off: ['identity'] }, user, 'web');
    expect(t.doc().settings.taskSync?.off).toEqual(['identity']);
    expect(t.calls('createTask').length).toBeGreaterThan(0);
    expect(t.calls('createTask').every(c => !('affiliation' in (c.args[1] as object)))).toBe(true);
    expect(nulls(t)).toEqual([]);
    const household = t.doc().sectors.find(s => s.id === 'household')!.remote!;
    t.fake.remoteCreate(t.root(), { title: 'Parking ticket', container: household }, 'hostile');
    await t.engine.run(t.mapId);
    expect(t.doc().units.find(u => u.title === 'Parking ticket')).toMatchObject({ affiliation: 'pending' });
    t.fake.calls.length = 0;
    // Its labels are ignored, not removed.
    expect(await t.engine.run(t.mapId)).toMatch(/^0 pushed, 0 pulled/);
    expect(t.calls('updateTask')).toEqual([]);
  });

  it('a task linked by its title while identity is off keeps its identity', async () => {
    const t = await setup();
    await t.engine.request(t.mapId, { action: 'bind', provider: 'fake', name: 'Ops', off: ['identity'] }, user, 'web');
    const work = t.doc().sectors.find(s => s.id === 'work')!.remote!;
    const twin = t.fake.remoteCreate(t.root(), { title: 'Fix fence', container: work }, 'hostile');
    t.run('/new "Fix fence" in Work');
    t.fake.calls.length = 0;
    await t.engine.run(t.mapId);
    expect(t.doc().units.find(u => u.title === 'Fix fence')?.remote).toBe(twin.id);
    expect(t.fake.tasks.get(twin.id)!.affiliations).toEqual(['hostile']);
    expect(nulls(t)).toEqual([]);
  });

  it('a task made in the service keeps its identity when identity is switched off', async () => {
    const t = await setup();
    await t.bind();
    const household = t.doc().sectors.find(s => s.id === 'household')!.remote!;
    const made = t.fake.remoteCreate(t.root(), { title: 'Parking ticket', container: household }, 'hostile');
    await t.engine.run(t.mapId);
    expect(t.doc().units.find(u => u.remote === made.id)).toMatchObject({ affiliation: 'hostile' });
    t.run('/tasks field identity off');
    t.fake.calls.length = 0;
    await t.engine.run(t.mapId);
    expect(t.fake.tasks.get(made.id)!.affiliations).toEqual(['hostile']);
    // The tasks opsmap made lose theirs.
    expect(nulls(t).map(c => c.args[1])).not.toContain(made.id);
    expect(taskOf(t, 'LEAK').affiliations).toEqual([]);
  });

  it('a link agreed before D21 counts as pushed when the task carries exactly the unit\'s identity', async () => {
    const t = await setup();
    await t.bind();
    const strip = (d: string) => { const u = t.unit(d), b = t.engine.tables.base(t.mapId, u.id)!; delete b.idPushed; t.engine.tables.setBase(t.mapId, u.id, u.remote!, b); };
    strip('LEAK'); strip('IRSRSP');
    // IRSRSP's task names another identity than its unit: not opsmap's label.
    t.fake.remoteUpdate(t.unit('IRSRSP').remote!, { affiliations: ['neutral'] });
    t.run('/tasks field identity off');
    await t.engine.run(t.mapId);
    expect(taskOf(t, 'LEAK').affiliations).toEqual([]);
    expect(taskOf(t, 'IRSRSP').affiliations).toEqual(['neutral']);
  });

  it('/tasks status lists the fields that are off, in order', async () => {
    const t = await setup();
    await t.bind();
    expect(await t.status()).not.toMatch(/not synced/);
    t.run('/tasks field state off');t.run('/tasks field identity off');
    expect(await t.status()).toMatch(/ · \d+ units linked · not synced: identity, state · /);
  });
});
