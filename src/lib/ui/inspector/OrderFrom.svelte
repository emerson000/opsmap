<script lang="ts">
  // The first step of an order started at its target end (an area's + Order onto…, a phase line's + Axis via…):
  // pick the friendly that gets the order, from a list ranked like the composer's or on the map with ⌖ Map.
  // Choosing one opens that unit's order composer with this end already filled in (ui.compose).
  import { onMount } from 'svelte';
  import { env, type PickSlot } from '../shell.svelte';
  import type { Option } from '../compose';
  import Picker from './Picker.svelte';

  let { options, title, command, slots, onchoose, onclose }: {
    options: Option[];
    /** The caption: "Order onto OBJ SETTLED IN". */
    title: string;
    /** The command with its unit slot open: `/attack ‹unit› OBJ "SETTLED IN"`. */
    command: string;
    /** The same command, slot by slot, for the map pick banner. */
    slots: PickSlot[];
    onchoose: (unitId: string) => void;
    onclose: () => void;
  } = $props();

  let query = $state('');
  let reason = $state('');
  let input: HTMLInputElement | undefined = $state();
  /** Portrait phone: the list shows at once and the input waits for a tap (the keyboard would cover the list). */
  const phone = env.tier === 'phone' && !env.landscape;
  onMount(() => { if (!phone) input?.focus({ preventScroll: true }); });

  function choose(o: Option) {
    if (o.why) { reason = `${o.label}: ${o.why}`; return; }
    reason = '';
    onchoose(o.key.slice(2));
  }
  function keys(e: KeyboardEvent) {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onclose(); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="from" role="group" aria-label={title} data-testid="order-from" onkeydown={keys}>
  <div class="ch">
    <span class="cap">{title}</span>
    <button class="x" type="button" aria-label="Close: {title}" title="Cancel (Esc)" onclick={onclose}>✕</button>
  </div>
  <div class="body">
    <Picker items={options} bind:value={query} bind:input label="Unit that gets the order" placeholder="A friendly unit…"
      testid="order-from-unit" mapTestid="order-from-map" pickLabel="Pick the unit" pickSlots={() => slots} {command}
      onchoose={choose} oninput={() => (reason = '')} listOpen={phone} />
    {#if reason}<p class="reason" role="status">{reason}</p>{/if}
    <code class="preview">› {command}</code>
  </div>
</div>

<style>
  .from { margin-bottom: var(--s2); border: 1px solid var(--rule-strong); border-left: 3px solid var(--accent); background: var(--panel); }
  .ch { display: flex; align-items: center; justify-content: space-between; padding: var(--s1) var(--s2); border-bottom: 1px solid var(--rule); }
  .cap { font: 700 12px/1.3 var(--font-cond); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }
  .x { flex: none; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .x:hover { color: var(--ink); border-color: var(--ink); }
  :global([data-tier='phone']) .from .x { width: 44px; height: 44px; }
  .body { display: flex; flex-direction: column; gap: var(--s1); padding: var(--s2); }
  .reason { margin: 0; font-size: 12px; color: var(--hostile); }
  .preview { font: 400 11px/1.4 var(--font-mono); color: var(--ink-2); overflow-wrap: anywhere; }
  /* Phone: no command line under the picker; the list it opens needs the room. */
  :global([data-tier='phone']) .from .preview { display: none; }
</style>
