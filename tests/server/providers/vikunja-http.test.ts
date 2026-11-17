import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../../server/app';
import type { Config } from '../../../server/config';
import { ProviderRegistry } from '../../../server/tasksync/registry';
import { PROVIDERS } from '../../../server/providers';

// The HTTP and WebSocket edges of the Vikunja sync, with a Vikunja that cannot be reached.
describe('Vikunja over HTTP and WebSocket', () => {
  let dir: string, settings: Config, runtime: ReturnType<typeof startServer>, url: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'opsmap-vk-'));
    const clientDir = join(dir, 'client'); mkdirSync(clientDir); writeFileSync(join(clientDir, 'index.html'), '<!doctype html>');
    settings = { port: 0, host: '127.0.0.1', publicUrl: 'http://localhost', dataDir: dir, clientDir, devUsers: ['alice'], adminEmails: ['alice@dev.local'], group: 'g', tz: 'UTC' };
    runtime = startServer(settings, { schedule: false, registry: ProviderRegistry.fromEnv({ VIKUNJA_URL: 'http://127.0.0.1:9' }, PROVIDERS) });
    if (!runtime.server.listening) await once(runtime.server, 'listening');
    url = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  });
  afterEach(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const login = async () => (await fetch(`${url}/auth/dev-login?user=alice`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];

  it('creates the secret key file, readable by the owner only', () => {
    expect(statSync(join(dir, 'secrets', 'master.key')).mode & 0o777).toBe(0o600);
  });

  it('account: signed in only, same origin for changes, never the token', async () => {
    const cookie = await login();
    expect((await fetch(`${url}/api/tasksync/vikunja/account`)).status).toBe(401);
    expect(await (await fetch(`${url}/api/tasksync/vikunja/account`, { headers: { cookie } })).json()).toEqual({ provider: 'vikunja', connected: false });
    const put = (origin: string) => fetch(`${url}/api/tasksync/vikunja/account`, { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tk_some_token_value' }) });
    expect((await put('https://evil.invalid')).status).toBe(403);
    const res = await put(settings.publicUrl);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Could not reach Vikunja/);
    expect(await (await fetch(`${url}/api/tasksync/asana/account`, { headers: { cookie } })).json()).toEqual({ error: 'Unknown task service: asana' });
  });

  it('webhook: only a delivery signed with the map secret is accepted', async () => {
    // A map with its webhooks registered (a delivery counts for the delivery mode only then).
    runtime.store.db.prepare(`INSERT INTO ts_maps(map_id,provider,secret,hooks) VALUES('main','vikunja','s3cret','[{"project":40,"id":1}]')`).run();
    const body = JSON.stringify({ event_name: 'task.updated', time: new Date().toISOString(), data: {} });
    // The generic route, and the old one that Vikunja webhooks registered before task sync became provider-neutral.
    for (const path of ['/api/tasksync/vikunja/hook', '/api/vikunja/hook']) {
    const post = (signature?: string, map = 'main') => fetch(`${url}${path}/${map}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-vikunja-signature': signature } : {}) }, body });
    expect((await post(createHmac('sha256', 's3cret').update(body).digest('hex'))).status).toBe(200);
    expect((await post(createHmac('sha256', 'wrong').update(body).digest('hex'))).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect((await post('x', 'nope')).status).toBe(401);
    }
    expect((await fetch(`${url}/api/tasksync/asana/hook/main`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((runtime.store.db.prepare("SELECT last_delivery FROM ts_maps WHERE map_id='main'").get() as { last_delivery: string | null }).last_delivery).not.toBeNull();
  });

  it('the welcome describes Vikunja, and /tasks requests are answered over the socket', async () => {
    const cookie = await login();
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: settings.publicUrl } });
    const messages: Record<string, any>[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    const next = async (t: string) => { for (let i = 0; i < 200; i++) { const m = messages.find(x => x.t === t); if (m) { messages.splice(messages.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 10)); } throw new Error(`no ${t}`); };
    ws.send(JSON.stringify({ t: 'hello', since: 0 }));
    expect((await next('welcome')).taskSync).toEqual([expect.objectContaining({ id: 'vikunja', label: 'Vikunja', aliases: ['vk'], urls: expect.objectContaining({ task: 'http://127.0.0.1:9/tasks/{id}' }) })]);
    const opId = randomUUID();
    ws.send(JSON.stringify({ t: 'tasks', opId, args: { action: 'status' } }));
    expect(await next('tasks')).toMatchObject({ opId, ok: true, log: expect.stringMatching(/not bound/) });
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'bind', name: 'Ops' } }));
    expect(await next('tasks')).toMatchObject({ ok: false, error: expect.stringMatching(/No Vikunja token/) });
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'bind', provider: 'vikunja', name: 'Ops' } }));
    expect(await next('tasks')).toMatchObject({ ok: false, error: expect.stringMatching(/No Vikunja token/) });
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'bind', provider: 'asana', name: 'Ops' } }));
    expect((await next('reject')).error).toBe('Unknown task service: asana');
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'bound', project: 1 } }));
    expect((await next('reject')).error).toBe('Invalid /tasks request');
    ws.terminate();
  });
});
