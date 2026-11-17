<script lang="ts">
  // Connect this user's account on a task service: paste a token, the server checks it with the service and stores
  // it encrypted. The token is never sent back; the panel shows only whether one is set and for which user.
  // Everything it says about the service comes from the server's descriptor.
  import { onMount } from 'svelte';
  import { ui, toast } from './shell.svelte';
  import { taskService } from '../model/features.svelte';
  import { accountUrl, taskAccounts } from './taskAccounts.svelte';

  let { provider }: { provider: string } = $props();
  const service = $derived(taskService(provider));
  const label = $derived(service?.label ?? 'Task service');

  type Account = { provider?: string; connected?: boolean; username?: string; savedAt?: string; error?: string };
  let account = $state<Account | null>(null);
  let token = $state('');
  let busy = $state(false);
  let error = $state('');
  let input = $state<HTMLInputElement>();

  async function call(method: 'GET' | 'PUT' | 'DELETE', body?: unknown): Promise<Account> {
    const res = await fetch(accountUrl(provider), {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as Account;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    taskAccounts[provider] = Boolean(data.connected);
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
    try { account = await call('PUT', { token: token.trim() }); token = ''; toast(`${label} connected as ${account.username}`, 'info'); }
    catch (err) { error = err instanceof Error ? err.message : 'Could not save'; }
    finally { busy = false; }
  }
  async function remove() {
    busy = true; error = '';
    try { account = await call('DELETE'); toast(`${label} token removed`, 'info'); }
    catch (err) { error = err instanceof Error ? err.message : 'Could not remove'; }
    finally { busy = false; }
  }
  const close = () => { ui.taskAccountOpen = null; };
</script>

<div class="account" role="dialog" aria-modal="false" aria-labelledby="task-account-title" data-testid="task-account" tabindex="-1"
  onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
  <header>
    <span id="task-account-title" class="cap">{label}</span>
    <button class="btn" onclick={close} aria-label="Close {label}">Close</button>
  </header>
  <div class="body">
    {#if !service}
      <p>{label} sync is not configured on this server.</p>
    {:else if account === null && !error}
      <p class="muted">Loading…</p>
    {:else if account}
      <p class="state" data-testid="tasks-account-state">
        {#if account.connected}Connected as <b>{account.username}</b>{#if account.savedAt}<span class="muted">&nbsp;· since {new Date(account.savedAt).toLocaleDateString()}</span>{/if}
        {:else}Not connected.{/if}
      </p>
      <p class="muted">{service.tokenHelp}{#if service.tokenUrl} <a href={service.tokenUrl} target="_blank" rel="noopener noreferrer">Create a token ↗</a>{/if}</p>
      <form onsubmit={save}>
        <label for="task-token" class="cap">{account.connected ? 'Replace token' : 'Token'}</label>
        <div class="row">
          <input id="task-token" class="field" type="password" autocomplete="off" spellcheck="false" bind:this={input} bind:value={token} maxlength="512" data-testid="tasks-token" />
          <button class="btn" type="submit" disabled={!token.trim() || busy} data-testid="tasks-token-save">{busy ? 'Checking…' : 'Save'}</button>
        </div>
      </form>
      {#if account.connected}<button class="btn warn" onclick={remove} disabled={busy} data-testid="tasks-token-remove">Remove token</button>{/if}
    {/if}
    {#if error}<p class="error" role="alert" data-testid="tasks-account-error">{error}</p>{/if}
  </div>
</div>

<style>
  .account { width: min(520px, 100%); max-height: 100%; display: flex; flex-direction: column; background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow); }
  header { display: flex; align-items: center; gap: var(--s1); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--rule); background: var(--panel-2); }
  header .cap { flex: 1; color: var(--ink); }
  .body { padding: var(--s3); overflow: auto; display: flex; flex-direction: column; gap: var(--s2); }
  p { margin: 0; font-size: 12px; line-height: 1.45; color: var(--ink-2); }
  .muted { color: var(--ink-3); }
  .state { font-size: 12px; color: var(--ink); }
  .row { display: flex; gap: var(--s1); margin-top: var(--s1); }
  .row .field { flex: 1; height: 30px; font-family: var(--font-mono); }
  .error { color: var(--hostile, #b91c1c); font-weight: 600; }
  .warn { align-self: flex-start; }
  :global([data-tier='phone']) .account .btn, :global([data-tier='phone']) .account .row .field { height: 44px; }
</style>
