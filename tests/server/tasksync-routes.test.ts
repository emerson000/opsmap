// The generic webhook route on its own, with a stub sync service: once refusals have emptied a bucket, a request is
// read only when the provider's preverify (a cheap check of the URL against stored state) passes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Auth } from '../../server/auth';
import type { Config } from '../../server/config';
import { taskSyncRoutes } from '../../server/tasksync/routes';
import { ProviderRegistry } from '../../server/tasksync/registry';
import type { SyncService } from '../../server/tasksync/service';

function setup(preverify?: (provider: string, mapId: string, url: string) => boolean) {
  const seen: { provider: string; mapId: string; url?: string; body: string }[] = [], checked: unknown[][] = [];
  const sync: SyncService = {
    request: async () => '', nudge: () => {}, start: () => {}, stop: async () => {},
    webhook: (provider, mapId, headers, body, url) => { seen.push({ provider, mapId, url, body }); return headers.get('x-ok') ? { status: 200, trigger: true } : { status: 401, trigger: false }; },
    ...(preverify ? { preverify: (p: string, m: string, u: string) => { checked.push([p, m, u]); return preverify(p, m, u); } } : {}),
  };
  const app = new Hono();
  taskSyncRoutes(app, { config: {} as Config, auth: {} as Auth, registry: ProviderRegistry.fromEnv({ ASANA_SYNC: '1' }), sync });
  const post = (headers: Record<string, string> = {}, body: string | ReadableStream = '{}') => app.request('http://opsmap.example/api/tasksync/asana/hook/main?h=n0nce', { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
  /** A body that records whether anything read it. */
  const watched = () => { const s = { pulled: false, body: new ReadableStream({ pull(c) { s.pulled = true; c.enqueue(new TextEncoder().encode('{}')); c.close(); } }, { highWaterMark: 0 }) }; return s; };
  const spam = async () => { const out: number[] = []; for (let i = 0; i < 70; i++) out.push((await post()).status); expect(out).toContain(429); };
  return { seen, checked, post, watched, spam };
}

describe('webhook route: the limiter bounds work', () => {
  // The buckets refill with Date.now: hold the clock still so a test sees exactly the tokens it spent.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  it('with the map’s bucket empty, a request preverify refuses gets 429 and its body is never read', async () => {
    const t = setup(() => false);
    await t.spam();
    const before = t.seen.length, w = t.watched(), res = await t.post({ 'x-ok': '1' }, w.body);
    expect(res.status).toBe(429); expect(res.headers.get('retry-after')).toBe('1');
    expect(w.pulled).toBe(false);
    expect(t.seen.length).toBe(before);
    expect(t.checked.at(-1)).toEqual(['asana', 'main', 'http://opsmap.example/api/tasksync/asana/hook/main?h=n0nce']);
  });
  it('a request preverify passes is read and verified as usual, and an accepted one is never limited', async () => {
    const t = setup(() => true);
    await t.spam();
    for (let i = 0; i < 30; i++) { const w = t.watched(); expect((await t.post({ 'x-ok': '1' }, w.body)).status).toBe(200); expect(w.pulled).toBe(true); }
    expect((await t.post()).status).toBe(429);
  });
  it('a provider without preverify gets 429 while the bucket is empty: it falls back to polling', async () => {
    const t = setup();
    await t.spam();
    const w = t.watched();
    expect((await t.post({ 'x-ok': '1' }, w.body)).status).toBe(429);
    expect(w.pulled).toBe(false);
  });
  it('before any refusal nothing is preverified, and bodies over 64 KiB are refused', async () => {
    const t = setup(() => false);
    expect((await t.post({ 'x-ok': '1' })).status).toBe(200);
    expect(t.checked).toEqual([]);
    expect((await t.post({ 'x-ok': '1' }, 'x'.repeat(64 * 1024))).status).toBe(200);
    expect((await t.post({ 'x-ok': '1' }, 'x'.repeat(64 * 1024 + 1))).status).toBe(400);
  });
});
