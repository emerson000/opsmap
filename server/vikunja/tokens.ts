// Each user's Vikunja API token, set in the app (menu → Vikunja), sealed with the server's SecretBox.
// Tokens never leave the server: the app sees only whether one is set and its Vikunja user name.
import type { Store } from '../db';
import type { SecretBox } from '../secrets';
import { HttpVkApi, VkHttpError, type VkApi } from './api';

export interface VkAccount { connected: boolean; username?: string; savedAt?: string }
export type ApiFactory = (url: string, token: string) => VkApi;

export class VkTokens {
  constructor(private readonly store: Store, private readonly box: SecretBox, readonly url: string,
    private readonly makeApi: ApiFactory = (url, token) => new HttpVkApi(url, token)) {
    store.db.exec('CREATE TABLE IF NOT EXISTS vk_tokens(user_id TEXT PRIMARY KEY,sealed TEXT NOT NULL,username TEXT NOT NULL,saved_at TEXT NOT NULL)');
  }
  account(userId: string): VkAccount {
    const row = this.store.db.prepare('SELECT username,saved_at FROM vk_tokens WHERE user_id=?').get(userId) as { username: string; saved_at: string } | undefined;
    return row ? { connected: true, username: row.username, savedAt: row.saved_at } : { connected: false };
  }
  /** Checks the token against Vikunja, then stores it sealed. */
  async save(userId: string, token: unknown): Promise<VkAccount> {
    if (typeof token !== 'string') throw new Error('Paste a Vikunja API token');
    const value = token.trim();
    if (value.length < 8 || value.length > 512 || /\s/.test(value)) throw new Error('That does not look like a Vikunja API token');
    let username: string;
    try { username = (await this.makeApi(this.url, value).me()).username; }
    catch (error) {
      if (error instanceof VkHttpError && (error.status === 401 || error.status === 403)) throw new Error('Vikunja refused that token');
      throw new Error(`Could not reach Vikunja: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const now = new Date().toISOString();
    this.store.db.prepare('INSERT INTO vk_tokens(user_id,sealed,username,saved_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET sealed=excluded.sealed,username=excluded.username,saved_at=excluded.saved_at')
      .run(userId, this.box.seal(value, userId), username, now);
    return { connected: true, username, savedAt: now };
  }
  remove(userId: string): void { this.store.db.prepare('DELETE FROM vk_tokens WHERE user_id=?').run(userId); }
  /** An API client with this user's token, or undefined when none is set (or it no longer decrypts). */
  api(userId: string | undefined): VkApi | undefined {
    if (!userId) return undefined;
    const row = this.store.db.prepare('SELECT sealed FROM vk_tokens WHERE user_id=?').get(userId) as { sealed: string } | undefined;
    if (!row) return undefined;
    try { return this.makeApi(this.url, this.box.open(row.sealed, userId)); } catch { return undefined; }
  }
}
