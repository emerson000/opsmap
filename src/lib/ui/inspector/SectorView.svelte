<script lang="ts">
  // A sector: + Unit… and + Area… (create forms with the sector fixed), its name and width, what is in it by ring,
  // its units and areas, the orders on its HQ, the units beyond PL QUARTER (Pull in), Vikunja, and Manage.
  import type { Command, Doc, Sector, Unit } from '../../../core/model/types';
  import { isArchived } from '../../map/scene';
  import { parse } from '../../commands/grammar';
  import { miniSymbol } from '../mini';
  import { runCommand, type CreateRequest, type Theme } from '../shell.svelte';
  import { RINGS, orderLine, ringOf } from '../words';
  import { slotFor, token } from '../verbs';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import ViewHead from './ViewHead.svelte';
  import Manage from './Manage.svelte';
  import PeekMore from './PeekMore.svelte';
  import CreateForm from './CreateForm.svelte';
  import VikunjaSection from './VikunjaSection.svelte';
  import { deg, scaledWidths } from './place';
  import { echoes, findOf, open, textOf } from './echo';

  const K = 'sector';
  let { doc, sector: s, now, theme, onfocus }: { doc: Doc; sector: Sector; now: Date; theme: Theme; onfocus: (id: string) => void } = $props();

  const sc = (args: Record<string, unknown>): Command => ({ verb: 'sector', args: { sectorId: s.id, ...args } });
  const slot = (form: string) => slotFor('sector', form, 'sector');
  const units = $derived(doc.units.filter(u => u.sectorId === s.id && !isArchived(u, now, doc.lastTurn)));
  const onMap = $derived(units.filter(u => ringOf(u) !== 'beyond'));
  const beyond = $derived(units.filter(u => ringOf(u) === 'beyond'));
  const threats = $derived(units.filter(u => (u.affiliation === 'hostile' || u.affiliation === 'suspect') && u.lifecycle !== 'done'));
  const areas = $derived(doc.measures.filter(m => m.type !== 'pl' && m.sectorId === s.id));
  const hqOrders = $derived(doc.orders.filter(o => o.to === `hq:${s.id}`));
  const end = $derived((s.startDeg + s.widthDeg) % 360);
  const bearing = (n: number) => `${String(Math.round(n) % 360).padStart(3, '0')}°`;
  const others = $derived(doc.sectors.filter(x => x.id !== s.id));
  const desig = (id: string) => doc.units.find(u => u.id === id)?.designation ?? id;

  // ----- create: + Unit… and + Area… open a form with this sector fixed -----
  let creating = $state<CreateRequest | null>(null);
  $effect(() => { void s.id; creating = null; });

  // ----- width: a number from 1 to 359, filled with the current width; the other sectors scale to share the rest -----
  const currentWidth = $derived(Math.round(s.widthDeg * 10) / 10);
  let width = $state<number | null>(null);
  $effect(() => { void s.id; width = currentWidth; });
  /** The typed width, when it differs from the current one (Set and the scaling note only then). */
  const widthNum = $derived(typeof width === 'number' && Number.isFinite(width) && width !== currentWidth ? width : null);
  const changed = $derived(width !== currentWidth);
  const widthCmd = $derived(widthNum !== null ? sc({ action: 'width', degrees: widthNum }) : null);
  const widthText = $derived(widthCmd ? textOf(widthCmd, doc) : null);
  const widthHint = $derived(widthText ?? `/sector width ${token(s.name)} ‹degrees›`);
  const widthCheck = $derived.by(() => {
    if (!widthText) return null;
    const p = parse(widthText, doc);
    return p.ok ? null : p.error;
  });
  const scaled = $derived(widthNum !== null && widthCheck === null ? scaledWidths(doc, s.id, widthNum) : []);
  const single = $derived(doc.sectors.length < 2 ? 'The only sector spans the whole map (360°): add a sector first' : null);
  function setWidth(e: SubmitEvent) {
    e.preventDefault();
    if (widthCmd && !widthCheck) runCommand(widthCmd);
  }

  // ----- Manage -----
  let reassign = $state('');
  $effect(() => { void s.id; reassign = ''; });
  const occupied = $derived(doc.units.some(u => u.sectorId === s.id) || doc.measures.some(m => m.sectorId === s.id));
  const removeCmd = $derived(sc({ action: 'remove', ...(reassign ? { reassign } : {}) }));
  const impact = $derived(hqOrders.length ? `It drops ${hqOrders.length} order${hqOrders.length === 1 ? '' : 's'} on ${s.name} HQ${reassign ? `; they move to ${doc.sectors.find(x => x.id === reassign)?.name} HQ instead` : ''}.` : reassign && occupied ? `Its units and areas move to ${doc.sectors.find(x => x.id === reassign)?.name}.` : null);
  const why = $derived(doc.sectors.length < 2 ? 'The last sector cannot be removed.' : occupied && !reassign ? 'It still holds units or areas: choose a sector to reassign them to.' : null);

  function rename(value: string) {
    const name = value.trim();
    if (name && name !== s.name) runCommand(sc({ action: 'rename', name }));
  }
  const newText = $derived(`/new "‹title›" in ${token(s.name)}`);
  const areaText = $derived(newText.replace('/new "‹title›"', '/obj add "‹name›"'));
