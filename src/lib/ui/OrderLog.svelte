<script lang="ts">
  import { tick } from 'svelte';
  import type { Doc } from '../../core/model/types';
  import { formatDtg } from '../../core/model/sidc';
  import { selection } from '../model/store.svelte';
  import { ui, setLogOpen } from './shell.svelte';
  import { unitInLine } from './words';
  import { annotate, revertLines } from '../sync/sync.svelte';

  let { doc, onfocus, embedded = false }: { doc: Doc; onfocus: (id: string) => void; embedded?: boolean } = $props();
  let list = $state<HTMLOListElement>();
  // v2: author and undo state come from the ops this client has seen (sync engine).
  const entries = $derived([
    ...doc.log.slice(-200).map(e => {
      const a = annotate(e.id);
      return { ...e, text: a?.text ?? e.text, undone: a?.undone ?? false, by: a };
    }),
    ...revertLines().map(l => ({ ...l, cmd: undefined as string | undefined, undone: false })),
  ].sort((a, b) => a.at.localeCompare(b.at)).slice(-200));

  $effect(() => {
    void entries.length;
    if (ui.logOpen || embedded) tick().then(() => { if (list) list.scrollTop = list.scrollHeight; });
  });
  function pick(text: string) {
    const id = unitInLine(doc, text);
    if (id) { selection.selectedId = id; onfocus(id); }
  }
</script>

{#if ui.logOpen || embedded}
  <aside class="log" class:embedded aria-label="Order log" data-testid="order-log">
    {#if !embedded}<header>
      <span class="cap">Order log</span>
      <span class="count">{doc.log.length}</span>
      <button class="btn" onclick={() => setLogOpen(false)} aria-label="Collapse order log" title="Collapse">◂</button>
    </header>{/if}
    <ol class="scroll" bind:this={list}>
      {#each entries as e (e.id)}
        {@const target = unitInLine(doc, e.text)}
        <li class:undone={e.undone}>
          <button class:linked={target} class:sel={target && target === selection.selectedId} disabled={!target} onclick={() => pick(e.text)} title={e.cmd && !e.cmd.startsWith('{') ? e.cmd : undefined}>
            <span class="when">{formatDtg(e.at).slice(0, 6)}</span>
            <span class="text">{#if e.by}<span class="by" style="--who:{e.by.color}" title="{e.by.name}{e.by.ai ? ' (AI agent)' : ''}">{e.by.initials}</span>{#if e.by.ai}<span class="ai" title="Made by an AI agent">{e.by.via ?? 'AI'}</span>{/if}{/if}<span class="line">{e.text}</span></span>
          </button>
        </li>
      {/each}
    </ol>
  </aside>
{:else}
  <button class="rail" onclick={() => setLogOpen(true)} aria-label="Open order log" title="Order log">
    <span>ORDER LOG</span>
  </button>
{/if}

<style>
  li.undone .line {text-decoration:line-through;opacity:0.65;}
  .by { display: inline-block; min-width: 22px; margin-right: 4px; padding: 0 2px; font-weight: 700; font-size: 12px; text-align: center; color: #fff; background: var(--who); border-radius: 2px; }
  .ai { display: inline-block; margin-right: 4px; padding: 0 3px; font-size: 12px; font-weight: 700; border: 1px solid currentColor; border-radius: 2px; }
  .log { height: 100%; display: flex; flex-direction: column; background: var(--panel-glass); border-right: 2px solid var(--rule-strong); }
  header { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s2) var(--s2) var(--s3); border-bottom: 1px solid var(--rule); }
  header .cap { flex: 1; }
  .count { font: 600 12px/1 var(--font-mono); color: var(--ink-3); }
  header .btn { padding: 0 6px; }
  ol { flex: 1; margin: 0; padding: var(--s1) 0; list-style: none; counter-reset: n; }
  li button {
    display: grid; grid-template-columns: 48px 1fr; gap: var(--s1); width: 100%; padding: 3px var(--s3) 3px var(--s2);
    background: none; border: 0; text-align: left; font: 12px/1.35 var(--font-mono); color: var(--ink-2); cursor: default;
  }
  li button.linked { cursor: pointer; color: var(--ink); }
  li button.linked:hover { background: var(--accent-bg); }
  li button.sel { box-shadow: inset 3px 0 0 var(--accent); background: var(--accent-bg); }
  li button:disabled { opacity: 1; }
  .when { color: var(--ink-3); }
  .text { word-break: break-word; }
  li:last-child button { font-weight: 600; }
  .embedded ol { overscroll-behavior: contain; touch-action: pan-y; }
  .embedded li button { padding: 8px var(--s3); min-height: 44px; grid-template-columns: 56px 1fr; }
  .rail {
    height: 100%; width: 100%; padding: var(--s2) 0; background: var(--panel-glass); border: 0; border-right: 2px solid var(--rule-strong);
    writing-mode: vertical-rl; transform: rotate(180deg); font: 700 12px/1 var(--font-cond); letter-spacing: 0.2em; color: var(--ink-2);
  }
  .rail:hover { color: var(--ink); background: var(--accent-bg); }
</style>
