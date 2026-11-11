<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ui } from '../shell.svelte';
  import { verbCode, type VerbSlot } from '../verbs';
  import { echoes } from './echo';

  let { label, tag, entry, code, cmd = null, wide = false, children }: {
    /** The control takes the full width, under its label (a segmented choice, an editor with a note). */
    wide?: boolean;
    label: string;
    /** The APP-6 field letter (T, H, B…), shown boxed before the label. */
    tag?: string;
    /** The VERB_SLOTS entry this field runs: its short command shows at the right of the label. */
    entry?: VerbSlot;
    /** The short command, when there is no entry (or to override it). */
    code?: string;
    /** The full command the field runs with its current value; shown while hovered or focused, and with /CMD. */
    cmd?: string | null;
    children: Snippet;
  } = $props();

  const short = $derived(code ?? (entry ? verbCode(entry) : ''));
  // The tag stays on one line with the label's first word; a trailing "(frame)" note hides in the narrow tablet column.
  const parts = $derived.by(() => {
    const m = /^(.*?)( \(.*\))?$/.exec(label)!;
    const [first, ...rest] = m[1].split(' ');
    return { first, rest: rest.length ? ` ${rest.join(' ')}` : '', note: m[2] ?? '' };
  });
  let active = $state(false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="field-row" class:wide data-control={entry?.control} use:echoes={cmd}
  onpointerenter={() => (active = true)} onpointerleave={() => (active = false)}
  onfocusin={() => (active = true)} onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) active = false; }}>
  <div class="lab">
    <span class="name"><span class="lead">{#if tag}<span class="tag">{tag}</span>{/if}{parts.first}</span>{parts.rest}{#if parts.note}<span class="note">{parts.note}</span>{/if}</span>
    {#if short}<code class="code">{short}</code>{/if}
  </div>
  <div class="ctl">{@render children()}</div>
  {#if cmd && (active || ui.cmdOn)}<div class="filled"><span aria-hidden="true">›</span> {cmd}</div>{/if}
</div>

<style>
  .field-row { display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 2px var(--s2); align-items: start; padding: 3px 0; }
  :global([data-tier='tablet']) .field-row { grid-template-columns: 106px minmax(0, 1fr); }
  .lab { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; column-gap: var(--s1); min-height: 24px; padding-top: 4px; }
  .name { font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
  .name .lead { white-space: nowrap; }
  .name .tag { min-width: 18px; margin-right: 4px; font-size: 11px; line-height: 13px; }
  :global([data-tier='tablet']) .name .note { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .code { margin-left: auto; font: 400 11px/1.3 var(--font-mono); color: var(--ink-3); white-space: nowrap; }
  .ctl { min-width: 0; }
  .filled { grid-column: 1 / -1; font: 400 11px/1.4 var(--font-mono); color: var(--ink-2); overflow-wrap: anywhere; }
  :global([data-tier='phone']) .field-row, .field-row.wide { grid-template-columns: 1fr; }
  .field-row.wide .lab { min-height: 0; }
  :global([data-tier='phone']) .lab { min-height: 0; }
</style>
