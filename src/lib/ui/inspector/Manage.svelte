<script lang="ts">
  // The quiet last row of an area, phase line or sector view: Remove…, with an inline confirm when the removal
  // also drops orders or prunes axes (it names them, and focus lands on Keep). With no impact it runs at once with Undo.
  import { tick, type Snippet } from 'svelte';
  import type { Command, Doc } from '../../../core/model/types';
  import { dispatch } from '../../commands/dispatch';
  import { runCommand, toast } from '../shell.svelte';
  import { echoes, textOf } from './echo';

  let { doc, label, cmd, impact = null, disabled = null, children }: {
    doc: Doc;
    /** The button text, e.g. "Remove objective…". */
    label: string;
    cmd: Command;
    /** What else the removal changes, in a sentence; null when nothing else changes. */
    impact?: string | null;
    /** The reason Remove does not apply now (shown under it), or null. */
    disabled?: string | null;
    /** Controls before Remove (the sector's Reassign to). */
    children?: Snippet;
  } = $props();

  const text = $derived(textOf(cmd, doc));
  let confirming = $state(false);
  let keep: HTMLButtonElement | undefined = $state();
  $effect(() => { void cmd; confirming = false; });

  function undoToast(log: string) {
    toast(log, 'info', { label: 'Undo', run: () => { const r = dispatch({ verb: 'undo', args: {} }); if (!r.ok) toast(r.error, 'info'); } }, 6000);
  }
  function remove() {
    if (impact) { confirming = true; void tick().then(() => keep?.focus()); return; }
    go();
  }
  function go() {
    confirming = false;
    const res = runCommand(cmd);
    if (res.ok) undoToast(res.log);
  }
</script>

<div class="manage" data-testid="manage">
  <span class="cap">Manage</span>
  {@render children?.()}
  <button class="remove" type="button" data-testid="manage-remove" onclick={remove} disabled={disabled !== null || confirming}
    title={text ?? undefined} use:echoes={text}>{label}</button>
  {#if disabled}<p class="why">{disabled}</p>{/if}
  {#if confirming && impact}
    <div class="confirm" role="alertdialog" aria-labelledby="manage-q" aria-describedby="manage-impact">
      <p id="manage-q" class="q">{label.replace(/…$/, '')}?</p>
      <p id="manage-impact">{impact} Undo (Ctrl+Z) restores it.</p>
      <div class="row">
        <button class="btn" type="button" bind:this={keep} onclick={() => (confirming = false)}>Keep</button>
        <button class="btn warn" type="button" onclick={go}>Remove</button>
      </div>
      {#if text}<code class="cmd">› {text}</code>{/if}
    </div>
  {/if}
</div>

<style>
  .manage { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin-top: var(--s2); padding-top: var(--s2); border-top: 1px solid var(--rule); }
  .remove { border: 0; background: none; padding: 2px 0; font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--hostile); text-decoration: underline; text-underline-offset: 2px; }
  .remove:disabled { opacity: 0.45; cursor: default; }
  :global([data-tier='phone']) .remove { min-height: 44px; }
  .why { width: 100%; margin: 0; font-size: 12px; color: var(--ink-3); }
  .confirm { width: 100%; padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; }
  .confirm p { margin: 0 0 var(--s1); }
  .q { font-weight: 700; }
  .row { display: flex; gap: var(--s1); margin: var(--s1) 0; }
  .cmd { display: block; color: var(--ink-2); font-size: 11px; overflow-wrap: anywhere; }
</style>
