import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecretBox } from '../../server/secrets';
import { Store } from '../../server/db';
import { VkTokens } from '../../server/vikunja/tokens';
import { VkHttpError } from '../../server/vikunja/api';
import { FakeVikunja } from './fake-vikunja';

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

describe('VkTokens', () => {
  const setup = () => {
    const store = new Store(':memory:'), vk = new FakeVikunja();
    const tokens = new VkTokens(store, SecretBox.fromKey(randomBytes(32)), 'https://todo.example', (_url, token) => {
      if (!vk.tokens.has(token)) return { ...vk, me: async () => { throw new VkHttpError(401, 'Vikunja GET /user: invalid token'); } } as unknown as FakeVikunja;
      return vk;
    });
    return { store, tokens };
  };
  it('checks the token with Vikunja and stores it sealed; the account shows only the user name', async () => {
    const { store, tokens } = setup();
    expect(tokens.account('u1')).toEqual({ connected: false });
    await expect(tokens.save('u1', 'tk_wrong_token')).rejects.toThrow('Vikunja refused that token');
    await expect(tokens.save('u1', 'short')).rejects.toThrow(/does not look like/);
    const saved = await tokens.save('u1', '  tk_good_token  ');
    expect(saved).toMatchObject({ connected: true, username: 'alice' });
    expect(tokens.account('u1')).toMatchObject({ connected: true, username: 'alice' });
    expect(JSON.stringify(store.db.prepare('SELECT * FROM vk_tokens').all())).not.toContain('tk_good_token');
    expect(tokens.api('u1')).toBeDefined();
    expect(tokens.api('u2')).toBeUndefined();
    tokens.remove('u1');
    expect(tokens.api('u1')).toBeUndefined();
  });
});