</script>

{#snippet row(u: Unit)}
  {@const sym = miniSymbol(u, theme, 12)}
  <button class="urow" title={findOf({ kind: 'unit', id: u.id }, doc)} onclick={() => open({ kind: 'unit', id: u.id }, onfocus)}>
    <span class="usym"><img src={sym.href} alt="" width={Math.min(sym.width, 36)} height={Math.min(sym.height, 20)} /></span>
    <span class="udes">{u.designation}</span>
    <span class="utitle">{u.title}</span>
  </button>
{/snippet}

<ViewHead glyph="SEC" kind="sector" name={s.name} find={textOf({ verb: 'find', args: { sectorId: s.id } }, doc)}
  sub="Sector · {deg(s.widthDeg)} · {bearing(s.startDeg)}–{bearing(end)}"
  status="{onMap.length} unit{onMap.length === 1 ? '' : 's'} · {threats.length} threat{threats.length === 1 ? '' : 's'} · {areas.length} area{areas.length === 1 ? '' : 's'}{beyond.length ? ` · ${beyond.length} beyond` : ''}" />

<div class="actions">
  <button class="btn primary" data-testid="new-unit-open"aria-expanded={creating?.kind === 'unit'} title="Capture a unit in {s.name}: {newText}" use:echoes={newText}
    onclick={() => (creating = creating?.kind === 'unit' ? null : { kind: 'unit', sectorId: s.id })}>+ Unit…</button>
  <button class="btn" data-testid="new-area-open"aria-expanded={creating?.kind === 'area'} title="Add an OBJ, EA or NAI in {s.name}: {areaText}" use:echoes={areaText}
    onclick={() => (creating = creating?.kind === 'area' ? null : { kind: 'area', sectorId: s.id })}>+ Area…</button>
  <PeekMore />
</div>
{#if creating}<CreateForm {doc} {now} req={creating} fixedSector onclose={() => (creating = null)} />{/if}

<Section kind={K} key="sector" title="Sector" summary="{bearing(s.startDeg)}–{bearing(end)} · {deg(s.widthDeg)}">
  <Field label="Name" entry={slot('rename')} cmd={textOf(sc({ action: 'rename', name: s.name }), doc)}>
    <input class="field" value={s.name} onchange={(e) => rename(e.currentTarget.value)} aria-label="Sector name" data-testid="sector-name" />
  </Field>
  <Field label="Width" wide entry={slot('width')} cmd={widthText ?? textOf(sc({ action: 'width', degrees: currentWidth }), doc)}>
    <form class="width" onsubmit={setWidth}>
      <input class="field mono" type="number" min="1" max="359" step="1" bind:value={width}
        aria-label="Sector width in degrees, 1 to 359" aria-describedby="sector-width-note" data-testid="sector-width" disabled={single !== null} />
      <span class="unit">°</span>
      <button class="btn" type="submit" disabled={!widthCmd || widthCheck !== null} data-testid="sector-width-set" title={widthHint}>Set</button>
      {#if changed}<button class="btn" type="button" onclick={() => (width = currentWidth)}>Cancel</button>{/if}
    </form>
    <p class="note" id="sector-width-note" data-testid="sector-width-note" class:bad={widthCheck !== null}>
      {#if single}{single}.
      {:else if widthCheck}{widthCheck}
      {:else if scaled.length && widthNum !== null}Others scale to share {deg(360 - widthNum)}: {scaled.map(x => `${x.name} ${deg(x.from)} → ${deg(x.to)}`).join(', ')}.{#if scaled.some(x => x.to < 15)}{' '}{scaled.filter(x => x.to < 15).map(x => x.name).join(', ')} would be under 15°: labels may not fit.{/if}
      {:else}Allowed 1–359°. The other sectors scale in proportion to share the rest.{/if}
    </p>
  </Field>
</Section>

<Section kind={K} key="rings" title="By ring" summary="{onMap.length} on the map · {beyond.length} beyond">
  <table class="rings">
    <thead><tr><th scope="col">Ring</th><th scope="col">Units</th><th scope="col">Threats</th></tr></thead>
    <tbody>
      {#each RINGS as r (r.key)}
        <tr><th scope="row">{r.label}</th><td>{units.filter(u => ringOf(u) === r.key).length}</td><td class:hot={threats.some(u => ringOf(u) === r.key)}>{threats.filter(u => ringOf(u) === r.key).length}</td></tr>
      {/each}
    </tbody>
  </table>
</Section>

<Section kind={K} key="units" title="Units" count={onMap.length} open={false} summary={onMap.slice(0, 4).map(u => u.designation).join(', ')}>
  {#each onMap as u (u.id)}{@render row(u)}{:else}<p class="muted">No units on the map in {s.name}.</p>{/each}
</Section>

<Section kind={K} key="areas" title="Areas" count={areas.length} summary={areas.map(m => m.name).join(', ') || 'none'}>
  {#each areas as m (m.id)}
    <div class="arow"><span class="tag">{m.type.toUpperCase()}</span><button class="link" title={findOf({ kind: 'measure', id: m.id }, doc)} onclick={() => open({ kind: 'measure', id: m.id })}>{m.name}</button><span class="muted">{m.members?.length ?? 0} mbr</span></div>
  {:else}<p class="muted">No OBJ, EA or NAI in {s.name}.</p>{/each}
</Section>

<Section kind={K} key="hq" title="Sector HQ" count={hqOrders.length} summary={hqOrders.length ? hqOrders.map(o => desig(o.from)).join(', ') : 'no orders on it'}>
  <div data-testid="sector-hq">
    {#each hqOrders as o (o.id)}
      {@const halt = textOf({ verb: 'halt', args: { unit: o.from, order: o.id } }, doc)}
      {@const l = orderLine(doc, o, o.from, now)}
      <div class="arow">
        <button class="link" title={findOf({ kind: 'unit', id: o.from }, doc)} onclick={() => open({ kind: 'unit', id: o.from }, onfocus)}>{desig(o.from)}</button>
        <span class="muted grow">{l.text}</span>
        <button class="x" aria-label="Cancel order: {desig(o.from)} {l.text}" title={halt ?? '/halt'} use:echoes={halt} data-testid="cancel-order"
          onclick={() => runCommand({ verb: 'halt', args: { unit: o.from, order: o.id } })}>✕</button>
      </div>
    {:else}
      <p class="muted">No order targets {s.name} HQ. Orders reach it with "/advancing ‹hostile› on {s.name} hq" or "/moving ‹unit› to {s.name} hq".</p>
    {/each}
  </div>
</Section>

<Section kind={K} key="beyond" title="Beyond PL QUARTER" count={beyond.length} summary={beyond.length ? '' : 'nothing'}>
  <p class="hint">Dated more than 90 days out, or parked off map. Select one to edit it, or pull it back on map.</p>
  {#each beyond as u (u.id)}
    {@const pull = textOf({ verb: 'move', args: { unit: u.id, ring: 'far' } }, doc)}
    <div class="beyond-row">
      {@render row(u)}
      <button class="btn" onclick={() => runCommand({ verb: 'move', args: { unit: u.id, ring: 'far' } })} title="Move into the far ring (sets the override pin on dated items): {pull}" use:echoes={pull}>Pull in</button>
    </div>
  {:else}
    <p class="hint">Nothing beyond the map edge in this sector.</p>
  {/each}
</Section>

<VikunjaSection {doc} kind="sector" sector={s} />

<Manage {doc} label="Remove sector…" cmd={removeCmd} {impact} disabled={why}>
  {#if occupied && others.length}
    <label class="reassign">Reassign to
      <select class="field" bind:value={reassign} aria-label="Reassign to" data-testid="sector-reassign">
        <option value="">—</option>
        {#each others as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
      </select>
    </label>
  {/if}
</Manage>

<style>
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-bottom: var(--s2); }
  .actions .btn { flex: 1 1 0; min-width: max-content; justify-content: center; padding: 0 6px; letter-spacing: 0.06em; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .mono { font-family: var(--font-mono); }
  .muted { color: var(--ink-3); font-size: 12px; margin: 2px 0; }
  .hint { color: var(--ink-3); font-size: 12px; margin: var(--s1) 0; }
  .width { display: flex; align-items: center; gap: var(--s1); }
  .width .field { width: 72px; flex: none; }
  .width .unit { color: var(--ink-2); }
  .note { margin: 2px 0 0; font-size: 12px; color: var(--ink-2); }
  .note.bad { color: var(--hostile); }
  .rings { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rings th, .rings td { padding: 2px var(--s1); border-bottom: 1px dotted var(--rule); text-align: right; font-family: var(--font-mono); }
  .rings th[scope='row'], .rings thead th:first-child { text-align: left; font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); }
  .rings thead th { color: var(--ink-3); font-weight: 600; }
  .rings td.hot { color: var(--hostile); font-weight: 700; }
  .urow { display: grid; grid-template-columns: 40px 72px 1fr; align-items: center; gap: var(--s1); width: 100%; padding: 2px var(--s1); background: none; border: 0; border-bottom: 1px dotted var(--rule); text-align: left; }
  .urow:hover { background: var(--accent-bg); }
  :global([data-tier='phone']) .urow { min-height: 44px; }
  .usym { display: flex; justify-content: center; }
  .udes { font: 700 12px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .utitle { font-size: 12px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .beyond-row { display: flex; align-items: center; gap: var(--s1); }
  .arow { display: flex; align-items: center; gap: var(--s2); padding: 3px 0; border-bottom: 1px dotted var(--rule); }
  .arow .muted { margin-left: auto; }
  .arow .muted.grow { flex: 1; min-width: 0; margin-left: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { flex: none; width: 24px; height: 24px; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .x:hover { color: var(--hostile); border-color: var(--hostile); }
  :global([data-tier='phone']) .x { width: 44px; height: 44px; }
  .tag { font-size: 11px; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: 700 12px/1.4 var(--font-mono); text-align: left; }
  .reassign { display: flex; align-items: center; gap: var(--s1); font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); }
  .reassign .field { width: auto; text-transform: none; }
</style>
