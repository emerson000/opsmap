<script lang="ts">
  // The command of the control under the pointer (or focus); after a run, that command; then the last one, with To bar.
  import { echo, env, prefill } from '../shell.svelte';
</script>

<div class="echo" data-testid="echo-line" aria-live="polite">
  {#if echo.hover}
    <span class="mark" aria-hidden="true">›</span><code class="text">{echo.hover}</code>
  {:else if echo.last && echo.fresh}
    <span class="mark ok" aria-hidden="true">✓</span><code class="text">{echo.last}</code><span class="state" title="Press ↑ in the command bar to recall it">↑ in bar</span>
  {:else if echo.last}
    <span class="mark" aria-hidden="true">↺</span><span class="sr-only">Last command:</span><code class="text">{echo.last}</code>
    <button class="to-bar" type="button" onclick={() => prefill(echo.last ?? '')} title="Put it in the command bar to edit or run again">To bar</button>
  {:else}
    <span class="idle">{env.coarse && env.tier !== 'desktop' ? 'The commands you run show here' : 'Hover a control to see its command'}</span>
  {/if}
</div>

<style>
  .echo {
    flex: none; display: flex; align-items: center; gap: var(--s2); min-height: 30px; padding: var(--s1) var(--s3);
    border-top: 1px solid var(--rule); background: var(--panel); font: 400 12px/1.3 var(--font-mono); color: var(--ink-2);
  }
  .mark { flex: none; color: var(--ink-3); }
  .mark.ok { color: var(--ok); }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
  .state { flex: none; color: var(--ink-3); font-size: 11px; }
  .idle { color: var(--ink-3); }
  .to-bar { flex: none; border: 0; background: none; padding: 0 2px; font: 600 12px/1 var(--font-cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
  :global([data-tier='phone']) .to-bar { min-height: 36px; }
</style>
