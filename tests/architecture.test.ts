// The core, the client and the generic server code never name a task service: everything provider-specific lives
// in server/providers/ (and the legacy op translation and the one-time migration). A new provider then needs no
// change outside its own folder.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MODULES } from '../server/providers';

const ROOT = join(import.meta.dirname, '..');
/** Every registered provider as each module's factory makes it with everything switched on. */
const ON: NodeJS.ProcessEnv = { NODE_ENV: 'test', OPSMAP_FAKE_PROVIDER: '1', VIKUNJA_URL: 'https://todo.example', ASANA_SYNC: '1' };
const PROVIDED = MODULES.map(m => ({ id: m.id, provider: m.factory(ON) }));
/** Each provider's id, aliases and label, as whole words, and the older literals (the Vikunja API, `vk` keys and paths). */
const NAMES = [...new Set(PROVIDED.flatMap(({ id, provider: p }) => [id, ...(p ? [p.descriptor.id, p.descriptor.label, ...p.descriptor.aliases] : [])]).map(n => n.toLowerCase()))];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS = new RegExp(`${NAMES.map(n => `\\b${escape(n)}\\b`).join('|')}|vikunja|asana|vkapi|\\.vk\\b|\\bvk[_-]|['"]vk['"]|\\bvk:`, 'i');
const ALLOWED = [
  'server/providers/', 'src/core/model/legacy.ts', 'server/tasksync/migrate.ts',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}
/** `file:line: text` for every line outside the allowed paths that names a task service. */
function violations(paths: string[], read: (path: string) => string = p => readFileSync(join(ROOT, p), 'utf8')): string[] {
  return paths.filter(p => !ALLOWED.some(a => p === a || p.startsWith(a))).flatMap(p => read(p).split('\n').flatMap((line, i) => WORDS.test(line) ? [`${p}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
}

describe('architecture', () => {
  it('forbids the name, label and aliases of every registered provider module', () => {
    expect(PROVIDED.every(x => x.provider !== undefined)).toBe(true);
    for (const { provider: p } of PROVIDED) for (const name of [p!.descriptor.id, p!.descriptor.label, ...p!.descriptor.aliases]) expect(WORDS.test(`see ${name} here`)).toBe(true);
    expect(WORDS.test('a plain map, a sector and a unit')).toBe(false);
  });
  it('names no task service outside server/providers/', () => {
    const paths = ['src', 'server'].flatMap(d => files(join(ROOT, d))).map(p => relative(ROOT, p).split('\\').join('/'));
    expect(paths.length).toBeGreaterThan(50);
    expect(violations(paths)).toEqual([]);
  });
  it('reports the file and line', () => {
    const text: Record<string, string> = { 'src/a.ts': 'ok\nconst x = api.vk;\n', 'server/b.ts': 'VkApi\n', 'server/providers/c.ts': 'vikunja', 'src/d.svelte': 'data-testid="vk-sync"\n// Asana', 'src/e.ts': 'tasks vkWaiting', 'src/f.ts': "verb === 'vk'\nconst a = \"vk\";\nowner vk:u1", 'src/g.ts': 'the /fk alias\nfakery is fine' };
    expect(violations(Object.keys(text), p => text[p])).toEqual(['src/a.ts:2: const x = api.vk;', 'server/b.ts:1: VkApi', 'src/d.svelte:1: data-testid="vk-sync"', 'src/d.svelte:2: // Asana', "src/f.ts:1: verb === 'vk'", 'src/f.ts:2: const a = "vk";', 'src/f.ts:3: owner vk:u1', 'src/g.ts:1: the /fk alias']);
  });
});
