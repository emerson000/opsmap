<script lang="ts">
  import type { Terrain } from './terrain';
  let { terrain, uid, s = 1, mt = 0 }: { terrain: Terrain; uid: string; s?: number; mt?: number } = $props();
  const b = $derived(terrain.bounds);
</script>

<g class="terrain" aria-hidden="true">
  <defs>
    <pattern id="{uid}-woods" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
      <line x1="0" y1="0" x2="0" y2="6" class="hatch" />
    </pattern>
  </defs>
  <rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} class="ground" />
  {#each terrain.woods as w, i (i)}
    <path d={w.d} class="woods" fill="url(#{uid}-woods)" />
    <path d={w.d} class="woods-edge" />
  {/each}
  {#each terrain.contours as c (c.level)}
    <path d={c.d} class="contour" class:index={c.index} />
  {/each}
  <path d={terrain.river.d} class="river-bank" />
  <path d={terrain.river.d} class="river" />
  {#each terrain.spots as p, i (i)}
    <g transform="translate({p.x} {p.y})">
      <circle r={1.8 * s} class="spot" />
      <text x={4 * s} y={3 * s} class="spot-label" font-size={Math.max(8.5 * s, mt)}>{p.elev}</text>
    </g>
  {/each}
</g>

<style>
  .ground { fill: var(--om-ground); }
  .woods { stroke: none; }
  .woods-edge { fill: var(--om-woods); stroke: var(--om-woods-edge); stroke-width: 0.8; stroke-dasharray: 2 3; }
  .hatch { stroke: var(--om-woods-hatch); stroke-width: 1.2; }
  .contour { fill: none; stroke: var(--om-contour); stroke-width: 0.8; }
  .contour.index { stroke: var(--om-contour-index); stroke-width: 1.3; }
  .river-bank { fill: none; stroke: var(--om-water-bank); stroke-width: 9; stroke-linecap: round; }
  .river { fill: none; stroke: var(--om-water); stroke-width: 2.6; stroke-linecap: round; }
  .spot { fill: var(--om-contour-index); }
  .spot-label { fill: var(--om-contour-index); font-family: var(--om-font); font-style: italic; }
</style>
