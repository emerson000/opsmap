<script lang="ts">
  import type { Scene } from './scene';
  import { hqSymbol, sectorHqSymbol, type Theme } from './symbols';
  import { HQ_SIZE, RIM_LABEL_R, SCALE, SECTOR_HQ_SIZE } from './constants';
  import { arcTextPath } from './arrows';

  let { scene, uid, s = 1, mt = 0, declutter = false, theme, view = 'commander', activeSectorId = null, selectedMeasureId = null, selectedSectorId = null, hitW = 12, onbeyond }: {
    scene: Scene; uid: string; mt?: number; declutter?: boolean; view?: 'commander'|'staff'|'detail'; s?: number; theme: Theme; activeSectorId?: string | null;
    /** The phase line open in the sidebar: an amber halo along its ring. */
    selectedMeasureId?: string | null;
    /** The sector open in the sidebar: its rim label and the band beyond its edge in amber. */
    selectedSectorId?: string | null;
    /** World width of the invisible stroke that makes a custom phase line clickable (12 px on screen, 24 px for touch). */
    hitW?: number;
    onbeyond?: (sectorId: string) => void;
  } = $props();

  /** The arc under a rim label's text (not the whole span), so the rest of the rim stays open ground. */
  function rimHit(sec: Scene['sectors'][number]): string {
    const fs = Math.max(12 * s, mt), r = RIM_LABEL_R * SCALE;
    const textDeg = (sec.name.length * fs * 0.9 / r) * 180 / Math.PI + 4;
    return arcTextPath(r - fs * 0.35, sec.centerDeg, Math.min(Math.max(sec.widthDeg - 6, 10), textDeg));
  }

  const hq = $derived(hqSymbol('HQ', HQ_SIZE, theme));
  const chevronPath = (k: number) => `M${-7 * k} ${-6 * k} L0 0 L${-7 * k} ${6 * k} M${-1 * k} ${-6 * k} L${6 * k} 0 L${-1 * k} ${6 * k}`;
</script>

