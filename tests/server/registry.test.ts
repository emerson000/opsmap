import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { LEGACY_ROUTES, PROVIDERS } from '../../server/providers';
import { config } from '../../server/config';
import { FakeProvider } from './fake-provider';

describe('ProviderRegistry', () => {
  it('holds the providers whose factories return one, by id', () => {
    const a = new FakeProvider(), b = new FakeProvider({ id: 'other', label: 'Other', aliases: ['ot'] });
    const r = ProviderRegistry.fromEnv({ X: '1' }, [env => env.X ? a : undefined, () => undefined, () => b]);
    expect(r.list()).toEqual([a, b]);
    expect(r.get('other')).toBe(b);
    expect(r.get('nope')).toBeUndefined();
    expect(r.descriptors()).toEqual([a.descriptor, b.descriptor]);
    expect(r.info()).toEqual([{ id: 'fake', label: 'Fake', aliases: ['fk'], rootNoun: 'project' }, { id: 'other', label: 'Other', aliases: ['ot'], rootNoun: 'project' }]);
    expect(ProviderRegistry.fromEnv({}, [env => env.X ? a : undefined]).list()).toEqual([]);
  });
  it('refuses two providers with the same id or alias', () => {
    expect(() => new ProviderRegistry([new FakeProvider(), new FakeProvider()])).toThrow('Two task services use the name fake');
    expect(() => new ProviderRegistry([new FakeProvider(), new FakeProvider({ id: 'other', aliases: ['fk'] })])).toThrow('Two task services use the name fk');
  });
  it('registers Vikunja from VIKUNJA_URL and the fake only in tests that ask for it', () => {
    expect(ProviderRegistry.fromEnv({}, PROVIDERS).list()).toEqual([]);
    const vk = ProviderRegistry.fromEnv({ VIKUNJA_URL: 'https://todo.example/some/path' }, PROVIDERS);
    expect(vk.descriptors()).toEqual([{ id: 'vikunja', label: 'Vikunja', aliases: ['vk'], rootNoun: 'project', containerNoun: 'project', tokenHelp: expect.stringContaining('Settings → API Tokens'),
      tokenUrl: 'https://todo.example/user/settings/api-tokens', urls: { root: 'https://todo.example/projects/{root}', container: 'https://todo.example/projects/{container}', task: 'https://todo.example/tasks/{id}' } }]);
    expect(() => ProviderRegistry.fromEnv({ VIKUNJA_URL: 'ftp://todo.example' }, PROVIDERS)).toThrow('VIKUNJA_URL must be http(s)');
    expect(ProviderRegistry.fromEnv({ NODE_ENV: 'test', OPSMAP_FAKE_PROVIDER: '1' }, PROVIDERS).info().map(p => p.id)).toEqual(['fake']);
    expect(ProviderRegistry.fromEnv({ NODE_ENV: 'production', OPSMAP_FAKE_PROVIDER: '1' }, PROVIDERS).list()).toEqual([]);
    expect(LEGACY_ROUTES).toEqual([{ provider: 'vikunja', hook: '/api/vikunja/hook/:map' }]);
  });
  it('leaves provider settings out of the server config', () => {
    const c = config({ OPSMAP_DEV_USERS: 'alice', VIKUNJA_URL: 'https://todo.example' }) as unknown as Record<string, unknown>;
    expect(Object.keys(c).filter(k => /vikunja/i.test(k))).toEqual([]);
  });
});
