<script lang="ts">
  import { ECHELONS } from '../../core/model/echelon';
  import { VERBS, SYNTAX } from '../commands/grammar';
  import { sidcSymbol, type Theme } from '../map/symbols';
  import { ui } from './shell.svelte';
  import { AFFILIATIONS, RINGS } from './words';

  let { theme }: { theme: Theme } = $props();
  const opts = $derived(theme === 'dark'
    ? { infoColor: '#dbe4d6', outlineColor: 'rgba(205,216,200,0.62)', outlineWidth: 2.5 }
    : { infoColor: '#1f1d18' });
  const sym = (sidc: string, extra: Record<string, unknown> = {}) => sidcSymbol(sidc, { size: 16, ...opts, ...extra });
  // 2525E: 13 0 S 10 T H EE NNNNNN 0000. Infantry platoon unless stated.
  const frames = $derived(AFFILIATIONS.map(a => ({ ...a, s: sym(`130${a.digit}1000141211000000`) })));
  const statuses = $derived([
    { label: 'Present (to do / active)', s: sym('13031000141211000000') },
    { label: 'Planned: dashed frame', s: sym('13031010141211000000') },
    { label: 'Blocked: single slash', s: sym('13031030141211000000') },
    { label: 'Done friendly: COMPLETE, faded, withdrawing', s: sym('13031020141211000000', {staffComments:'COMPLETE'}) },
    { label: 'Destroyed hostile: X', s: sym('13061040141211000000') },
    { label: 'Task force bracket', s: sym('13031004161211000000') },
  ]);
  const touch: [string, string][] = [
    ['Drag', 'Pan the map'],
    ['Pinch', 'Zoom the map (the page itself does not zoom)'],
    ['Double-tap ground', 'Zoom in there'],
    ['Tap a symbol', 'Select it: the sheet shows its card and quick actions'],
    ['Double-tap a symbol', 'Open every field (full sheet)'],
    ['Long-press a symbol, let go', 'Open every field (full sheet)'],
    ['Long-press a symbol, drag', 'Move it: the symbol lifts, drop to commit'],
    ['Drag the round handle', 'Under a selected friendly: drop on a hostile or suspect to attack'],
    ['Long-press ground', 'Capture a new unit there'],
    ['Second finger during a move', 'Cancels the move and pinches'],
    ['Tab tap or drag the sheet top', 'Peek, half or full sheet'],
  ];
  const mouse: [string, string][] = [
    ['Drag ground / wheel', 'Pan / zoom'],
    ['Click a symbol', 'Inspect it'],
    ['Drag a symbol', 'Move it'],
    ['Drag the handle', 'Attack a hostile or suspect'],
    ['Double-click ground', 'Capture a new unit there'],
    ['/  ·  0  ·  Ctrl+Z', 'Command bar · fit map · undo (Shift: redo)'],
  ];
  const arrows = [
    { label: 'Main attack (one per sector)', cls: 'main' },
    { label: 'Supporting attack (SPT)', cls: 'support' },
    { label: 'Planned: dashed', cls: 'planned' },
    { label: 'Hostile advance', cls: 'advance' },
    { label: 'Move', cls: 'move' },
  ];
</script>

