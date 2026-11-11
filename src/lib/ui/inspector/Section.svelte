<script lang="ts" module>
  // Open or closed, per view kind and section, kept in this browser.
  const KEY = 'opsmap.ui.sections';
  function load(): Record<string, boolean> {
    try { const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  function save(id: string, open: boolean): void {
    try { const all = load(); all[id] = open; globalThis.localStorage?.setItem(KEY, JSON.stringify(all)); } catch { /* storage may be disabled */ }
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { selection } from '../../model/store.svelte';
  import { allSections } from '../shell.svelte';

  let { kind, key, title, count, summary, open: initial = true, force = false, testid, children }: {
    /** The view kind (unit, area, pl, sector, map): open state is kept per kind. */
    kind: string;
    /** The section key: its id, its anchor (`selection.section`) and `data-testid="section-‹key›"`. */
    key: string;
    title: string;
    count?: number | string;
    /** One line shown in the heading while the section is closed. */
    summary?: string;
    /** Open when this browser has no choice stored. */
    open?: boolean;
    /** Hold it open (the unit's Orders section while the composer is open). */
    force?: boolean;
    testid?: string;
    children: Snippet;
  } = $props();

  const id = $derived(`${kind}.${key}`);
  let isOpen = $state(true);
  $effect.pre(() => { const stored = load()[id]; isOpen = stored ?? initial; });
  let el: HTMLElement | undefined = $state();
  function toggle() { isOpen = !isOpen; save(id, isOpen); }
  $effect.pre(() => { if (force) isOpen = true; });
  // `[` and `]` collapse or expand every section of the view (only presses after this section appeared).
  let seen = allSections.seq;
  $effect(() => {
    if (allSections.seq === seen) return;
    seen = allSections.seq;
    isOpen = allSections.open || force;
    save(id, isOpen);
  });
  // An anchor (Beyond chevron, /find … at a section) opens the section and scrolls to it.
  $effect(() => {
    if (selection.section !== key) return;
    isOpen = true;
    void tick().then(() => el?.scrollIntoView({ block: 'start' }));
  });
</script>

<section class="sec" class:closed={!isOpen} bind:this={el} data-testid={testid ?? `section-${key}`}>
  <h2 class="head">
    <button type="button" aria-expanded={isOpen} aria-controls="sec-{kind}-{key}" onclick={toggle}>
      <span class="caret" aria-hidden="true">▸</span>
      <span class="title">{title}</span>
      {#if count !== undefined}<span class="count">{count}</span>{/if}
      {#if !isOpen && summary}<span class="summary">{summary}</span>{/if}
    </button>
  </h2>
  <div class="body" id="sec-{kind}-{key}" hidden={!isOpen}>
    {#if isOpen}{@render children()}{/if}
  </div>
</section>

<style>
  .sec { border-top: 1px solid var(--rule); }
  .head { margin: 0; font: inherit; }
  .head button {
    display: flex; align-items: baseline; gap: var(--s2); width: 100%; min-height: 28px; padding: var(--s1) 0; border: 0; background: none; text-align: left;
    font: 700 12px/1.3 var(--font-cond); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2);
  }
  .head button:hover .title { color: var(--ink); }
  .caret { display: inline-block; width: 10px; flex: none; transform: rotate(90deg); transition: transform 120ms ease-out; color: var(--ink-3); }
  .closed .caret { transform: none; }
  @media (prefers-reduced-motion: reduce) { .caret { transition: none; } }
  .count { font: 700 12px/1 var(--font-mono); color: var(--ink); letter-spacing: 0; }
  .summary {
    flex: 1; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 400 12px/1.3 var(--font-mono); letter-spacing: 0; text-transform: none; color: var(--ink-3);
  }
  .body { padding-bottom: var(--s2); }
  :global([data-tier='phone']) .head button { min-height: 44px; align-items: center; }
</style>
