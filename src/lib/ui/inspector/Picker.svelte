<script lang="ts">
  // A combobox picker: type to filter, arrows and Enter to choose, and "⌖ Map" to pick the object on the map
  // instead (map pick mode, shell startPick). The list floats under the input, over the controls that follow.
  // In the portrait phone sheet the list flows instead (it pushes the controls down), the sheet opens to full, and the
  // input scrolls to the top so the list has the room under it.
  import { onDestroy, tick, untrack } from 'svelte';
  import { env, pick, startPick, cancelPick, ui, type PickSlot } from '../shell.svelte';
  import { reveal, settle } from './reveal';
  import type { Sel } from '../../model/store.svelte';
  import { optionForSel, type Option } from '../compose';
  import { echoes } from './echo';

  let { items, value = $bindable(''), chosen = null, onchoose, oninput, onfocus, label, placeholder = '', testid, mapTestid, pickLabel = 'Pick target', pickSlots, command = null, input = $bindable(), listOpen = false }: {
    items: Option[];
    /** The text in the input. */
    value?: string;
    /** The key of the chosen option, if any. */
    chosen?: string | null;
    onchoose: (o: Option) => void;
    /** The user typed: the chosen option no longer holds. */
    oninput?: (text: string) => void;
    onfocus?: () => void;
    /** The accessible name of the input. */
    label: string;
    placeholder?: string;
    testid?: string;
    /** The Map button's data-testid; the button shows when some option is on the map. */
    mapTestid?: string;
    pickLabel?: string;
    /** The command being built, for the pick banner. */
    pickSlots?: () => PickSlot[];
    /** The command this picker builds, with its open slot (`/move X near ‹unit›`): the echo line and the long-press bubble show it. */
    command?: string | null;
    input?: HTMLInputElement;
    /** Show the list from the start, without focusing the input (a list that is the whole step, as in + Order onto…). */
    listOpen?: boolean;
  } = $props();

  const uid = `pk${Math.random().toString(36).slice(2, 8)}`;
  let open = $state(untrack(() => listOpen));
  let root: HTMLDivElement | undefined = $state();
  /** In the portrait phone sheet (not the landscape column or a desktop sidebar). */
  const inSheet = () => env.tier === 'phone' && !env.landscape && !!root?.closest('[data-testid="sheet"]');
  // The list opened in the sheet: full height, and the input at the top of the sheet with the list below it.
  $effect(() => {
    if (!open || !root) return;
    const el = root;
    untrack(() => {
      if (!inSheet()) return;
      if (ui.sheet !== 'full') ui.sheet = 'full';
      void tick().then(() => settle(() => reveal(el, 'start')));
    });
  });
  let active = $state(-1);
  const chosenLabel = $derived(items.find(o => o.key === chosen)?.label);
  const shown = $derived.by(() => {
    const q = value.trim().toLowerCase();
    if (!q || q === chosenLabel?.toLowerCase()) return items;
    return items.filter(o => o.label.toLowerCase().includes(q) || o.text.toLowerCase().includes(q) || o.detail?.toLowerCase().includes(q));
  });
  $effect(() => { void shown; active = shown.length && value.trim() && value.trim().toLowerCase() !== chosenLabel?.toLowerCase() ? 0 : -1; });
  const onMap = $derived(items.some(o => o.sel));
  /** This picker started the map pick that is running. */
  let mapPicking = $state(false);
  const picking = $derived(mapPicking && pick.current !== null);
  // A picker that goes away (its composer closed, another unit opened) ends its map pick.
  onDestroy(() => { if (mapPicking) cancelPick(); });

  function choose(o: Option) {
    value = o.label;
    open = false;
    onchoose(o);
  }
  function keys(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { open = true; return; }
      const n = shown.length;
      if (n) active = ((active < 0 ? (e.key === 'ArrowDown' ? -1 : 0) : active) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    } else if (e.key === 'Enter' && !e.shiftKey && open && active >= 0 && shown[active]) {
      e.preventDefault(); e.stopPropagation();
      choose(shown[active]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); e.stopPropagation();
      open = false;
    } else if (e.key === 'Tab') open = false;
  }
  function mapPick() {
    if (picking) { cancelPick(); return; }
    mapPicking = true;
    startPick({
      label: pickLabel,
      accept: (sel: Sel) => { const o = optionForSel(sel, items); return o !== undefined && !o.why; },
      slots: pickSlots?.(),
      // A phone does not focus the input after a pick: the keyboard would cover what comes next.
      onpick: (sel: Sel) => { mapPicking = false; const o = optionForSel(sel, items); if (o) choose(o); if (!inSheet()) input?.focus(); },
      onlist: () => { mapPicking = false; open = true; if (!inSheet()) input?.focus(); },
      oncancel: () => { mapPicking = false; },
    });
  }
