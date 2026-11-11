<script lang="ts">
  import { tick } from 'svelte';
  import type { Doc } from '../../core/model/types';
  import { selection } from '../model/store.svelte';
  import { formatDtg } from '../../core/model/sidc';
  import { ui, env, run, setThemePref, type ThemePref } from './shell.svelte';
  import { PREF_LABEL, nextPref, themeLabel } from './theme';
  import { live, session, isAdmin, initials, color, nameOf, logout, currentMap } from '../sync/sync.svelte';
  import MapSwitcher from './MapSwitcher.svelte';
  import { features } from '../model/features.svelte';

  let { doc, now, onimportlocal }: { doc: Doc; now: Date; onimportlocal: () => void } = $props();

  const views = [
    { key: 'commander', label: 'Commander', hint: 'Frames, icons, echelons, main efforts' },
    { key: 'staff', label: 'Staff', hint: 'Adds K, F, DTG, support arrows, force ratios, FLOT' },
    { key: 'detail', label: 'Detail', hint: 'Full amplifiers on the selected unit' },
  ] as const;
  const prefs: ThemePref[] = ['system', 'light', 'dark'];
  const inbox = $derived(doc.units.filter(u => u.affiliation === 'pending' && u.lifecycle !== 'dropped' && u.lifecycle !== 'done').length);
  const admin = $derived(isAdmin(session.me));
  // One chip per online user; this user last.
  const online = $derived.by(() => {
    const ids = [...new Set(live.online.map(p => p.userId))];
    const me = session.me?.id;
    return [...ids.filter(id => id !== me), ...ids.filter(id => id === me)];
  });
  const statusLabel = $derived(live.status === 'live' ? 'Live' : live.status === 'offline' ? 'Offline' : live.status === 'connecting' ? 'Connecting' : 'Reconnecting');
  const themeText = $derived(themeLabel(ui.themePref, env.systemDark));
  const desktop = $derived(env.tier === 'desktop');
  const phone = $derived(env.tier === 'phone');
  let userOpen = $state(false);

  function closeMenus() { userOpen = false; ui.menuOpen = false; }
  /** Menu actions close the menu first, so the panel they open is not hidden behind it. */
  function act(fn: () => void) { return () => { ui.menuOpen = false; fn(); }; }
  /** Situation at half height, scrolled to the inbox list. */
  function openInbox() {
    selection.selectedId = null; ui.beyondSector = null; ui.sheetTab = 'info'; ui.sheet = 'half';
    void tick().then(() => document.querySelector('[data-testid="situation-inbox"]')?.scrollIntoView({ block: 'start' }));
  }
  function setView(key: string) { if (doc.settings.view !== key) run({ verb: 'view', args: { view: key } }); }
</script>

