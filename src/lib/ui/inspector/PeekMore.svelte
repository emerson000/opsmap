<script lang="ts">
  // Phone sheet at peek: the quiet last item of a view's action row, which opens the sheet to half.
  import { env, ui } from '../shell.svelte';
</script>

{#if env.tier === 'phone' && !env.landscape && ui.sheet === 'peek'}
  <button class="more" type="button" data-testid="peek-more" onclick={() => (ui.sheet = 'half')}>More ▴</button>
{/if}

<style>
  .more {
    flex: none; min-height: 44px; padding: 0 var(--s2); border: 0; background: none;
    font: 600 12px/1 var(--font-cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink);
    text-decoration: underline; text-underline-offset: 3px;
  }
</style>
