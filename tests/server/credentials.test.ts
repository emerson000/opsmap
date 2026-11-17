import { describe, expect, it } from 'vitest';
import { Store } from '../../server/db';
import { SecretBox } from '../../server/secrets';
import { Credentials } from '../../server/tasksync/credentials';
import { ProviderRegistry } from '../../server/tasksync/registry';
import { FakeProvider } from './fake-provider';

const box = SecretBox.fromKey(Buffer.alloc(32, 7));
const setup = () => {
  const store = new Store(':memory:'), fake = new FakeProvider(), other = new FakeProvider({ id: 'other', label: 'Other' });
  return { store, fake, other, creds: new Credentials(store, box, new ProviderRegistry([fake, other])) };
};
type Row = { user_id: string; provider: string; sealed: string; username: string; saved_at: string };

describe('Credentials', () => {
  it('checks the token with the provider and stores it sealed per user and provider; the account shows only the user name', async () => {
    const { store, creds } = setup();
    expect(creds.account('u1', 'fake')).toEqual({ connected: false });
    const saved = await creds.save('u1', 'fake', '  fake-alice ');
    expect(saved).toEqual({ connected: true, username: 'alice', savedAt: expect.any(String) });
    expect(creds.account('u1', 'fake')).toEqual(saved);
    expect(creds.account('u1', 'other')).toEqual({ connected: false });
    expect(creds.account('u2', 'fake')).toEqual({ connected: false });
    const row = store.db.prepare("SELECT * FROM ts_tokens WHERE user_id='u1'").get() as Row;
    expect(row).toMatchObject({ provider: 'fake', username: 'alice' });
    expect(row.sealed).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain('fake-alice');
    expect(creds.token('u1', 'fake')).toBe('fake-alice');
    expect(creds.session('u1', 'fake')).toBeDefined();
    expect(creds.session('u2', 'fake')).toBeUndefined();
    expect(creds.session(undefined, 'fake')).toBeUndefined();
    expect(creds.session('u1', 'other')).toBeUndefined();
  });

  it('keeps one token per user and provider: saving again replaces it, remove forgets only that one', async () => {
    const { creds } = setup();
    await creds.save('u1', 'fake', 'fake-alice');
    await creds.save('u1', 'other', 'fake-albert');
    await creds.save('u1', 'fake', 'fake-alice2');
    expect(creds.account('u1', 'fake')).toMatchObject({ username: 'alice2' });
    creds.remove('u1', 'fake');
    expect(creds.account('u1', 'fake')).toEqual({ connected: false });
    expect(creds.account('u1', 'other')).toMatchObject({ connected: true, username: 'albert' });
  });

  it('a sealed token copied to another user or another provider does not open', async () => {
    const { store, creds } = setup();
    await creds.save('u1', 'fake', 'fake-alice');
    const { sealed } = store.db.prepare("SELECT sealed FROM ts_tokens WHERE user_id='u1'").get() as Row;
    const put = store.db.prepare("INSERT INTO ts_tokens(user_id,provider,sealed,username,saved_at) VALUES(?,?,?,'x','2026-01-01')");
    put.run('u2', 'fake', sealed); put.run('u1', 'other', sealed);
    expect(creds.token('u2', 'fake')).toBeUndefined();
    expect(creds.token('u1', 'other')).toBeUndefined();
    expect(creds.session('u2', 'fake')).toBeUndefined();
  });

  it('says why a token is refused, in the provider’s name', async () => {
    const { creds, fake } = setup();
    await expect(creds.save('u1', 'fake', 'tk_not_a_fake_token')).rejects.toThrow(/^Fake refused that token$/);
    fake.failNext('verify', new Error('connect ECONNREFUSED'));
    await expect(creds.save('u1', 'fake', 'fake-alice')).rejects.toThrow(/^Could not reach Fake: connect ECONNREFUSED$/);
    for (const token of ['short', 'fake alice', 'x'.repeat(513), 42, undefined]) await expect(creds.save('u1', 'fake', token), String(token)).rejects.toThrow(/^That does not look like a Fake token$/);
    await expect(creds.save('u1', 'other', 'tk_nope_nope')).rejects.toThrow(/^Other refused that token$/);
    await expect(creds.save('u1', 'nope', 'fake-alice')).rejects.toThrow(/^Unknown task service: nope$/);
    expect(() => creds.account('u1', 'nope')).toThrow('Unknown task service: nope');
    expect(creds.account('u1', 'fake')).toEqual({ connected: false });
  });

  it('keeps the Vikunja tokens saved before task sync became provider-neutral', () => {
    const store = new Store(':memory:');
    store.db.exec('CREATE TABLE vk_tokens(user_id TEXT PRIMARY KEY,sealed TEXT NOT NULL,username TEXT NOT NULL,saved_at TEXT NOT NULL)');
    store.db.prepare('INSERT INTO vk_tokens VALUES(?,?,?,?)').run('u1', box.seal('tk_old_token', 'u1'), 'alice', '2026-10-01T00:00:00.000Z');
    store.db.prepare('INSERT INTO vk_tokens VALUES(?,?,?,?)').run('u2', 'v1:broken', 'bob', '2026-10-01T00:00:00.000Z');
    const registry = new ProviderRegistry([new FakeProvider({ id: 'vikunja', label: 'Vikunja' })]);
    const creds = new Credentials(store, box, registry);
    expect(creds.account('u1', 'vikunja')).toEqual({ connected: true, username: 'alice', savedAt: '2026-10-01T00:00:00.000Z' });
    expect(creds.token('u1', 'vikunja')).toBe('tk_old_token');
    // A token that no longer opened stays unusable, and is not copied.
    expect(creds.account('u2', 'vikunja')).toEqual({ connected: false });
    // Once: a token removed after the copy does not come back.
    creds.remove('u1', 'vikunja');
    new Credentials(store, box, registry);
    expect(creds.account('u1', 'vikunja')).toEqual({ connected: false });
  });
});
