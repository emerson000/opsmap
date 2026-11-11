// Whether this user has connected a Vikunja account (an API token on the server). The sidebar's Vikunja
// sections read it to say why their verbs are disabled; the account panel updates it when the token changes.
export const vkAccount = $state<{ connected: boolean | null }>({ connected: null });
let asked = false;
/** Ask the server once (GET /api/vikunja/account); later calls do nothing. */
export function loadVkAccount(): void {
  if (asked || typeof fetch !== 'function') return;
  asked = true;
  fetch('/api/vikunja/account', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : { connected: false }))
    .then((a: { connected?: boolean }) => { vkAccount.connected = Boolean(a.connected); })
    .catch(() => { vkAccount.connected = false; });
}
