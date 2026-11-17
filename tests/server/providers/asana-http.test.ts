import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { HttpAsApi, AsHttpError, TASK_FIELDS } from '../../../server/providers/asana/api';

// HttpAsApi against a local stub of Asana's REST API. Nothing here reaches the real Asana.
describe('HttpAsApi over HTTP', () => {
  let server: Server, base: string, seen: { method: string; url: string; auth?: string; body: string }[], reply: (req: IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; json?: unknown };
  beforeEach(async () => {
    seen = []; reply = () => ({ json: { data: [] } });
    server = createServer((req, res) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        const r = reply(req, body); res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers }); res.end(JSON.stringify(r.json ?? {}));
      });
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>(ok => server.close(() => ok())));

  it('sends the token as a Bearer header and unwraps data', async () => {
    reply = () => ({ json: { data: { gid: '1', name: 'Alice', workspaces: [{ gid: '9', name: 'W' }] } } });
    expect(await new HttpAsApi('tok123', base).me()).toMatchObject({ gid: '1' });
    expect(seen[0].auth).toBe('Bearer tok123'); expect(seen[0].url).toMatch(/^\/users\/me/);
  });

  it('follows next_page.offset with limit=100 and stops when next_page is null', async () => {
    reply = req => {
      const offset = new URL(req.url!, base).searchParams.get('offset');
      return offset === null ? { json: { data: [{ gid: '1' }], next_page: { offset: 'abc' } } } : offset === 'abc' ? { json: { data: [{ gid: '2' }], next_page: { offset: 'def' } } } : { json: { data: [{ gid: '3' }], next_page: null } };
    };
    expect((await new HttpAsApi('t', base).tasks('50')).map(t => t.gid)).toEqual(['1', '2', '3']);
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(new URL(s.url, base).searchParams.get('limit')).toBe('100');
  });

  it('asks for the task fields and passes completed_since', async () => {
    await new HttpAsApi('t', base).tasks('50', '2026-01-02T00:00:00.000Z');
    const q = new URL(seen[0].url, base);
    expect(q.pathname).toBe('/tasks'); expect(q.searchParams.get('project')).toBe('50'); expect(q.searchParams.get('completed_since')).toBe('2026-01-02T00:00:00.000Z');
    expect(q.searchParams.get('opt_fields')).toBe('name,notes,completed,due_on,due_at,modified_at,parent,num_subtasks,memberships.section,memberships.project,tags.name');
    expect(TASK_FIELDS).toBe(q.searchParams.get('opt_fields'));
    await new HttpAsApi('t', base).subtasks('7');
    expect(new URL(seen[1].url, base).pathname).toBe('/tasks/7/subtasks'); expect(new URL(seen[1].url, base).searchParams.get('opt_fields')).toBe(TASK_FIELDS);
  });

  it('429 gives AsHttpError with retryAfterS from Retry-After, without the token', async () => {
    reply = () => ({ status: 429, headers: { 'retry-after': '37' }, json: { errors: [{ message: 'Rate limit' }] } });
    const error = await new HttpAsApi('secret-tok', base).task('5').catch(e => e);
    expect(error).toBeInstanceOf(AsHttpError); expect(error).toMatchObject({ status: 429, retryAfterS: 37, message: 'Asana GET /tasks/5: Rate limit' });
    expect(error.message).not.toContain('secret-tok');
  });

  it('401 gives status 401, and an error without a message uses the status', async () => {
    reply = () => ({ status: 401, json: { errors: [{ message: 'Not Authorized' }] } });
    expect(await new HttpAsApi('t', base).me().catch(e => e)).toMatchObject({ status: 401, message: 'Asana GET /users/me: Not Authorized' });
    reply = () => ({ status: 500, json: {} });
    expect(await new HttpAsApi('t', base).project('3').catch(e => e)).toMatchObject({ status: 500, message: 'Asana GET /projects/3: 500', retryAfterS: undefined });
  });

  it('task() is null on 404, and writes send a {data} body', async () => {
    reply = () => ({ status: 404, json: { errors: [{ message: 'task: Not a recognized ID' }] } });
    expect(await new HttpAsApi('t', base).task('9')).toBeNull();
    reply = () => ({ json: { data: { gid: '10' } } });
    const api = new HttpAsApi('t', base);
    await api.createTask({ name: 'x', parent: '4' }); await api.createTask({ name: 'y', projects: ['5'] });
    await api.addProject('10', '5', '6'); await api.removeProject('10', '5'); await api.setParent('10', null); await api.addToSection('6', '10');
    await api.createTag('2', 'doing'); await api.addTag('10', '8'); await api.removeTag('10', '8'); await api.deleteTask('10');
    await api.createWebhook('5', 'https://x.example/h');
    const rows = seen.slice(1).map(s => `${s.method} ${s.url.split('?')[0]} ${s.body}`);
    expect(rows).toEqual([
      'POST /tasks/4/subtasks {"data":{"name":"x"}}',
      'POST /tasks {"data":{"name":"y","projects":["5"]}}',
      'POST /tasks/10/addProject {"data":{"project":"5","section":"6"}}',
      'POST /tasks/10/removeProject {"data":{"project":"5"}}',
      'POST /tasks/10/setParent {"data":{"parent":null}}',
      'POST /sections/6/addTask {"data":{"task":"10"}}',
      'POST /tags {"data":{"name":"doing","workspace":"2"}}',
      'POST /tasks/10/addTag {"data":{"tag":"8"}}',
      'POST /tasks/10/removeTag {"data":{"tag":"8"}}',
      'DELETE /tasks/10 ',
      'POST /webhooks {"data":{"resource":"5","target":"https://x.example/h"}}',
    ]);
  });

  it('fails loudly when pages never end or the offset sticks, instead of returning partial rows', async () => {
    let n = 0; reply = () => ({ json: { data: [{ gid: String(n++) }], next_page: { offset: `o${n}` } } });
    await expect(new HttpAsApi('t', base).tasks('50')).rejects.toThrow('Asana GET /tasks: more than 200 pages');
    reply = () => ({ json: { data: [{ gid: '1' }], next_page: { offset: 'same' } } }); seen.length = 0;
    await expect(new HttpAsApi('t', base).tasks('50')).rejects.toThrow(/same page offset/);
    expect(seen).toHaveLength(2);
  });

  it('does not expose the token to inspect or JSON.stringify', () => {
    const api = new HttpAsApi('secret-tok-xyz', base);
    expect(inspect(api, { depth: 5 })).not.toContain('secret-tok-xyz'); expect(JSON.stringify(api)).not.toContain('secret-tok-xyz');
  });

  it('a subtask body carries neither projects nor workspace, and gids are URL-encoded', async () => {
    reply = () => ({ json: { data: { gid: '1' } } });
    const api = new HttpAsApi('t', base);
    await api.createTask({ name: 'x', parent: '4', projects: ['5'], workspace: '2' }); await api.task('a/b?c');
    expect(seen[0].body).toBe('{"data":{"name":"x"}}'); expect(seen[1].url.split('?')[0]).toBe('/tasks/a%2Fb%3Fc');
  });

  it('times out', async () => {
    server.close(); server = createServer(() => {}); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(new HttpAsApi('t', b, 50).me()).rejects.toThrow();
  });
});
