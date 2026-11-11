<script lang="ts">
  // Connect this user's Vikunja account: paste an API token, the server checks it with Vikunja and stores it
  // encrypted. The token is never sent back; the panel shows only whether one is set and for which user.
  import { onMount } from 'svelte';
  import { ui, toast } from './shell.svelte';

  type Account = { configured: boolean; url?: string; connected?: boolean; username?: string; savedAt?: string; error?: string };
  let account = $state<Account | null>(null);
  let token = $state('');
  let busy = $state(false);
  let error = $state('');
  let input = $state<HTMLInputElement>();

  async function call(method: 'GET' | 'PUT' | 'DELETE', body?: unknown): Promise<Account> {
    const res = await fetch('/api/vikunja/account', {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as Account;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }
  onMount(async () => {
    try { account = await call('GET'); } catch (e) { error = e instanceof Error ? e.message : 'Could not load'; }
    input?.focus();
  });
  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!token.trim() || busy) return;
    busy = true; error = '';
    try { account = await call('PUT', { token: token.trim() }); token = ''; toast(`Vikunja connected as ${account.username}`, 'info'); }
    catch (err) { error = err instanceof Error ? err.message : 'Could not save'; }
    finally { busy = false; }
  }
  async function remove() {
    busy = true; error = '';
    try { account = await call('DELETE'); toast('Vikunja token removed', 'info'); }
    catch (err) { error = err instanceof Error ? err.message : 'Could not remove'; }
    finally { busy = false; }
  }
  const close = () => { ui.vikunjaOpen = false; };
</script>

<div class="vk" role="dialog" aria-modal="false" aria-labelledby="vk-title" data-testid="vikunja-account" tabindex="-1"
  onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
  <header>
    <span id="vk-title" class="cap">Vikunja</span>
    <button class="btn" onclick={close} aria-label="Close Vikunja">Close</button>
  </header>
  <div class="body">
    {#if account === null && !error}
      <p class="muted">Loading…</p>
    {:else if account && !account.configured}
      <p>Vikunja sync is not configured on this server.</p>
    {:else if account}
      <p class="state" data-testid="vk-state">
        {#if account.connected}Connected as <b>{account.username}</b>{#if account.savedAt}<span class="muted">&nbsp;· since {new Date(account.savedAt).toLocaleDateString()}</span>{/if}
        {:else}Not connected.{/if}
      </p>
      <p class="muted">Create an API token in Vikunja (<a href="{account.url}/user/settings/api-tokens" target="_blank" rel="noopener noreferrer">Settings → API Tokens</a>) with access to projects, tasks, buckets and webhooks, then paste it here. It is checked with Vikunja and stored encrypted; it is never shown again. Maps you bind with <code>/vk bind</code> sync with your token.</p>
      <form onsubmit={save}>
        <label for="vk-token" class="cap">{account.connected ? 'Replace token' : 'API token'}</label>
        <div class="row">
          <input id="vk-token" class="field" type="password" autocomplete="off" spellcheck="false" bind:this={input} bind:value={token} maxlength="512" placeholder="tk_…" data-testid="vk-token" />
          <button class="btn" type="submit" disabled={!token.trim() || busy} data-testid="vk-save">{busy ? 'Checking…' : 'Save'}</button>
        </div>
      </form>
      {#if account.connected}<button class="btn warn" onclick={remove} disabled={busy} data-testid="vk-remove">Remove token</button>{/if}
    {/if}
    {#if error}<p class="error" role="alert" data-testid="vk-error">{error}</p>{/if}
  </div>
</div>

<style>
  .vk { width: min(520px, 100%); max-height: 100%; display: flex; flex-direction: column; background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow); }
  header { display: flex; align-items: center; gap: var(--s1); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--rule); background: var(--panel-2); }
  header .cap { flex: 1; color: var(--ink); }
  .body { padding: var(--s3); overflow: auto; display: flex; flex-direction: column; gap: var(--s2); }
  p { margin: 0; font-size: 13px; line-height: 1.45; }
  .muted { color: var(--ink-soft, var(--ink)); opacity: 0.8; }
  .state { font-size: 14px; }
  .row { display: flex; gap: var(--s1); margin-top: var(--s1); }
  .row .field { flex: 1; height: 30px; font-family: var(--font-mono); }
  .error { color: var(--hostile, #b91c1c); font-weight: 600; }
  .warn { align-self: flex-start; }
  code { font-family: var(--font-mono); }
  :global([data-tier='phone']) .vk .btn, :global([data-tier='phone']) .vk .row .field { height: 44px; }
</style>
