// Secrets at rest (users' Vikunja API tokens): AES-256-GCM with a 32-byte master key kept outside the database,
// so a copy of opsmap.db or its nightly backups does not hold usable tokens. Each value is bound to its owner
// (associated data), so a ciphertext copied to another user's row does not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 'v1';

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /** The key from `file` (64 hex characters or 32 raw bytes), created there (0600) when missing. */
  static fromFile(file: string): SecretBox {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    }
    try { chmodSync(file, 0o600); } catch { /* read-only mount */ }
    return new SecretBox(SecretBox.parse(readFileSync(file)));
  }
  static fromKey(key: Buffer): SecretBox { return new SecretBox(SecretBox.parse(key)); }
  private static parse(raw: Buffer): Buffer {
    const text = raw.toString('utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
    if (raw.length === 32) return Buffer.from(raw);
    throw new Error('The secret key must be 32 bytes or 64 hex characters');
  }

  seal(plaintext: string, owner: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(owner, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }
  /** The plaintext, or throws when the value was tampered with, moved to another owner, or sealed with another key. */
  open(sealed: string, owner: string): string {
    const [version, data] = sealed.split(':');
    if (version !== VERSION || !data) throw new Error('Unknown secret format');
    const raw = Buffer.from(data, 'base64');
    if (raw.length < 29) throw new Error('Secret is truncated');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(owner, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}
