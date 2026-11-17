import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecretBox } from '../../server/secrets';
import { Store } from '../../server/db';
import { Credentials } from '../../server/tasksync/credentials';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { vikunjaProvider } from '../../server/providers/vikunja';
import { VkHttpError } from '../../server/providers/vikunja/api';
import { FakeVikunja } from './providers/fake-vikunja';

describe('SecretBox', () => {
  const box = SecretBox.fromKey(randomBytes(32));
  it('round-trips, with a fresh nonce each time', () => {
    const a = box.seal('tk_secret', 'u1'), b = box.seal('tk_secret', 'u1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('tk_secret');
    expect(box.open(a, 'u1')).toBe('tk_secret');
  });
  it('refuses another owner, a tampered value and another key', () => {
    const sealed = box.seal('tk_secret', 'u1');
    expect(() => box.open(sealed, 'u2')).toThrow();
    const raw = Buffer.from(sealed.slice(3), 'base64'); raw[raw.length - 1] ^= 1;
    expect(() => box.open(`v1:${raw.toString('base64')}`, 'u1')).toThrow();
    expect(() => SecretBox.fromKey(randomBytes(32)).open(sealed, 'u1')).toThrow();
  });
  it('creates its key file once, readable by the owner only, and reuses it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'opsmap-key-')), 'secrets', 'master.key');
    const sealed = SecretBox.fromFile(file).seal('x', 'u1');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(SecretBox.fromFile(file).open(sealed, 'u1')).toBe('x');
  });
});

describe('Vikunja tokens', () => {
  const setup = () => {
    const store = new Store(':memory:'), vk = new FakeVikunja();
    const provider = vikunjaProvider('https://todo.example', (_url, token) => {
      if (!vk.tokens.has(token)) return { ...vk, me: async () => { throw new VkHttpError(401, 'Vikunja GET /user: invalid token'); } } as unknown as FakeVikunja;
      return vk;
    });
    return { store, provider, creds: new Credentials(store, SecretBox.fromKey(randomBytes(32)), new ProviderRegistry([provider])) };
  };
  it('checks the token with Vikunja and stores it sealed; the account shows only the user name', async () => {
    const { store, creds } = setup();
    expect(creds.account('u1', 'vikunja')).toEqual({ connected: false });
    await expect(creds.save('u1', 'vikunja', 'tk_wrong_token')).rejects.toThrow('Vikunja refused that token');
    await expect(creds.save('u1', 'vikunja', 'short')).rejects.toThrow('That does not look like a Vikunja token');
    const saved = await creds.save('u1', 'vikunja', '  tk_good_token  ');
    expect(saved).toMatchObject({ connected: true, username: 'alice' });
    expect(creds.account('u1', 'vikunja')).toMatchObject({ connected: true, username: 'alice' });
    expect(JSON.stringify(store.db.prepare('SELECT * FROM ts_tokens').all())).not.toContain('tk_good_token');
    expect(creds.token('u1', 'vikunja')).toBe('tk_good_token');
    expect(creds.token('u2', 'vikunja')).toBeUndefined();
    creds.remove('u1', 'vikunja');
    expect(creds.token('u1', 'vikunja')).toBeUndefined();
  });
  it('says when Vikunja cannot be reached', async () => {
    const provider = vikunjaProvider('https://todo.example', () => ({ me: async () => { throw new Error('fetch failed'); } }) as unknown as FakeVikunja);
    const creds = new Credentials(new Store(':memory:'), SecretBox.fromKey(randomBytes(32)), new ProviderRegistry([provider]));
    await expect(creds.save('u1', 'vikunja', 'tk_good_token')).rejects.toThrow(/^Could not reach Vikunja: fetch failed$/);
  });
});
