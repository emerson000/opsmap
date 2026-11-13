<script lang="ts">
  import type { Scene } from './scene';
  import { linkupSymbol, type Theme } from './symbols';

  let { scene, s = 1, mt = 0, declutter = false, theme, selectedId = null, selectedMeasureId = null, selectedSectorId = null, hitW = 12, moving = null, liftedId = null, freshId = null, pickable = null, pickCursor = null }: {
    scene: Scene; s?: number; mt?: number; declutter?: boolean; theme: Theme; selectedId?: string | null;
    /** The OBJ, EA, NAI or PL open in the sidebar: an area draws selected; orders onto it and axes through it highlight. */
    selectedMeasureId?: string | null;
    /** The sector open in the sidebar: orders on its HQ highlight. */
    selectedSectorId?: string | null;
    /** World width of the invisible stroke that makes an outline grabbable. */
    hitW?: number;
    /** A measure being dragged: drawn offset by (dx, dy) until the drop. */
    moving?: { id: string; dx: number; dy: number } | null;
    /** A measure lifted by a long-press. */
    liftedId?: string | null;
    /** An order just made by drag: its arrow draws in and pulses. */
    freshId?: string | null;
    /** Map pick mode: whether an area may be picked (ringed) or not (dimmed); null outside pick mode. */
    pickable?: ((id: string) => boolean) | null;
    /** The area Tab reached in pick mode. */
    pickCursor?: string | null;
  } = $props();
  const linkup = $derived(linkupSymbol(13, theme));
  const related = (o: Scene['orders'][number]) => (selectedId !== null && (o.fromId === selectedId || o.toId === selectedId))
    || (selectedMeasureId !== null && (o.toId === selectedMeasureId || (o.via?.includes(selectedMeasureId) ?? false)))
    || (selectedSectorId !== null && o.toId === `hq:${selectedSectorId}`);
</script>

