<script lang="ts">
  // Map switcher: lists the shared maps, opens one, and creates, duplicates, renames or deletes maps.
  // Desktop and tablet: a top-bar button with a dropdown. Phone: rendered inline in the app menu.
  import { tick } from 'svelte';
  import { getDoc } from '../model/store.svelte';
  import { exportJson } from '../model/persist';
  import { live, session, isAdmin, currentMap, switchMap, createMap, renameMap, deleteMap } from '../sync/sync.svelte';
  import { toast } from './shell.svelte';
  import { pickFile } from './files';

  let { inline = false, ondone }: { inline?: boolean; ondone?: () => void } = $props();

  let open = $state(false);
  let mode = $state<'list' | 'new' | 'rename'>('list');
  let name = $state('');
  let busy = $state(false);
  let field = $state<HTMLInputElement>();

  const current = $derived(currentMap());
  const admin = $derived(isAdmin(session.me));
  const shown = $derived(inline || open);

  function close() { open = false; mode = 'list'; name = ''; }
  function finish() { close(); ondone?.(); }
  async function edit(next: 'new' | 'rename') {
    mode = next; name = next === 'rename' ? current?.name ?? '' : '';
    await tick(); field?.focus(); field?.select();
  }
  function pick(id: string) { if (switchMap(id)) finish(); }

  async function submit(e?: Event) {
    e?.preventDefault();
    const text = name.trim();
    if (!text || busy) return;
    busy = true;
    try {
      const ok = mode === 'rename' && current ? await renameMap(current.id, text) : await createMap(text);
      if (ok) finish();
    } finally { busy = false; }
  }
  async function duplicate() {
    if (!current || busy) return;
    busy = true;
    try { if (await createMap(uniqueName(`${current.name} copy`), exportJson(getDoc()))) finish(); } finally { busy = false; }
  }
  async function fromFile() {
    const text = await pickFile();
    if (text === null) return;
    busy = true;
    try { if (await createMap(name.trim() || uniqueName('Imported map'), text)) finish(); } finally { busy = false; }
  }
  function remove() {
    if (!current) return;
    const target = current;
    close();
    toast(`Delete the map ${target.name} for everyone? Its units and history go with it (nightly backups keep a copy).`, 'prompt', {
      label: 'Delete map', run: () => { void deleteMap(target.id).then(ok => { if (ok) ondone?.(); }); },
    }, 15000);
  }
  function uniqueName(base: string): string {
    const taken = new Set(live.maps.map(m => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (mode !== 'list') { mode = 'list'; e.stopPropagation(); e.preventDefault(); }
    else if (open) { close(); e.stopPropagation(); e.preventDefault(); }
  }
</script>

<!-- A click that swapped the panel contents has a detached target: that is not a click outside. -->
<svelte:window onclick={(e) => { const t = e.target as HTMLElement; if (open && t.isConnected && !t.closest?.('.maps')) close(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="maps" class:inline onkeydown={onKey}>
  {#if !inline}
    <button class="btn trigger" aria-haspopup="true" aria-expanded={open} data-testid="map-switcher"
      title="Switch map ({live.maps.length} map{live.maps.length === 1 ? '' : 's'})" onclick={() => (open ? close() : (open = true))}>
      <span class="tag">MAP</span><span class="cur" data-testid="map-name">{current?.name ?? '…'}</span><span class="caret" aria-hidden="true">▾</span>
    </button>
  {:else}
    <div class="row-label">Map</div>
  {/if}

  {#if shown}
    <div class="panel" data-testid="map-panel" role="group" aria-label="Maps">
      <ul class="list" aria-label="Open a map">
        {#each live.maps as m (m.id)}
          <li>
            <button class="opt" class:on={m.id === live.mapId} aria-current={m.id === live.mapId ? 'true' : undefined}
              data-testid="map-option" data-map-id={m.id} onclick={() => pick(m.id)}>
              <span class="mark" aria-hidden="true">{m.id === live.mapId ? '●' : ''}</span><span class="label">{m.name}</span>
            </button>
          </li>
        {/each}
      </ul>

      {#if mode === 'list'}
        <div class="actions">
          <button class="btn" data-testid="map-new" onclick={() => edit('new')}>New map</button>
          <button class="btn" data-testid="map-duplicate" disabled={busy || !current} onclick={duplicate} title="A new map that starts as a copy of this one">Duplicate</button>
          <button class="btn" data-testid="map-rename" disabled={!current} onclick={() => edit('rename')}>Rename</button>
          {#if admin && live.maps.length > 1}
            <button class="btn warn" data-testid="map-delete" onclick={remove} title="Delete this map for everyone (admin)">Delete</button>
          {/if}
        </div>
      {:else}
        <form class="edit" onsubmit={submit}>
          <label class="row-label" for="map-name-field">{mode === 'new' ? 'New map name' : `Rename ${current?.name ?? ''}`}</label>
          <input id="map-name-field" class="field" bind:this={field} bind:value={name} maxlength="60" autocomplete="off" data-testid="map-name-input"
            placeholder={mode === 'new' ? 'e.g. House move' : ''} />
          <div class="actions">
            <button class="btn on" type="submit" disabled={busy || !name.trim()} data-testid="map-save">{mode === 'new' ? 'Create' : 'Save'}</button>
            {#if mode === 'new'}<button class="btn" type="button" disabled={busy} onclick={fromFile} title="Create the map from an exported JSON file">From file…</button>{/if}
            <button class="btn" type="button" onclick={() => (mode = 'list')}>Cancel</button>
          </div>
        </form>
      {/if}
    </div>
  {/if}
</div>

<style>
  .maps { position: relative; flex: none; }
  .inline { flex: initial; }
  .trigger { display: flex; align-items: center; gap: 6px; max-width: 220px; }
  @media (max-width: 1399px) { .trigger { max-width: 160px; } .tag { display: none; } }
  .tag { font: 600 11px/1 var(--font-cond); letter-spacing: 0.14em; color: var(--ink-3); }
  .cur { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .caret { font-size: 10px; color: var(--ink-3); }
  .panel {
    position: absolute; left: 0; top: calc(100% + 6px); z-index: 1; width: 280px; padding: var(--s2);
    background: var(--panel); border: 1px solid var(--rule-strong); box-shadow: var(--shadow);
    display: flex; flex-direction: column; gap: var(--s2);
  }
  .inline .panel { position: static; width: auto; padding: 0; border: 0; box-shadow: none; }
  .list { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--rule); }
  .list li + li { border-top: 1px solid var(--rule); }
  .opt { display: flex; align-items: center; gap: var(--s2); width: 100%; min-height: 32px; padding: 4px var(--s2); border: 0; background: none; text-align: left; }
  .opt:hover { background: var(--accent-bg); }
  .opt.on { font-weight: 700; }
  .mark { width: 10px; color: var(--accent); flex: none; }
  .label { overflow-wrap: anywhere; }
  .inline .opt { min-height: 44px; font-size: 14px; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); }
  .actions .btn { flex: 1 1 auto; justify-content: center; }
  .edit { display: flex; flex-direction: column; gap: var(--s1); }
  .field { height: 32px; padding: 0 var(--s2); border: 1px solid var(--rule-strong); background: var(--panel-2); }
  .inline .field { height: 44px; }
  .row-label { font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
</style>