{#snippet themeChoice()}
  <div class="row-label" id="theme-label">{themeText}</div>
  <div class="seg" role="radiogroup" aria-labelledby="theme-label" data-testid="theme-choice">
    {#each prefs as p (p)}
      <button class="btn" role="radio" aria-checked={ui.themePref === p} class:on={ui.themePref === p} data-pref={p} onclick={() => setThemePref(p)}>{PREF_LABEL[p]}</button>
    {/each}
  </div>
{/snippet}

<header class="topbar {env.tier}">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="name" data-testid="brand-name">{phone && live.maps.length > 1 ? currentMap()?.name ?? 'OPSMAP' : 'OPSMAP'}</span>
  </div>
  {#if !phone}<MapSwitcher />{/if}
  <div class="dtg" title="Current date-time group, local time (J)" data-testid="dtg">{formatDtg(now)}</div>
  {#if inbox && !phone}
    <div class="inbox" title="Pending items not yet triaged (dashed yellow frames)">INBOX <b>{inbox}</b></div>
  {/if}

  {#if !phone}
    <div class="group" role="group" aria-label="View level">
      {#each views as v (v.key)}
        <button class="btn" class:on={doc.settings.view === v.key} title={v.hint} aria-pressed={doc.settings.view === v.key} onclick={() => setView(v.key)}>{v.label}</button>
      {/each}
    </div>
  {/if}

  <div class="spacer"></div>

  {#if desktop}
    <button class="btn" onclick={() => (ui.sitrepOpen = !ui.sitrepOpen)} class:on={ui.sitrepOpen} aria-pressed={ui.sitrepOpen}>SITREP</button>
    <button class="btn" onclick={() => { ui.legendOpen = !ui.legendOpen; ui.legendTab = 'symbols'; }} class:on={ui.legendOpen} aria-pressed={ui.legendOpen} aria-haspopup="dialog">Legend</button>
    <span class="sep" aria-hidden="true"></span>
  {/if}
  <div class="conn {live.status}" data-testid="connection" data-status={live.status} title="{statusLabel}{live.pending ? `: ${live.pending} change${live.pending === 1 ? '' : 's'} waiting for the server` : ''}">
    <span class="dot" aria-hidden="true"></span><span class="conn-text">{statusLabel}</span>{#if live.pending}<b data-testid="pending-count">{live.pending}</b>{/if}
  </div>
  <div class="chips" role="list" aria-label="Online users" data-testid="online-users">
    {#each online as id (id)}
      <span class="chip" role="listitem" style="--who:{color(id)}" data-user-id={id} title="{nameOf(id)}{id === session.me?.id ? ' (you)' : ''} is online">{initials(id)}</span>
    {/each}
  </div>

  {#if desktop}
    <span class="sep" aria-hidden="true"></span>
    <button class="btn" onclick={() => run({ verb: 'export', args: {} })} title="Download the map as JSON">Export</button>
    {#if admin}
      <button class="btn" onclick={() => run({ verb: 'import', args: {} })} title="Replace this map with a JSON file, for everyone (admin)">Import</button>
      {#if live.localMap}<button class="btn" onclick={onimportlocal} title="Copy the map saved in this browser by opsmap v1 into the shared map" data-testid="import-local">Import my local map</button>{/if}
    {/if}
    <span class="sep" aria-hidden="true"></span>
    <button class="btn theme" data-testid="theme-toggle" onclick={() => setThemePref(nextPref(ui.themePref))}
      aria-label="{themeText}. Change to {PREF_LABEL[nextPref(ui.themePref)]}" title="{themeText}. Click for {PREF_LABEL[nextPref(ui.themePref)]}.">
      {ui.themePref === 'system' ? `System (${env.systemDark ? 'night' : 'day'})` : PREF_LABEL[ui.themePref]}
    </button>
    {#if session.me}
      <div class="user">
        <button class="btn" aria-haspopup="menu" aria-expanded={userOpen} onclick={() => (userOpen = !userOpen)} data-testid="user-menu"
          title={session.me.name ?? session.me.email} style="--who:{color(session.me.id)}"><span class="chip me">{initials(session.me.id)}</span><span class="uname">{session.me.name ?? session.me.email}</span></button>
        {#if userOpen}
          <div class="menu" role="menu">
            <div class="who">{session.me.name}<span>{session.me.email}{admin ? ' · admin' : ''}</span></div>
            {#if features.vikunja}<button class="btn" role="menuitem" data-testid="menu-vikunja" onclick={() => { userOpen = false; ui.vikunjaOpen = true; }}>Vikunja…</button>{/if}
            <button class="btn" role="menuitem" onclick={logout}>Log out</button>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <button class="btn menu-btn" aria-haspopup="dialog" aria-expanded={ui.menuOpen} aria-controls="app-menu" data-testid="app-menu-button"
      onclick={() => (ui.menuOpen = !ui.menuOpen)}>
      <span class="burger" aria-hidden="true"></span><span class="menu-text">Menu</span>
    </button>
  {/if}
</header>

{#if ui.menuOpen && !desktop}
  <div class="app-menu {env.tier}" id="app-menu" role="dialog" aria-label="Menu" data-testid="app-menu" tabindex="-1">
    {#if phone}
      <MapSwitcher inline ondone={() => (ui.menuOpen = false)} />
      {#if inbox}<button class="inbox wide" data-testid="menu-inbox" onclick={act(openInbox)}>INBOX <b>{inbox}</b> pending · triage</button>{/if}
      <div class="row-label">View</div>
      <div class="seg" role="group" aria-label="View level">
        {#each views as v (v.key)}
          <button class="btn" class:on={doc.settings.view === v.key} aria-pressed={doc.settings.view === v.key} onclick={() => setView(v.key)}>{v.label}</button>
        {/each}
      </div>
    {/if}
    <div class="items">
      <button class="btn item" onclick={act(() => { ui.sitrepOpen = true; })}>SITREP</button>
      <button class="btn item" onclick={act(() => { ui.legendOpen = true; ui.legendTab = 'symbols'; })}>Legend</button>
      <button class="btn item" onclick={act(() => { ui.legendOpen = true; ui.legendTab = 'gestures'; })}>Gestures and help</button>
      {#if features.vikunja}<button class="btn item" data-testid="menu-vikunja" onclick={act(() => { ui.vikunjaOpen = true; })}>Vikunja…</button>{/if}
    </div>
    {@render themeChoice()}
    <div class="items">
      <button class="btn item" onclick={act(() => run({ verb: 'export', args: {} }))}>Export JSON</button>
      {#if admin}
        <button class="btn item" onclick={act(() => run({ verb: 'import', args: {} }))}>Replace map (admin)</button>
        {#if live.localMap}<button class="btn item" onclick={act(onimportlocal)} data-testid="import-local">Import my local map</button>{/if}
      {/if}
    </div>
    {#if session.me}
      <div class="me-row">
        <span class="chip" style="--who:{color(session.me.id)}">{initials(session.me.id)}</span>
        <div class="who">{session.me.name}<span>{session.me.email}{admin ? ' · admin' : ''}</span></div>
        <button class="btn" onclick={logout}>Log out</button>
      </div>
    {/if}
  </div>
{/if}

<svelte:window
  onclick={(e) => { const t = e.target as HTMLElement; if (!t.isConnected) return; if (userOpen && !t.closest?.('.user')) userOpen = false; if (ui.menuOpen && !t.closest?.('.app-menu, .menu-btn')) ui.menuOpen = false; }}
  onkeydown={(e) => { if (e.key === 'Escape' && (userOpen || ui.menuOpen)) { closeMenus(); } }} />

<style>
  .topbar {
    position: absolute; inset: 0 0 auto 0; height: var(--bar-h); z-index: 20;
    display: flex; align-items: center; gap: var(--s2); padding: 0 var(--s3);
    background: var(--panel); border-bottom: 2px solid var(--rule-strong);
    touch-action: pan-x pan-y; /* a pinch on the bar must not zoom the page */
  }
  .brand { display: flex; align-items: center; gap: var(--s2); margin-right: var(--s2); }
  .mark { width: 18px; height: 12px; border: 2px solid var(--ink); position: relative; flex: none; }
  .mark::after { content: ''; position: absolute; left: 2px; right: 2px; top: 50%; border-top: 2px solid var(--ink); }
  .name { font: 700 15px/1 var(--font-cond); letter-spacing: 0.3em; }
  .dtg { font: 600 14px/1 var(--font-mono); letter-spacing: 0.06em; padding: 4px var(--s2); border: 1px solid var(--rule); background: var(--panel-2); white-space: nowrap; }
  .inbox { font: 600 12px/1 var(--font-cond); letter-spacing: 0.12em; padding: 5px var(--s2); border: 1px dashed #b39500; color: var(--ink); background: rgba(255, 238, 120, 0.22); white-space: nowrap; }
  .inbox b { font-family: var(--font-mono); }
  .group { display: flex; margin-left: var(--s2); }
  .group .btn + .btn { margin-left: -1px; }
  .spacer { flex: 1; min-width: 0; }
  .conn { display: flex; align-items: center; gap: 6px; font: 600 12px/1 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
  .conn .dot { width: 8px; height: 8px; border-radius: 50%; background: #b45309; flex: none; }
  .conn.live .dot { background: #15803d; }
  .conn.offline .dot { background: #b91c1c; }
  .conn.reconnecting .dot, .conn.connecting .dot { animation: blink 1s steps(2) infinite; }
  .conn b { font-family: var(--font-mono); padding: 1px 5px; border: 1px solid var(--rule); }
  @keyframes blink { 50% { opacity: 0.3; } }
  .chips { display: flex; gap: 4px; }
  .chip { display: inline-grid; place-items: center; min-width: 26px; height: 20px; padding: 0 4px; font: 700 12px/1 var(--font-mono); color: #fff; background: var(--who); border-radius: 2px; }
  .user { position: relative; }
  .user > .btn { display: flex; align-items: center; gap: 6px; }
  .chip.me { min-width: 24px; height: 18px; }
  /* Under 1400 px the name goes to the tooltip and the menu; the chip identifies the user. */
  @media (max-width: 1399px) { .uname { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; } }
  .menu { position: absolute; right: 0; top: calc(100% + 6px); min-width: 200px; padding: var(--s2); background: var(--panel); border: 1px solid var(--rule-strong); display: flex; flex-direction: column; gap: var(--s2); z-index: 40; }
  .who { font-weight: 600; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .who span { font: 12px/1.2 var(--font-mono); color: var(--ink-3); font-weight: 400; overflow-wrap: anywhere; }
  .sep { width: 1px; height: 18px; background: var(--rule); margin: 0 var(--s1); }
  .burger { width: 16px; height: 12px; border-top: 2px solid currentColor; border-bottom: 2px solid currentColor; position: relative; }
  .burger::after { content: ''; position: absolute; left: 0; right: 0; top: 3px; border-top: 2px solid currentColor; }
  .menu-btn { gap: var(--s2); }

  /* Tablet, and desktop under 1400 px: the brand name yields to the controls and the map switcher. */
  .tablet .name { display: none; }
  @media (max-width: 1399px) { .desktop .name { display: none; } }

  /* Phone: brand mark, DTG, live dot + chips, menu. Safe areas pad the bar. */
  .topbar.phone { height: calc(var(--bar-h) + env(safe-area-inset-top)); padding: env(safe-area-inset-top) calc(var(--s2) + env(safe-area-inset-right)) 0 calc(var(--s2) + env(safe-area-inset-left)); gap: var(--s2); }
  .phone .brand { margin-right: 0; min-width: 0; }
  .phone .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 30vw; letter-spacing: 0.12em; }
  .phone .dtg { font-size: 13px; padding: 4px 6px; }
  .phone .conn-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .phone .conn .dot { width: 10px; height: 10px; }
  .phone .menu-btn { height: 44px; min-width: 44px; justify-content: center; padding: 0 var(--s2); border-color: transparent; }
  .phone .chip { height: 24px; min-width: 28px; }
  @media (max-width: 399px) { .phone .name, .phone .menu-text { display: none; } }

  .app-menu {
    position: absolute; z-index: 40; display: flex; flex-direction: column; gap: var(--s2);
    padding: var(--s3); background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow);
    overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
  }
  .app-menu.tablet { top: calc(var(--bar-h) + 4px); right: var(--s3); width: 320px; max-height: calc(100dvh - var(--bar-h) - 16px); }
  .app-menu.phone {
    top: calc(var(--bar-h) + env(safe-area-inset-top)); left: 0; right: 0; max-height: calc(100dvh - var(--bar-h) - env(safe-area-inset-top));
    border-width: 0 0 2px; padding: var(--s3) calc(var(--s3) + env(safe-area-inset-right)) calc(var(--s3) + env(safe-area-inset-bottom)) calc(var(--s3) + env(safe-area-inset-left));
  }
  .app-menu .btn { height: 44px; font-size: 13px; justify-content: center; }
  .row-label { font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); margin-top: var(--s1); }
  .seg { display: flex; }
  .seg .btn { flex: 1; }
  .seg .btn + .btn { margin-left: -1px; }
  .items { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s1); margin-top: var(--s1); }
  .items .item:last-child:nth-child(odd) { grid-column: 1 / -1; }
  .inbox.wide { padding: 10px var(--s2); min-height: 44px; text-align: left; cursor: pointer; }
  .me-row { display: flex; align-items: center; gap: var(--s2); margin-top: var(--s2); padding-top: var(--s3); border-top: 1px solid var(--rule); }
  .me-row .who { flex: 1; }
  .me-row .btn { padding: 0 var(--s3); }
</style>
