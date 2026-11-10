<script lang="ts">
  import { toasts, dismissToast } from './shell.svelte';
</script>

<div class="toasts" role="status" aria-live="polite" data-testid="toasts">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}">
      <span class="text">{t.text}</span>
      {#if t.action}
        {@const action = t.action}
        <button class="btn" onclick={() => { action.run(); dismissToast(t.id); }}>{action.label}</button>
      {/if}
      <button class="x" onclick={() => dismissToast(t.id)} aria-label="Dismiss">✕</button>
    </div>
  {/each}
</div>

<style>
  .toasts { touch-action: pan-x pan-y; display: flex; flex-direction: column; align-items: center; gap: var(--s1); pointer-events: none; }
  .toast {
    pointer-events: auto; display: flex; align-items: center; gap: var(--s2); max-width: 560px;
    padding: 6px var(--s2) 6px var(--s3); background: var(--panel); border: 1px solid var(--rule-strong); border-left: 4px solid var(--hostile);
    box-shadow: var(--shadow); font: 12px/1.4 var(--font-mono);
  }
  .toast.info { border-left-color: var(--friend); }
  .toast.prompt { border-left-color: var(--accent); }
  .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  :global([data-tier='phone']) .toast { max-width: 100%; }
  :global([data-tier='phone']) .toast .btn { height: 44px; }
  :global([data-tier='phone']) .x { min-width: 44px; min-height: 44px; }
  .x { background: none; border: 0; color: var(--ink-3); padding: 0 2px; }
  .x:hover { color: var(--ink); }
</style>
