// Whether this user has connected each task service (a token on the server), by provider id. The sidebar's task
// sync sections read it to say why their verbs are disabled; the account panel updates it when the token changes.
export const taskAccounts = $state<Record<string, boolean | null>>({});
const asked = new Set<string>();
/** The account URL of a task service. */
export const accountUrl = (provider: string) => `/api/tasksync/${encodeURIComponent(provider)}/account`;
/** Ask the server once per service (GET /api/tasksync/‹id›/account); later calls do nothing. */
export function loadTaskAccount(provider: string): void {
  if (asked.has(provider) || typeof fetch !== 'function') return;
  asked.add(provider);
  taskAccounts[provider] ??= null;
  fetch(accountUrl(provider), { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : { connected: false }))
    .then((a: { connected?: boolean }) => { taskAccounts[provider] = Boolean(a.connected); })
    .catch(() => { taskAccounts[provider] = false; });
}
