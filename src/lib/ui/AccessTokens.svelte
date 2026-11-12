<script lang="ts">
  // Bearer tokens for the MCP server and the API. Any signed-in user (OIDC or a dev user) creates and revokes
  // their own; an administrator also sees and revokes everyone's. A new token's secret is shown once, here.
  import { onMount } from 'svelte';
  import { ui, toast } from './shell.svelte';

  type Token = { id: string; name: string; userId: string; userName: string | null; userEmail: string | null; createdAt: string; lastUsed: string | null; mine: boolean };
  type Reply = { tokens?: Token[]; admin?: boolean; token?: string; created?: Token; error?: string };
  let tokens = $state<Token[] | null>(null);
  let admin = $state(false);
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let created = $state<{ name: string; token: string } | null>(null);
  let confirming = $state<string | null>(null);
  let input = $state<HTMLInputElement>();
  const endpoint = `${location.origin}/mcp`;

  async function call(method: 'GET' | 'POST' | 'DELETE', path = '', body?: unknown): Promise<Reply> {
    const res = await fetch(`/api/tokens${path}`, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as Reply;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.tokens) tokens = data.tokens;
    if (data.admin !== undefined) admin = data.admin;
    return data;
  }
  onMount(async () => {
    try { await call('GET'); } catch (e) { error = e instanceof Error ? e.message : 'Could not load tokens'; }
    input?.focus();
  });
  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    busy = true; error = ''; created = null;
    try { const r = await call('POST', '', { name: name.trim() }); created = { name: r.created!.name, token: r.token! }; name = ''; }
    catch (err) { error = err instanceof Error ? err.message : 'Could not create the token'; }
    finally { busy = false; }
  }
  async function revoke(t: Token) {
    if (confirming !== t.id) { confirming = t.id; return; }
    busy = true; error = ''; confirming = null;
    try { await call('DELETE', `/${encodeURIComponent(t.id)}`); if (created?.name === t.name) created = null; toast(`Token ${t.name} revoked`, 'info'); }
    catch (err) { error = err instanceof Error ? err.message : 'Could not revoke the token'; }
    finally { busy = false; }
  }
  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'info'); }
    catch { toast('Copy failed: select the text and copy it', 'error'); }
  }
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const claude = (token: string) => `claude mcp add --transport http opsmap ${endpoint} --header "Authorization: Bearer ${token}"`;
  const codex = (env: string) => `[mcp_servers.opsmap]\nurl = "${endpoint}"\nbearer_token_env_var = "${env}"`;
  const close = () => { ui.tokensOpen = false; };
</script>

<div class="tk" role="dialog" aria-modal="false" aria-labelledby="tk-title" data-testid="access-tokens" tabindex="-1"
  onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
  <header>
    <span id="tk-title" class="cap">Access tokens</span>
    <button class="btn" onclick={close} aria-label="Close access tokens">Close</button>
  </header>
  <div class="body">
    <p class="muted">A token lets an agent or script use this server as you, through the MCP endpoint <code data-testid="tk-endpoint">{endpoint}</code>. Its changes show your initials with the token name, and it has its own undo history. Name each token after the agent that uses it.</p>
    <form onsubmit={create}>
      <label for="tk-name" class="cap">New token name</label>
      <div class="row">
        <input id="tk-name" class="field" type="text" autocomplete="off" spellcheck="false" bind:this={input} bind:value={name} maxlength="60" placeholder="laptop-agent" data-testid="tk-name" />
        <button class="btn" type="submit" disabled={!name.trim() || busy} data-testid="tk-create">Create</button>
      </div>
    </form>
    {#if created}
      <div class="secret" data-testid="tk-created">
        <p><b>Token {created.name}</b>: copy it now. It is not shown again.</p>
        <div class="row">
          <input class="field" readonly value={created.token} aria-label="New token" data-testid="tk-secret" onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
          <button class="btn" onclick={() => copy(created!.token, 'Token')} data-testid="tk-copy">Copy</button>
        </div>
        <p class="cap">Claude Code</p>
        <div class="row"><pre data-testid="tk-claude">{claude(created.token)}</pre><button class="btn" onclick={() => copy(claude(created!.token), 'Command')}>Copy</button></div>
        <p class="cap">Codex</p>
        <p class="muted">Set the environment variable <code>OPSMAP_TOKEN</code> to the token, and add this to <code>~/.codex/config.toml</code>:</p>
        <div class="row"><pre data-testid="tk-codex">{codex('OPSMAP_TOKEN')}</pre><button class="btn" onclick={() => copy(codex('OPSMAP_TOKEN'), 'Configuration')}>Copy</button></div>
        <button class="btn" onclick={() => (created = null)} data-testid="tk-done">Done</button>
      </div>
    {/if}
    {#if tokens === null && !error}
      <p class="muted">Loading…</p>
    {:else if tokens}
      <p class="cap">{admin ? 'Active tokens (all users)' : 'Your active tokens'}</p>
      {#if tokens.length === 0}<p class="muted" data-testid="tk-empty">No active tokens.</p>{/if}
      <ul data-testid="tk-list">
        {#each tokens as t (t.id)}
          <li data-testid="tk-row" data-name={t.name}>
            <div class="meta">
              <b>{t.name}</b>
              {#if !t.mine}<span class="owner">{t.userName ?? t.userEmail ?? t.userId}</span>{/if}
              <span class="muted">Created {when(t.createdAt)} · last used {when(t.lastUsed)}</span>
            </div>
            <button class="btn warn" disabled={busy} onclick={() => revoke(t)} data-testid="tk-revoke"
              title="Revoke {t.name}: it stops working at once">{confirming === t.id ? 'Confirm revoke' : 'Revoke'}</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="error" role="alert" data-testid="tk-error">{error}</p>{/if}
  </div>
</div>

<style>
  .tk { width: min(600px, 100%); max-height: 100%; display: flex; flex-direction: column; background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow); }
  header { display: flex; align-items: center; gap: var(--s1); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--rule); background: var(--panel-2); }
  header .cap { flex: 1; color: var(--ink); }
  .body { padding: var(--s3); overflow: auto; display: flex; flex-direction: column; gap: var(--s2); }
  p { margin: 0; font-size: 13px; line-height: 1.45; }
  .muted { color: var(--ink-soft, var(--ink)); opacity: 0.8; }
  .row { display: flex; gap: var(--s1); margin-top: var(--s1); align-items: flex-start; min-width: 0; }
  .row .field { flex: 1; min-width: 0; height: 30px; font-family: var(--font-mono); }
  .secret { display: flex; flex-direction: column; gap: var(--s1); padding: var(--s2); border: 1px dashed var(--rule-strong); background: var(--panel-2); }
  .secret > .btn { align-self: flex-start; }
  pre { flex: 1; min-width: 0; margin: 0; padding: 6px 8px; font: 12px/1.4 var(--font-mono); white-space: pre-wrap; word-break: break-all; background: var(--panel); border: 1px solid var(--rule); color: var(--ink); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  li { display: flex; align-items: center; gap: var(--s2); padding: var(--s1) 0; border-top: 1px solid var(--rule); }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 13px; overflow-wrap: anywhere; }
  .owner { font-size: 12px; font-weight: 600; }
  .meta .muted { font-size: 12px; }
  .error { color: var(--hostile, #b91c1c); font-weight: 600; }
  code { font-family: var(--font-mono); overflow-wrap: anywhere; }
  :global([data-tier='phone']) .tk .btn, :global([data-tier='phone']) .tk .row .field { height: 44px; }
</style>
