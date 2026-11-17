import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startServer } from '../../server/app';
import type { Config } from '../../server/config';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { FakeProvider } from './fake-provider';

// The generic task sync routes, with the in-memory provider.
describe('/api/tasksync/:provider/account', () => {
  let dir: string, settings: Config, runtime: ReturnType<typeof startServer>, url: string;
  const start = async (registry: ProviderRegistry) => {
    dir = mkdtempSync(join(tmpdir(), 'opsmap-ts-'));
    const clientDir = join(dir, 'client'); mkdirSync(clientDir); writeFileSync(join(clientDir, 'index.html'), '<!doctype html>');
    settings = { port: 0, host: '127.0.0.1', publicUrl: 'http://localhost', dataDir: dir, clientDir, devUsers: ['alice'], adminEmails: ['alice@dev.local'], group: 'g', tz: 'UTC' };
    runtime = startServer(settings, { schedule: false, registry });
    if (!runtime.server.listening) await once(runtime.server, 'listening');
    url = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  };
  beforeEach(() => start(new ProviderRegistry([new FakeProvider()])));
  afterEach(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const login = async () => (await fetch(`${url}/auth/dev-login?user=alice`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
  const account = (cookie: string, method = 'GET', body?: unknown, origin = settings.publicUrl) =>
    fetch(`${url}/api/tasksync/fake/account`, { method, headers: { cookie, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('connects, shows and removes a token, never returning it', async () => {
    const cookie = await login();
    expect((await fetch(`${url}/api/tasksync/fake/account`)).status).toBe(401);
    expect(await (await account(cookie)).json()).toEqual({ provider: 'fake', connected: false });
    const bad = await account(cookie, 'PUT', { token: 'tk_wrong_token' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Fake refused that token' });
    expect((await account(cookie, 'PUT', { token: 'fake-alice' }, 'https://evil.invalid')).status).toBe(403);
    const text = await (await account(cookie, 'PUT', { token: 'fake-alice' })).text();
    expect(JSON.parse(text)).toEqual({ ok: true, provider: 'fake', connected: true, username: 'alice', savedAt: expect.any(String) });
    expect(text).not.toContain('fake-alice');
    expect(await (await account(cookie)).json()).toMatchObject({ provider: 'fake', connected: true, username: 'alice' });
    expect((await account(cookie, 'DELETE', undefined, 'https://evil.invalid')).status).toBe(403);
    expect(await (await account(cookie, 'DELETE')).json()).toEqual({ ok: true, provider: 'fake', connected: false });
    expect(await (await account(cookie)).json()).toEqual({ provider: 'fake', connected: false });
    expect(existsSync(join(dir, 'secrets', 'master.key'))).toBe(true);
  });

  it('over the socket: the welcome lists the field switches, status carries the delivery mode, and tasks-nudge nudges', async () => {
    const cookie = await login();
    await account(cookie, 'PUT', { token: 'fake-alice' });
    const nudge = vi.spyOn(runtime.sync!, 'nudge');
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: settings.publicUrl } });
    const messages: Record<string, any>[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    const next = async (t: string) => { for (let i = 0; i < 300; i++) { const m = messages.find(x => x.t === t); if (m) { messages.splice(messages.indexOf(m), 1); return m; } await new Promise(r => setTimeout(r, 10)); } throw new Error(`no ${t}`); };
    ws.send(JSON.stringify({ t: 'hello', since: 0 }));
    expect((await next('welcome')).taskSync).toEqual([expect.objectContaining({ id: 'fake', fields: ['identity', 'state', 'due', 'note', 'progress'] })]);
    expect(nudge).toHaveBeenCalledTimes(1);
    // Not bound: no delivery mode.
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'status' } }));
    expect((await next('tasks')).delivery).toBeUndefined();
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'bind', provider: 'fake', name: 'Ops' } }));
    expect(await next('tasks')).toMatchObject({ ok: true, log: expect.stringMatching(/^FAKE BOUND TO OPS/) });
    expect(messages.find(m => m.t === 'tasks')).toBeUndefined();
    // PUBLIC_URL is localhost: polling every minute, webhooks off; the full reason for the tooltip.
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'status' } }));
    const status = await next('tasks');
    expect(status).toMatchObject({ ok: true, log: expect.stringMatching(/^FAKE: bound to Ops/) });
    expect(status.delivery).toEqual({ mode: 'off', summary: 'Checking every 1 min. Instant updates need an address Fake can reach.', reason: 'webhooks need PUBLIC_URL to be an address Fake can reach' });
    // Sync answers carry none.
    ws.send(JSON.stringify({ t: 'tasks', opId: randomUUID(), args: { action: 'sync' } }));
    expect((await next('tasks')).delivery).toBeUndefined();
    ws.send(JSON.stringify({ t: 'tasks-nudge' }));
    ws.send(JSON.stringify({ t: 'ping' }));
    await next('pong');
    expect(nudge).toHaveBeenCalledTimes(2);
    expect(nudge).toHaveBeenLastCalledWith(runtime.hub.mapId);
    ws.terminate();
  });

  it('answers 404 for a service this server does not have', async () => {
    const cookie = await login();
    const res = await fetch(`${url}/api/tasksync/nope/account`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown task service: nope' });
  });

  it('without any task service, makes no secret key and the welcome lists none', async () => {
    await runtime.close(); rmSync(dir, { recursive: true, force: true });
    await start(new ProviderRegistry([]));
    expect(existsSync(join(dir, 'secrets', 'master.key'))).toBe(false);
    expect((await fetch(`${url}/api/tasksync/fake/account`, { headers: { cookie: await login() } })).status).toBe(404);
  });
});
