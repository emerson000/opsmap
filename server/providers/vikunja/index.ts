// Vikunja as a task provider: on when VIKUNJA_URL is set. The descriptor, the capabilities, the token check, the
// session (adapter.ts) and webhook signatures; the task sync engine does the rest.
import { HttpVkApi, VkHttpError, type VkApi } from './api';
import { receiveVikunjaWebhook, vikunjaSession } from './adapter';
import { RemoteAuthError, type Capabilities, type ProviderDescriptor, type ProviderFactory, type ProviderSession, type TaskProvider, type WebhookResult } from '../../tasksync/contract';
import type { ProviderModule } from '../../tasksync/registry';

export type ApiFactory = (url: string, token: string) => VkApi;
export class VikunjaProvider implements TaskProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: Capabilities = {
    fields: new Set(['title', 'due', 'note', 'progress', 'status', 'container', 'affiliation', 'parent']), relations: new Set(['link', 'dependency', 'handoff']),
    // Vikunja has no description limit: opsmap's note limit applies.
    maxTitle: 250, maxNote: 16000, webhooks: { https: false, publicAddress: false }, pollMs: 60_000, idlePollMs: 300_000,
    webhookHint: 'if changes in Vikunja take a minute to arrive, set VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true on Vikunja (it refuses private addresses)',
  };
  constructor(readonly url: string, readonly makeApi: ApiFactory = (u, token) => new HttpVkApi(u, token)) {
    this.descriptor = {
      id: 'vikunja', label: 'Vikunja', aliases: ['vk'], rootNoun: 'project', containerNoun: 'project',
      tokenHelp: 'Create an API token in Vikunja (Settings → API Tokens) with access to projects, tasks, buckets and webhooks, then paste it here. It is checked with Vikunja and stored encrypted; it is never shown again. Maps you bind with /vk bind sync with your token.',
      tokenUrl: `${url}/user/settings/api-tokens`,
      urls: { root: `${url}/projects/{root}`, container: `${url}/projects/{container}`, task: `${url}/tasks/{id}` },
    };
  }
  /** An API client with this token. */
  api(token: string): VkApi { return this.makeApi(this.url, token); }
  async verify(token: string): Promise<{ username: string }> {
    try { return { username: (await this.api(token).me()).username }; }
    catch (error) { if (error instanceof VkHttpError && (error.status === 401 || error.status === 403)) throw new RemoteAuthError(error.message); throw error; }
  }
  connect(token: string): ProviderSession { return vikunjaSession(this.api(token), this.descriptor.label); }
  receiveWebhook(headers: Headers, body: string, secret: string): WebhookResult { return receiveVikunjaWebhook(headers, body, secret); }
  /** One webhook per watched project: the list ensureWebhooks keeps. */
  hookCount(hooks: unknown): number { return Array.isArray(hooks) ? hooks.length : 0; }
}
export const vikunjaProvider = (url: string, makeApi?: ApiFactory) => new VikunjaProvider(url, makeApi);
/** VIKUNJA_URL: the Vikunja origin (any path is dropped). */
export const vikunjaFactory: ProviderFactory = env => {
  if (!env.VIKUNJA_URL) return undefined;
  const u = new URL(env.VIKUNJA_URL);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('VIKUNJA_URL must be http(s)');
  return new VikunjaProvider(u.origin);
};
export const vikunja: ProviderModule = {
  id: 'vikunja', factory: vikunjaFactory,
  // The path Vikunja webhooks have posted to since before task sync became provider-neutral: the engine keeps
  // registering them there, so existing webhooks stay valid; the generic path works too.
  legacyRoutes: [{ provider: 'vikunja', hook: '/api/vikunja/hook/:map' }],
};
