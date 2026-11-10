<script lang="ts">
  import { session, boot } from '../sync/sync.svelte';
</script>

<main class="login" data-testid="login">
  <div class="card">
    <div class="brand"><span class="mark" aria-hidden="true"></span><span class="name">OPSMAP</span></div>
    {#if session.phase === 'loading'}
      <p class="muted">Connecting…</p>
    {:else if session.phase === 'error'}
      <p>{session.error}</p>
      <button class="btn" onclick={() => { session.phase = 'loading'; void boot(); }}>Try again</button>
    {:else if session.devUsers.length}
      <p>Development mode. Sign in as:</p>
      <div class="users">
        {#each session.devUsers as user (user)}
          <a class="btn" href="/auth/dev-login?user={encodeURIComponent(user)}" data-testid="dev-login-{user}">{user}</a>
        {/each}
      </div>
      <p class="muted">Dev mode has no identity provider. It is refused when NODE_ENV=production.</p>
    {:else}
      <p>The shared map needs a sign-in.</p>
      <a class="btn primary" href="/auth/login">Sign in</a>
    {/if}
  </div>
</main>

<style>
  .login { position: fixed; inset: 0; display: grid; place-items: center; background: var(--paper, var(--panel)); }
  .card { min-width: 320px; max-width: 420px; padding: var(--s4, 24px); background: var(--panel); border: 2px solid var(--rule-strong); display: flex; flex-direction: column; gap: var(--s3, 12px); }
  .brand { display: flex; align-items: center; gap: var(--s2); }
  .mark { width: 18px; height: 12px; border: 2px solid var(--ink); position: relative; }
  .mark::after { content: ''; position: absolute; left: 2px; right: 2px; top: 50%; border-top: 2px solid var(--ink); }
  .name { font: 700 15px/1 var(--font-cond); letter-spacing: 0.3em; }
  p { margin: 0; }
  .muted { color: var(--ink-3); font-size: 12px; }
  .users { display: flex; gap: var(--s2); }
  a.btn { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
</style>
