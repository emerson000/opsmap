<script lang="ts">
  // Map pick mode's banner: what is being picked, the command so far (the slot being picked underlined), List and Cancel.
  // Desktop and tablet dock it as one line above the command bar (`line`); on a phone it takes the sheet while the
  // sheet is at peek, and a landscape phone shows it over the top of the map.
  import type { Doc } from '../../core/model/types';
  import { cancelPick, env, listPick, pick } from './shell.svelte';

  let { doc, line = false }: { doc: Doc; line?: boolean } = $props();
  const p = $derived(pick.current);
  const cursorName = $derived.by(() => {
    const c = p?.cursor;
    if (!c) return null;
    if (c.kind === 'unit') return doc.units.find(u => u.id === c.id)?.designation ?? null;
    if (c.kind === 'measure') { const m = doc.measures.find(x => x.id === c.id); return m ? `${m.type.toUpperCase()} ${m.name}` : null; }
    return doc.sectors.find(s => s.id === c.id)?.name ?? null;
  });
</script>

{#if p}
  {@const help = env.coarse || env.tier === 'phone' ? 'Tap a ringed object on the map.' : 'Click a ringed object, or Tab through them and press Enter. Esc cancels.'}
  <div class="banner" class:line role="region" aria-label="Pick on the map" data-testid="pick-banner" title={line ? help : undefined}>
    <div class="cap">{p.label}</div>
    {#if p.slots?.length}
      <code class="slots">{#each p.slots as s, i (i)}{i ? ' ' : ''}<span class={s.state}>{s.text}</span>{/each}</code>
    {/if}
    <p class="hint" aria-live="polite">
      {#if cursorName}Enter picks <b>{cursorName}</b> · Tab: next{:else if line}<span class="sr-only">{help}</span><span aria-hidden="true">Esc cancels</span>{:else}{help}{/if}
    </p>
    <div class="row">
      <button class="btn" type="button" onclick={listPick}>List</button>
      <button class="btn cancel" type="button" onclick={cancelPick}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  .banner { padding: var(--s2) var(--s3); background: var(--panel); border: 2px solid var(--accent); box-shadow: var(--shadow); }
  .cap { font: 700 12px/1.3 var(--font-cond); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }
  .slots { display: block; margin-top: var(--s1); padding: var(--s1) var(--s2); border: 1px solid var(--rule); font: 400 12px/1.45 var(--font-mono); overflow-wrap: anywhere; }
  .slots .filled { color: var(--ink); }
  .slots .empty { color: var(--ink-3); }
  .slots .active { color: var(--ink); text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 3px; }
  .hint { margin: var(--s1) 0; font-size: 12px; color: var(--ink-2); }
  .row { display: flex; gap: var(--s2); }
  .row .btn { flex: 1; justify-content: center; }
  .cancel { color: var(--hostile); border-color: var(--hostile); }
  :global([data-tier='phone']) .banner { border-width: 0 0 0 3px; box-shadow: none; }
  /* One line, 40 px: label, the command so far, the hint, List and Cancel. */
  .banner.line { position: relative; display: flex; align-items: center; gap: var(--s2); height: 40px; padding: 0 var(--s1) 0 var(--s3); }
  .line .cap { flex: none; }
  .line .slots { flex: 1; min-width: 0; margin: 0; padding: 0 var(--s1); border: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line .hint { flex: none; margin: 0; white-space: nowrap; color: var(--ink-3); }
  .line .row .btn { flex: none; }
  :global([data-tier='phone']) .row .btn { min-height: 44px; }
</style>
