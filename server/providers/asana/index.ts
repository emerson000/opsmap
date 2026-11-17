// Asana as a task provider: on when ASANA_SYNC=1 (or true). The descriptor, the capabilities, the token check and the
// session (adapter.ts) and webhooks (handshake and signature); the task sync engine does the rest. Webhooks need a public
// HTTPS PUBLIC_URL (D19): elsewhere the engine never registers them and polls.
import { HttpAsApi, type AsApi } from './api';
import { asanaHookCount, asanaSession, receiveAsanaWebhook, translate, type Handshakes } from './adapter';
import { RemoteAuthError, type Capabilities, type ProviderDescriptor, type ProviderFactory, type ProviderSession, type TaskProvider, type WebhookResult } from '../../tasksync/contract';
import type { ProviderModule } from '../../tasksync/registry';

export type AsApiFactory = (token: string) => AsApi;
/** A personal access token as Asana issues them: no whitespace, and of a plausible length. Checked before any call. */
export const wellFormedToken = (token: string) => token.length >= 16 && token.length <= 512 && !/\s/.test(token);
export class AsanaProvider implements TaskProvider {
  readonly descriptor: ProviderDescriptor = {
    id: 'asana', label: 'Asana', aliases: ['asana'], rootNoun: 'project', containerNoun: 'section',
    tokenHelp: 'Create a personal access token in Asana (My settings → Apps → Developer apps) and paste it here.',
    urls: { root: 'https://app.asana.com/0/{root}', task: 'https://app.asana.com/0/{root}/{id}' },
  };
  readonly capabilities: Capabilities = {
    // No progress (BDA) and no relations: dependencies need a paid plan (D6). Subtasks are the parent field.
    fields: new Set(['title', 'due', 'note', 'status', 'container', 'affiliation', 'parent']), relations: new Set(),
    maxTitle: 1024, maxNote: 16000, webhooks: { https: true, publicAddress: true, handshakeTimeoutMs: 30_000 },
    // Well under the free plan's 150 requests a minute.
    pollMs: 120_000, idlePollMs: 600_000,
  };
  /** Webhook creations in flight, shared by every session of this server. */
  private readonly handshakes: Handshakes = new Map();
  constructor(readonly makeApi: AsApiFactory = token => new HttpAsApi(token)) {}
  async verify(token: string): Promise<{ username: string }> {
    if (!wellFormedToken(token)) throw new RemoteAuthError('That does not look like an Asana personal access token');
    try { const me = await this.makeApi(token).me(); return { username: me.name || me.gid }; }
    catch (error) { throw translate(error); }
  }
  connect(token: string): ProviderSession { return asanaSession(this.makeApi(token), this.descriptor.label, this.handshakes); }
  receiveWebhook(headers: Headers, body: string, secret: string, state: unknown): WebhookResult { return receiveAsanaWebhook(headers, body, secret, state, this.handshakes); }
  hookCount(hooks: unknown): number { return asanaHookCount(hooks); }
}
/** ASANA_SYNC=1 or true turns Asana on. */
export const asanaProvider: ProviderFactory = env => /^(1|true)$/i.test((env.ASANA_SYNC ?? '').trim()) ? new AsanaProvider() : undefined;
export const asana: ProviderModule = { id: 'asana', factory: asanaProvider };
