// Asana as a task provider: on when ASANA_SYNC=1 (or true). The descriptor, the capabilities, the token check and the
// session (adapter.ts); the task sync engine does the rest. Webhooks are not registered yet: the engine polls.
import { HttpAsApi, type AsApi } from './api';
import { asanaSession, translate } from './adapter';
import { RemoteAuthError, type Capabilities, type ProviderDescriptor, type ProviderFactory, type ProviderSession, type TaskProvider } from '../../tasksync/contract';
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
  constructor(readonly makeApi: AsApiFactory = token => new HttpAsApi(token)) {}
  async verify(token: string): Promise<{ username: string }> {
    if (!wellFormedToken(token)) throw new RemoteAuthError('That does not look like an Asana personal access token');
    try { const me = await this.makeApi(token).me(); return { username: me.name || me.gid }; }
    catch (error) { throw translate(error); }
  }
  connect(token: string): ProviderSession { return asanaSession(this.makeApi(token), this.descriptor.label); }
}
/** ASANA_SYNC=1 or true turns Asana on. */
export const asanaProvider: ProviderFactory = env => /^(1|true)$/i.test((env.ASANA_SYNC ?? '').trim()) ? new AsanaProvider() : undefined;
export const asana: ProviderModule = { id: 'asana', factory: asanaProvider };
