import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../../server/app';
import type { Config } from '../../server/config';

// The HTTP and WebSocket edges of the Vikunja sync, with a Vikunja that cannot be reached.
describe('Vikunja over HTTP and WebSocket', () => {
  let dir: string, settings: Config, runtime: ReturnType<typeof startServer>, url: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'opsmap-vk-'));
    const clientDir = join(dir, 'client'); mkdirSync(clientDir); writeFileSync(join(clientDir, 'index.html'), '<!doctype html>');
    settings = { port: 0, host: '127.0.0.1', publicUrl: 'http://localhost', dataDir: dir, clientDir, devUsers: ['alice'], adminEmails: ['alice@dev.local'], group: 'g', tz: 'UTC', vikunja: { url: 'http://127.0.0.1:9' } };
    runtime = startServer(settings, { schedule: false });
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
    expect((await fetch(`${url}/api/vikunja/account`)).status).toBe(401);
    expect(await (await fetch(`${url}/api/vikunja/account`, { headers: { cookie } })).json()).toEqual({ configured: true, url: 'http://127.0.0.1:9', connected: false });
    const put = (origin: string) => fetch(`${url}/api/vikunja/account`, { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tk_some_token_value' }) });
    expect((await put('https://evil.invalid')).status).toBe(403);
    const res = await put(settings.publicUrl);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Could not reach Vikunja/);
  });

  it('webhook: only a delivery signed with the map secret is accepted', async () => {
    runtime.store.db.prepare("INSERT INTO vk_maps(map_id,secret) VALUES('main','s3cret')").run();
    const body = JSON.stringify({ event_name: 'task.updated', time: new Date().toISOString(), data: {} });
    const post = (signature?: string, map = 'main') => fetch(`${url}/api/vikunja/hook/${map}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-vikunja-signature': signature } : {}) }, body });
    expect((await post(createHmac('sha256', 's3cret').update(body).digest('hex'))).status).toBe(200);
    expect((await post(createHmac('sha256', 'wrong').update(body).digest('hex'))).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect((await post('x', 'nope')).status).toBe(401);
    expect((runtime.store.db.prepare("SELECT last_delivery FROM vk_maps WHERE map_id='main'").get() as { last_delivery: string | null }).last_delivery).not.toBeNull();
  });

  it('the welcome names Vikunja, and /vk requests are answered over the socket', async () => {
    const cookie = await login();
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: settings.publicUrl } });
    const messages: Record<string, any>[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    const next = async (t: string) => { for (let i = 0; i < 200; i++) { const m = messages.find(x => x.t === t); if (m) { messages.splice(messages.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 10)); } throw new Error(`no ${t}`); };
    ws.send(JSON.stringify({ t: 'hello', since: 0 }));
    expect((await next('welcome')).vikunja).toEqual({ url: 'http://127.0.0.1:9' });
    const opId = randomUUID();
    ws.send(JSON.stringify({ t: 'vk', opId, args: { action: 'status' } }));
    expect(await next('vk')).toMatchObject({ opId, ok: true, log: expect.stringMatching(/not bound/) });
    ws.send(JSON.stringify({ t: 'vk', opId: randomUUID(), args: { action: 'bind', name: 'Ops' } }));
    expect(await next('vk')).toMatchObject({ ok: false, error: expect.stringMatching(/No Vikunja token/) });
    ws.send(JSON.stringify({ t: 'vk', opId: randomUUID(), args: { action: 'bound', project: 1 } }));
    expect((await next('reject')).error).toBe('Invalid /vk request');
    ws.terminate();
  });
});