<div class="legend" role="dialog" aria-label="Legend" data-testid="legend" tabindex="-1"
  onkeydown={(e) => { if (e.key === 'Escape') ui.legendOpen = false; }}>
  <header>
    <div class="tabs" role="tablist">
      <button role="tab" class="btn" class:on={ui.legendTab === 'symbols'} aria-selected={ui.legendTab === 'symbols'} onclick={() => (ui.legendTab = 'symbols')}>Symbols</button>
      <button role="tab" class="btn" class:on={ui.legendTab === 'commands'} aria-selected={ui.legendTab === 'commands'} onclick={() => (ui.legendTab = 'commands')}>Commands</button>
      <button role="tab" class="btn" class:on={ui.legendTab === 'gestures'} aria-selected={ui.legendTab === 'gestures'} onclick={() => (ui.legendTab = 'gestures')}>Gestures</button>
    </div>
    <button class="btn" onclick={() => (ui.legendOpen = false)} aria-label="Close legend">✕</button>
  </header>

  <div class="body scroll">
    {#if ui.legendTab === 'symbols'}
      <section>
        <div class="cap">Frame = identity: for me, against me, or neither</div>
        <div class="grid">
          {#each frames as f (f.key)}
            <div class="item"><img src={f.s.href} alt="" width={f.s.width} height={f.s.height} /><span><b>{f.label}</b> {f.meaning}</span></div>
          {/each}
        </div>
        <p class="note">People are neutral (purple civilian fill) by default. The hostile is the problem, not the person.</p>
      </section>
      <section>
        <div class="cap">Status marks</div>
        <div class="grid">
          {#each statuses as s (s.label)}
            <div class="item" class:complete={s.label.startsWith('Done friendly')}><img src={s.s.href} alt="" width={s.s.width} height={s.s.height} /><span>{s.label}</span></div>
          {/each}
        </div>
        <p class="note">K strength bands: ≥ 85 green · 70–84 amber · 50–69 red · &lt; 50 black. A hostile at 0% is destroyed.</p>
      </section>
      <section>
        <div class="cap">Echelon = effort, never urgency</div>
        <table>
          <tbody>
            {#each ECHELONS as e (e.key)}<tr><td class="mark">{e.mark}</td><td class="mono">{e.key}</td><td>{e.range}</td></tr>{/each}
          </tbody>
        </table>
      </section>
      <section>
        <div class="cap">Distance from HQ = time to impact</div>
        <table>
          <tbody>
            {#each RINGS as r (r.key)}<tr><td class="mono">{r.pl}</td><td>{r.label}</td><td>{r.horizon}</td></tr>{/each}
          </tbody>
        </table>
        <p class="note">Each morning, dated hostiles and suspects advance inward and leave a faint trail. A pin means you placed it by hand.</p>
      </section>
      <section>
        <div class="cap">Graphics</div>
        <div class="grid">
          <div class="item"><svg width="38" height="24" viewBox="0 0 38 24" aria-hidden="true"><path d="M4 20 L19 4 L34 20" fill="none" stroke="var(--hostile)" stroke-width="2"/></svg><span>PEN · overdue threat inside HQ</span></div>
          <div class="item"><b class="tag">ENG</b><span>Friendly in contact</span></div>
          <div class="item"><svg width="42" height="24" aria-hidden="true"><path d="M1 14 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0" stroke="var(--friend)" fill="none"/></svg><span>FLOT · active friendly edge</span></div>
          <div class="item"><b class="tag">K</b><span>Key terrain · decisive asset</span></div>
          <div class="item"><svg width="30" height="24" aria-hidden="true"><path d="M15 21v-12m-3-4a3 3 0 1 0 6 0a3 3 0 1 0-6 0" stroke="var(--ink)" fill="none"/></svg><span>Pin · manual date override</span></div>
          <div class="item"><img src={sym('13031002161100000000').href} alt=""/><span>Sector HQ · Staff and Detail</span></div>
          <div class="item"><img src={sym('13031002151211000000', { specialHeadquarters: 'TAC' }).href} alt=""/><span>Command post · /cp main, tac, alt, rear</span></div>
          {#each ['OBJ · objective','EA · engagement area / batch','NAI · named area of interest'] as graphic}<div class="item"><svg width="38" height="24" aria-hidden="true"><path d="M3 8L13 2L33 6L35 18L14 22L2 17Z" stroke="var(--ink)" fill="none"/></svg><span>{graphic}</span></div>{/each}
        </div>
      </section>
      <section>
        <div class="cap">Orders</div>
        {#each arrows as a (a.cls)}
          <div class="item">
            <svg width="64" height="16" viewBox="0 0 64 16" aria-hidden="true" class="arrow {a.cls}">
              {#if a.cls === 'move'}<path d="M2 8 H54" /><path d="M48 3 L58 8 L48 13" class="open" />
              {:else}<path d="M2 8 H50" /><polygon points="48,2 62,8 48,14" class:open={a.cls === 'support'} />{/if}
            </svg>
            <span>{a.label}</span>
          </div>
        {/each}
        <p class="note">Force ratio on the main arrow (staff view): friendly ÷ hostile effort. Red when under 1:3. A pulsing halo marks an unopposed hostile inside PL WEEK.</p>
      </section>
    {:else if ui.legendTab === 'gestures'}
      <section data-testid="gestures">
        <div class="cap">Touch</div>
        <table class="gest"><tbody>
          {#each touch as [g, what] (g)}<tr><td class="g">{g}</td><td>{what}</td></tr>{/each}
        </tbody></table>
      </section>
      <section>
        <div class="cap">Mouse and keyboard</div>
        <table class="gest"><tbody>
          {#each mouse as [g, what] (g)}<tr><td class="g">{g}</td><td>{what}</td></tr>{/each}
        </tbody></table>
      </section>
    {:else}
      <p class="note">Verb first, then the unit by designation, quoted title or #id. Press / anywhere to type. Tab completes.</p>
      <table class="cmds">
        <tbody>
          {#each VERBS as v (v)}<tr><td class="mono verb">/{v}</td><td class="mono">{SYNTAX[v]}</td></tr>{/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .item.complete img {opacity:0.6;}
  .item.complete::after {content:"↶";color:var(--friend);}
  .legend { width: min(420px, calc(100vw - 16px)); max-height: calc(100dvh - 160px); display: flex; flex-direction: column; background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow); }
  header { display: flex; justify-content: space-between; align-items: center; padding: var(--s2); border-bottom: 1px solid var(--rule); background: var(--panel-2); }
  .tabs { display: flex; }
  .tabs .btn + .btn { margin-left: -1px; }
  .body { padding: var(--s2) var(--s3) var(--s3); }
  section + section { margin-top: var(--s3); padding-top: var(--s2); border-top: 1px dashed var(--rule); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s1) var(--s2); margin-top: var(--s1); }
  .item { display: flex; align-items: center; gap: var(--s2); font-size: 12px; min-height: 26px; }
  .item img { flex: none; width: 34px; height: auto; object-fit: contain; }
  .note { color: var(--ink-3); font-size: 12px; margin: var(--s1) 0 0; }
  table { width: 100%; border-collapse: collapse; margin-top: var(--s1); font-size: 12px; }
  td { padding: 2px var(--s1); border-bottom: 1px dotted var(--rule); }
  .mark { font: 700 12px/1 var(--font-mono); width: 44px; text-align: center; }
  .mono { font-family: var(--font-mono); }
  .verb { font-weight: 700; white-space: nowrap; vertical-align: top; }
  .cmds td { font-size: 12px; }
  .gest td { padding: 4px var(--s1); vertical-align: top; }
  .gest .g { font-weight: 700; width: 45%; }
  .body { overscroll-behavior: contain; touch-action: pan-y; }
  :global([data-tier='phone']) .legend { width: 100%; max-height: 100%; }
  :global([data-tier='phone']) .legend header .btn { height: 44px; padding: 0 var(--s3); }
  @media (max-width: 479px) { .grid { grid-template-columns: 1fr; } }
  .arrow { flex: none; }
  .arrow path { fill: none; stroke: var(--friend); stroke-width: 2; }
  .arrow polygon { fill: var(--friend); stroke: var(--friend); stroke-width: 1.2; }
  .arrow.main path { stroke-width: 4.5; }
  .arrow .open { fill: none; }
  .arrow.planned path { stroke-dasharray: 5 3; }
  .arrow.advance path { stroke: var(--hostile); stroke-width: 3; }
  .arrow.advance polygon { fill: var(--hostile); stroke: var(--hostile); }
  .arrow.move path { stroke-width: 1.4; }
</style>
