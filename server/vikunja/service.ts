// The Vikunja sync (sync.ts) behind the provider-neutral SyncService, until the task sync engine replaces both.
// It serves only provider `vikunja`: a request for a map bound to, or binding, another service is refused.
import type { Maps } from '../maps';
import type { User } from '../db';
import type { Op } from '../hub';
import type { WebhookResult } from '../tasksync/contract';
import type { Credentials } from '../tasksync/credentials';
import type { SyncService } from '../tasksync/service';
import type { VikunjaProvider } from '../providers/vikunja';
import { VikunjaSync, isLoopback } from './sync';

export class VikunjaService implements SyncService {
  readonly sync: VikunjaSync;
  constructor(maps: Maps, readonly provider: VikunjaProvider, credentials: Credentials, publicUrl: string) {
    // Webhooks need a public (non-loopback) origin Vikunja can post to; else it polls. A map syncs with its binder's token.
    this.sync = new VikunjaSync(maps, userId => { const token = credentials.token(userId, 'vikunja'); return token ? provider.api(token) : undefined; }, provider.url, isLoopback(publicUrl) ? undefined : publicUrl);
  }
  request(mapId: string, args: Record<string, unknown>, user: User, source: Op['source']): Promise<string> {
    const bound = this.sync.maps.get(mapId)?.doc.settings.taskSync;
    if (args.action === 'bind' && args.provider !== undefined && args.provider !== 'vikunja') return Promise.reject(new Error(`${String(args.provider)} sync is not available on this server yet`));
    if (bound && bound.provider !== 'vikunja') return Promise.reject(new Error(`${bound.label} sync is not available on this server yet`));
    return this.sync.request(mapId, { action: args.action, ...(typeof args.name === 'string' ? { name: args.name } : {}) }, user, source);
  }
  webhook(provider: string, mapId: string, headers: Headers, body: string): WebhookResult {
    if (provider !== 'vikunja') return { status: 404, trigger: false };
    const ok = this.sync.webhook(mapId, body, headers.get('x-vikunja-signature') ?? undefined);
    return ok ? { status: 200, trigger: true } : { status: 401, trigger: false };
  }
  nudge(_mapId: string): void { /* Polls every minute; nudges arrive with the task sync engine. */ }
  start(): void { this.sync.start(); }
  stop(): Promise<void> { return this.sync.stop(); }
}