</script>

<div class="picker" use:echoes={command} bind:this={root}>
  <div class="line">
    <input bind:this={input} class="field" type="text" role="combobox" spellcheck="false" autocomplete="off" {placeholder}
      aria-label={label} aria-expanded={open} aria-controls="{uid}-list" aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 ? `${uid}-${active}` : undefined} data-testid={testid}
      bind:value oninput={() => { open = true; oninput?.(value); }}
      onfocus={() => { open = true; onfocus?.(); }} onblur={() => { if (!listOpen) open = false; }} onkeydown={keys} />
    {#if onMap}
      <button class="btn map" type="button" class:on={picking} aria-pressed={picking} data-testid={mapTestid}
        title="Pick it on the map (Tab cycles, Enter picks, Esc cancels)" onclick={mapPick}><span aria-hidden="true">⌖</span> Map</button>
    {/if}
  </div>
  {#if open}
    <ul class="list" role="listbox" id="{uid}-list" aria-label={label}>
      {#each shown as o, i (o.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id="{uid}-{i}" role="option" aria-selected={o.key === chosen} class:active={i === active} class:chosen={o.key === chosen} class:off={o.why} aria-disabled={o.why ? 'true' : undefined}
          onpointerdown={(e) => e.preventDefault()} onclick={() => choose(o)}>
          <span class="tag">{o.tag}</span><span class="name">{o.label}</span>{#if o.why}<span class="detail">{o.why}</span>{:else if o.detail}<span class="detail">{o.detail}</span>{/if}
        </li>
      {:else}
        <li class="none" role="presentation">No match.</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* The list floats over what follows: opening or closing it never moves the controls under the pointer. */
  .picker { position: relative; min-width: 0; }
  .line { display: flex; }
  .line .field { flex: 1; min-width: 0; font-family: var(--font-mono); }
  .map { flex: none; margin-left: -1px; padding: 0 6px; letter-spacing: 0.06em; }
  .list { position: absolute; left: 0; right: 0; top: 100%; z-index: 2; box-shadow: var(--shadow); margin: 2px 0 0; padding: 0; list-style: none; max-height: 196px; overflow-y: auto; border: 1px solid var(--rule); background: var(--panel); overscroll-behavior: contain; }
  .list li { display: flex; align-items: baseline; gap: var(--s2); min-height: 26px; padding: 3px var(--s2); font-size: 12px; cursor: pointer; border-bottom: 1px dotted var(--rule); }
  .list li.active { background: var(--accent-bg); box-shadow: inset 2px 0 0 var(--accent); }
  .list li.chosen .name { text-decoration: underline; }
  .tag { flex: none; min-width: 30px; font: 700 11px/1.2 var(--font-mono); color: var(--ink-2); }
  .name { flex: none; font: 600 12px/1.2 var(--font-mono); color: var(--ink); }
  .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); }
  .none { color: var(--ink-3); cursor: default; }
  .list li.off .name, .list li.off .tag { color: var(--ink-3); text-decoration: line-through; }
  :global([data-tier='phone']) .line .field { height: 44px; font-size: 16px; }
  :global([data-tier='phone']) .map { height: 44px; }
  :global([data-tier='phone']) .list li { min-height: 44px; align-items: center; }
  /* Portrait phone: the list flows under the input, so it never covers the controls that follow. */
  :global([data-tier='phone']) .picker .list { position: static; max-height: 224px; box-shadow: none; }
</style>