<g class="measures">
  {#each scene.measures as m (m.id)}
    <!-- Outline stroke and labels are handles (drag to move); the area inside still pans the map. -->
    {@const ok = pickable ? pickable(m.id) : null}
    <g class="measure {m.type}" class:selected={selectedMeasureId === m.id} class:moving={moving?.id === m.id} class:lifted={liftedId === m.id} class:pick-dim={ok === false} data-measure={m.id}
      transform={moving?.id === m.id ? `translate(${moving.dx} ${moving.dy})` : undefined}>
      {#if ok}<path d={m.outline} class="pick-ring" class:cursor={pickCursor === m.id} />{/if}
      <path d={m.outline} class="outline" />
      <path d={m.outline} class="hit" stroke-width={hitW} data-measure-id={m.id} data-interactive role="button" tabindex="-1" aria-label="{m.label} {m.name} outline" />
      <text x={m.x} y={m.labelY} class="m-type" font-size={Math.max(9.5 * s, mt)} dy={-0.2 * s} data-measure-id={m.id} data-interactive role="button" tabindex="-1" aria-label="{m.label} {m.name}">{m.label}</text>
      {#if !declutter}<text x={m.x} y={m.labelY} class="m-name" font-size={Math.max(7.5 * s, mt)} dy={9 * s} data-measure-id={m.id} data-interactive>{m.name}</text>{/if}
      <title>{m.label} {m.name}: drag the outline or label to move</title>
    </g>
  {/each}
</g>

{#if scene.flot}
  <g class="flot">
    <path d={scene.flot} class="flot-line" />
    {#if scene.flotLabel}<text x={scene.flotLabel.x} y={scene.flotLabel.y} font-size={Math.max(8 * s, mt)} class="flot-label">FLOT</text>{/if}
  </g>
{/if}

<g class="command-lines" aria-hidden="true">
  {#each scene.commandLines as c (c.id)}
    <path d={c.d} class="cmd-line {c.side}" class:related={selectedId !== null && (c.fromId === selectedId || c.toId === selectedId)} data-command-line={c.fromId} stroke-width={2 * s} stroke-dasharray="{5 * s} {3 * s}" />
  {/each}
</g>

<g class="orders">
  {#each scene.orders as o (o.id)}
    <g class="order {o.kind} {o.side ?? ''}" class:fresh={o.id === freshId} class:planned={o.planned} class:related={related(o)} data-order-id={o.id}>
      {#if o.kind === 'axis'}
        <path d={o.outline} class="axis" />
      {:else if o.kind === 'link'}
        <path d={o.shaft} class="shaft" stroke-width={o.width} />
        {#if o.linkup}
          <image href={linkup.href} x={o.linkup.x - linkup.anchor.x * s} y={o.linkup.y - linkup.anchor.y * s} width={linkup.width * s} height={linkup.height * s} />
          {#if o.linkKind}<text x={o.linkup.x + 8 * s} y={o.linkup.y + 3 * s} class="tag" font-size={Math.max(7 * s, mt)}>{o.linkKind === 'handoff' ? 'HO' : 'DEP'}</text>{/if}
        {/if}
      {:else}
        <path d={o.shaft} class="shaft" stroke-width={o.width} pathLength={o.id === freshId ? 1 : undefined} />
        {#if o.kind === 'move' || o.kind === 'withdraw'}
          <polyline points={o.head} class="head open" />
        {:else}
          <polygon points={o.head} class="head" class:open={o.kind === 'support' || o.kind === 'assist'} />
        {/if}
      {/if}
      {#if o.checkpoints}{#each o.checkpoints as c, i (i)}<circle cx={c.x} cy={c.y} r={3.5 * s} class="checkpoint" />{/each}{/if}
      {#if o.obstacle}<path d={o.obstacle} class="obstacle" />{/if}
      {#if o.label}
        <text class="tag" font-size={o.kind === 'withdraw' ? Math.max(9 * s, mt) : Math.max(7.5 * s, mt)} transform="translate({o.label.x} {o.label.y}) rotate({o.label.angle})" text-anchor="middle" dy="0.35em">{o.label.text}</text>
      {/if}
      {#if o.ratio && o.ratioAt}
        <text class="ratio" class:under={o.ratio.under} font-size={Math.max(9 * s, mt)} transform="translate({o.ratioAt.x} {o.ratioAt.y}) rotate({o.ratioAt.angle})" text-anchor="middle" dy="0.35em">{o.ratio.text}</text>
      {/if}
    </g>
  {/each}
</g>

<style>
  .cmd-line { fill: none; stroke: var(--om-ink); stroke-linecap: round; opacity: 0.8; pointer-events: none; }
  .cmd-line.friend { stroke: var(--om-friend); }
  .cmd-line.threat { stroke: var(--om-hostile); }
  .cmd-line.related { opacity: 1; }
  .measure .outline { fill: var(--om-measure-fill); stroke: var(--om-ink); stroke-width: 1.3; stroke-linejoin: round; }
  .measure.obj .outline { stroke-width: 1.8; }
  .measure.nai .outline { stroke-dasharray: 5 3; }
  .measure.ea .outline { stroke-dasharray: 1.5 3; stroke-linecap: round; stroke-width: 1.6; }
  .measure .outline { pointer-events: none; }
  /* Open in the sidebar: an amber outline and a light amber fill. */
  .measure.selected .outline { stroke: var(--om-select); stroke-width: 2.5; fill: var(--om-select); fill-opacity: 0.08; }
  .measure.selected .m-type { fill: var(--om-select); }
  .measure .hit { fill: none; stroke: transparent; pointer-events: stroke; cursor: grab; }
  .measure.moving { opacity: 0.8; }
  .measure.pick-dim { opacity: 0.3; }
  .pick-ring { fill: none; stroke: var(--om-select); stroke-width: 5; stroke-opacity: 0.55; stroke-linejoin: round; pointer-events: none; }
  .pick-ring.cursor { stroke-width: 8; stroke-opacity: 0.9; }
  .measure.lifted { filter: drop-shadow(0 6px 5px rgba(0, 0, 0, 0.4)); }
  .m-type, .m-name { fill: var(--om-ink); font-family: var(--om-font); text-anchor: middle; paint-order: stroke; stroke: var(--om-halo); stroke-width: 2.5px; cursor: grab; }
  .m-type { font-weight: 700; letter-spacing: 0.08em; }
  .m-name { font-family: var(--om-font-cond); letter-spacing: 0.04em; }
  .flot-line { fill: none; stroke: var(--om-friend); stroke-width: 1.2; opacity: 0.7; }
  .flot-label { fill: var(--om-friend); font-family: var(--om-font); font-weight: 700; text-anchor: middle; paint-order: stroke; stroke: var(--om-halo); stroke-width: 2.5px; }
  .orders { pointer-events: none; }
  /* A drag-made attack: the shaft draws from the attacker, then the arrow pulses twice. */
  .order.fresh .shaft { stroke-dasharray: 1; animation: draw-in 450ms ease-out both; }
  .order.fresh { animation: fresh-pulse 900ms ease-in-out 450ms 2; }
  @keyframes draw-in { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes fresh-pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .order.fresh .shaft, .order.fresh { animation: none; } }
  .order { --c: var(--om-friend); }
  .order.advance { --c: var(--om-hostile); }
  /* Withdrawal, away from HQ: a hollow double-line shaft into an open V, and W. In the withdrawing unit's color. */
  .order.withdraw.threat { --c: var(--om-hostile); }
  .order.withdraw.other { --c: var(--om-ink); }
  .order.withdraw .shaft { stroke-linecap: round; }
  .order.withdraw .head.open { stroke-width: 1.8; stroke-linejoin: round; }
  .shaft { fill: none; stroke: var(--c); stroke-linecap: butt; }
  .head { fill: var(--c); stroke: var(--c); stroke-width: 1; stroke-linejoin: miter; }
  .head.open { fill: var(--om-halo); stroke-width: 1.6; }
  polyline.head.open { fill: none; }
  .planned .shaft { stroke-dasharray: 8 5; }
  .planned .head.open { stroke-dasharray: 3 2; }
  .axis { fill: var(--om-axis-fill); stroke: var(--c); stroke-width: 1.6; stroke-linejoin: round; }
  .planned .axis { stroke-dasharray: 8 5; }
  /* Where an axis crosses a phase line it names with `via`. */
  .checkpoint { fill: var(--om-halo); stroke: var(--c); stroke-width: 1.6; }
  .order.link .shaft { stroke: var(--om-ink-soft); stroke-dasharray: 2 3; }
  /* Support between friendlies: long dashes, open head, SPT. */
  .order.assist .shaft { stroke-dasharray: 9 4; }
  .obstacle { fill: none; stroke: var(--om-hostile); stroke-width: 1.8; stroke-linejoin: round; }
  .tag { fill: var(--c); font-family: var(--om-font); font-weight: 700; letter-spacing: 0.06em; paint-order: stroke; stroke: var(--om-halo); stroke-width: 2.5px; }
  .order.link .tag { fill: var(--om-ink-soft); }
  .ratio { fill: var(--c); font-family: var(--om-font); font-weight: 700; paint-order: stroke; stroke: var(--om-halo); stroke-width: 3px; }
  .ratio.under { fill: var(--om-hostile); }
  .order.related .shaft, .order.related .axis { filter: drop-shadow(0 0 2px var(--om-select)); }
</style>
