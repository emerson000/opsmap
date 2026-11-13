<script lang="ts">
  // The header of an area, phase line or sector view: its glyph (also the Find button), name, kind line,
  // and one status line (what holds now; the phone peek shows it too).
  import { runText } from '../shell.svelte';
  import { echoes } from './echo';

  let { glyph, kind, name, sub, status = '', find = null }: {
    /** The short type mark in the glyph box: OBJ, EA, NAI, PL, SEC. */
    glyph: string;
    /** The class that colors the glyph: area, pl or sector. */
    kind: 'area' | 'pl' | 'sector';
    name: string;
    /** What it is and where: "Objective · Household". */
    sub: string;
    /** What holds now: "2 members · Medium · AXIS ← MOVE". */
    status?: string;
    /** The /find text for this object; the glyph runs it. */
    find?: string | null;
  } = $props();
</script>

<header class="head">
  {#if find}
    <button class="glyph {kind}" type="button" onclick={() => runText(find)} title="Find on map: {find} (F)" aria-label="Find {glyph} {name} on the map" data-testid="find" use:echoes={find}>{glyph}</button>
  {:else}
    <span class="glyph {kind}" aria-hidden="true">{glyph}</span>
  {/if}
  <div class="who">
    <div class="name" data-testid="view-name">{name}</div>
    <div class="sub">{sub}</div>
  </div>
</header>
{#if status}<div class="status" data-testid="view-status">{status}</div>{/if}

<style>
  .head { display: flex; align-items: center; gap: var(--s2); padding-bottom: var(--s1); }
  .glyph {
    flex: none; display: grid; place-items: center; min-width: 44px; height: 32px; padding: 0 var(--s1);
    border: 1.5px solid var(--ink); background: none; font: 700 13px/1 var(--font-mono); letter-spacing: 0.04em; color: var(--ink);
  }
  .glyph.area { border-style: dashed; border-radius: 16px; }
  .glyph.pl { border-width: 0 0 2px; border-color: var(--pl); color: var(--pl); }
  button.glyph:hover { background: var(--accent-bg); }
  :global([data-tier='phone']) .glyph { height: 44px; }
  .who { flex: 1; min-width: 0; }
  .name { font: 700 18px/1.1 var(--font-mono); letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { color: var(--ink-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { margin-bottom: var(--s2); font: 400 12px/1.4 var(--font-mono); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