<g class="framework">
  <!-- Off-map band beyond PL QUARTER -->
  {#each scene.sectors as sec (sec.id)}
    <path d={sec.band} class="band" class:selected={sec.id === selectedSectorId} />
  {/each}
  <!-- Sector wedges (areas of operations) -->
  {#each scene.sectors as sec (sec.id)}
    <path d={sec.wedge} class="wedge" class:odd={sec.index % 2 === 1} class:active={sec.id === activeSectorId} />
  {/each}

  <!-- Phase lines: ring borders are time -->
  {#each scene.rings as ring (ring.key)}
    <circle r={ring.r} class="pl" class:edge={ring.key === 'far'} />
    <!-- Decluttered (phone commander view): one label per phase line, on the upper arc. -->
    {#each declutter ? ring.paths.slice(0, 1) : ring.paths as d, i (i)}
      <path id="{uid}-pl-{ring.key}-{i}" {d} class="guide" />
      <text class="pl-label" font-size={Math.max(8.5 * s, mt)} dy={-3 * s}>
        <textPath href="#{uid}-pl-{ring.key}-{i}" startOffset="50%" text-anchor="middle">{ring.label}{declutter ? '' : ` ${ring.date}`}</textPath>
      </text>
    {/each}
  {/each}
  <!-- Custom phase lines: the ring and its labels select it (the stock rings above stay open ground). -->
  {#each scene.customPls as pl (pl.id)}
    {@const selected = pl.id === selectedMeasureId}
    <g class="cpl" class:selected data-pl={pl.id}>
      {#if selected}<circle r={pl.r} class="pl-halo" stroke-width={9 * s} />{/if}
      <circle r={pl.r} class="pl custom" />
      <circle r={pl.r} class="pl-hit" stroke-width={hitW} data-measure-id={pl.id} data-interactive role="button" tabindex="-1" aria-label="{pl.label} {pl.date}" />
      {#each declutter ? pl.paths.slice(0, 1) : pl.paths as d, i (i)}
        <path id="{uid}-cpl-{pl.id}-{i}" {d} class="guide" />
        <text class="pl-label custom" font-size={Math.max(8.5 * s, mt)} dy={-3 * s} data-measure-id={pl.id} data-interactive>
          <textPath href="#{uid}-cpl-{pl.id}-{i}" startOffset="50%" text-anchor="middle">{pl.label}{declutter ? '' : ` ${pl.date}`}</textPath>
        </text>
      {/each}
      <title>{pl.label}: click to open it</title>
    </g>
  {/each}

  <!-- Boundaries with the echelon mark (battalion, II) at the midpoint -->
  {#each scene.sectors as sec (sec.id)}
    {#each sec.boundary.segments as [a, b], i (i)}
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="boundary" />
    {/each}
    <text class="echelon-mark" font-size={Math.max(10 * s, mt)} transform="translate({sec.boundary.mark.x} {sec.boundary.mark.y}) rotate({sec.boundary.mark.angle})" dy="0.35em">II</text>
  {/each}

  <!-- Sector names on the rim: the name selects the sector (the wedge itself stays open ground). -->
  {#each scene.sectors as sec (sec.id)}
    <path id="{uid}-rim-{sec.id}" d={sec.rimPath} class="guide" />
    <g class="rim" data-sector-id={sec.id} data-interactive role="button" tabindex="-1" aria-label="Sector {sec.name}">
      <path d={rimHit(sec)} class="rim-hit" stroke-width={Math.max(12 * s, mt) * 1.7} />
      <text class="rim-label" class:active={sec.id === activeSectorId || sec.id === selectedSectorId} class:selected={sec.id === selectedSectorId} font-size={Math.max(12 * s, mt)}>
        <textPath href="#{uid}-rim-{sec.id}" startOffset="50%" text-anchor="middle">{sec.name.toUpperCase()}</textPath>
      </text>
      <title>Sector {sec.name}: click to open it</title>
    </g>
  {/each}

  <!-- Beyond chevrons with counts -->
  {#each scene.sectors as sec (sec.id)}
    {#if sec.beyondCount > 0}
      <g class="chevron" data-interactive data-beyond={sec.id} transform="translate({sec.chevron.x} {sec.chevron.y})"
        role="button" tabindex="-1" aria-label="{sec.beyondCount} beyond in {sec.name}"
        onclick={(e) => { e.stopPropagation(); onbeyond?.(sec.id); }}
        onkeydown={(e) => { if (e.key === 'Enter') onbeyond?.(sec.id); }}>
        <circle r={13 * s} class="chevron-hit" />
        <path d={chevronPath(s)} transform="rotate({sec.chevron.angle}) translate({4 * s} 0)" class="chevron-mark" />
        <text class="chevron-count" font-size={Math.max(9 * s, mt)} dy="0.35em" x={0} y={-15 * s} text-anchor="middle">{sec.beyondCount}</text>
        <title>{sec.beyondCount} beyond PL QUARTER in {sec.name}</title>
      </g>
    {/if}
  {/each}

  <!-- Sector HQs at each wedge's inner edge, life HQ at the center -->
  {#each scene.sectors.filter(x => view !== 'commander' || x.hqTargeted) as sec (sec.id)}
    {@const sym = sectorHqSymbol(SECTOR_HQ_SIZE, theme, sec.name.toUpperCase().slice(0,4))}
    <image href={sym.href} x={sec.hq.x - sym.center.x * s} y={sec.hq.y - sym.center.y * s} width={sym.width * s} height={sym.height * s} class="hq-symbol">
      <title>{sec.name} sector HQ</title>
    </image>
  {/each}
  <!-- Frame centered on the origin; the staff points down to it. -->
  <image href={hq.href} x={-hq.center.x * s} y={-hq.center.y * s} width={hq.width * s} height={hq.height * s} class="hq-symbol" />
</g>

<style>
  .band { fill: var(--om-band); stroke: none; }
  .band.selected { fill: var(--om-select); fill-opacity: 0.16; }
  .wedge { fill: var(--om-sector-a); stroke: none; transition: fill 120ms; }
  .wedge.odd { fill: var(--om-sector-b); }
  .wedge.active { fill: var(--om-sector-active); }
  .pl { fill: none; stroke: var(--om-pl); stroke-width: 1.1; stroke-dasharray: 9 5; }
  .pl.edge { stroke-width: 1.6; stroke-dasharray: none; }
  .pl.custom { stroke: var(--om-pl-custom); stroke-dasharray: 3 4; }
  .pl-hit { fill: none; stroke: transparent; pointer-events: stroke; cursor: pointer; }
  .pl-halo { fill: none; stroke: var(--om-select); stroke-opacity: 0.35; pointer-events: none; }
  .cpl.selected .pl.custom { stroke: var(--om-select); stroke-width: 1.8; }
  .cpl .pl-label.custom { cursor: pointer; }
  .cpl.selected .pl-label.custom { fill: var(--om-select); }
  .guide { fill: none; stroke: none; }
  .pl-label { fill: var(--om-pl); font-family: var(--om-font); letter-spacing: 0.06em; font-weight: 600; paint-order: stroke; stroke: var(--om-halo); stroke-width: 3px; }
  .pl-label.custom { fill: var(--om-pl-custom); }
  .boundary { stroke: var(--om-ink); stroke-width: 1.4; opacity: 0.75; }
  .echelon-mark { fill: var(--om-ink); font-family: var(--om-font); font-weight: 700; text-anchor: middle; opacity: 0.8; }
  .rim-label { fill: var(--om-ink); font-family: var(--om-font-cond); font-weight: 700; letter-spacing: 0.32em; opacity: 0.72; paint-order: stroke; stroke: var(--om-halo); stroke-width: 3px; }
  .rim-label.active { opacity: 1; }
  .rim-label.selected { fill: var(--om-select); }
  .rim { cursor: pointer; }
  .rim-hit { fill: none; stroke: transparent; pointer-events: stroke; }
  .rim:hover .rim-label { opacity: 1; }
  .chevron { cursor: pointer; }
  .chevron-hit { fill: var(--om-halo); opacity: 0.6; stroke: var(--om-ink-soft); stroke-width: 0.8; }
  .chevron:hover .chevron-hit { opacity: 1; stroke: var(--om-select); }
  .chevron-mark { fill: none; stroke: var(--om-ink); stroke-width: 1.8; stroke-linejoin: round; }
  .chevron-count { fill: var(--om-ink); font-family: var(--om-font); font-weight: 700; paint-order: stroke; stroke: var(--om-halo); stroke-width: 3px; }
  .hq-symbol { pointer-events: none; }
</style>
