<script lang="ts">
  // Nothing selected: create buttons, what needs attention on the whole map, the sectors and control measures,
  // the AO size, and Vikunja.
  import { localDay } from '../../../core/commands/tokenize';
  import type { Doc, Unit } from '../../../core/model/types';
  import { AO_SIZES, aoScale, aoSizeName, ringForRadius, type AoSize } from '../../../core/model/geometry';
  import { isArchived } from '../../map/scene';
  import { miniSymbol } from '../mini';
  import { env, runCommand, ui, type CreateRequest, type Theme } from '../shell.svelte';
  import { ringOf } from '../words';
  import { token } from '../verbs';
  import CreateForm from './CreateForm.svelte';
  import VikunjaSection from './VikunjaSection.svelte';
  import { deg, plRingNote, ringLabel } from './place';
  import { echoes, findOf, open, textOf } from './echo';

  let { doc, now, theme, onfocus }: { doc: Doc; now: Date; theme: Theme; onfocus: (id: string) => void } = $props();

  const sectorName = (id: string) => doc.sectors.find(s => s.id === id)?.name ?? id;
  const live = $derived(doc.units.filter(u => !isArchived(u, now, doc.lastTurn) && u.lifecycle !== 'done'));
  const inbox = $derived(live.filter(u => u.affiliation === 'pending'));
  const attacked = $derived(new Set(doc.orders.filter(o => o.type === 'attack').map(o => o.to)));
  const unopposed = $derived(live.filter(u => (u.affiliation === 'hostile' || u.affiliation === 'suspect') && u.pos.r < 2 && !attacked.has(u.id)).sort((a, b) => a.pos.r - b.pos.r));
  const mains = $derived(doc.orders.filter(o => o.type === 'attack' && o.role === 'main').map(o => ({ from: doc.units.find(u => u.id === o.from), to: doc.units.find(u => u.id === o.to) ?? undefined, o })).filter(m => m.from));
  const blocked = $derived(live.filter(u => u.lifecycle === 'blocked'));
  const aoCmd = (k: AoSize) => ({ verb: 'sector', args: { action: 'size', size: k } });
  const threat = (u: Unit) => u.affiliation === 'hostile' || u.affiliation === 'suspect';
  const sectorRows = $derived(doc.sectors.map(s => {
    const here = live.filter(u => u.sectorId === s.id && ringOf(u) !== 'beyond');
    return { s, units: here.length, threats: here.filter(threat).length };
  }));
  const measures = $derived([...doc.measures].sort((a, b) => Number(a.type === 'pl') - Number(b.type === 'pl') || a.name.localeCompare(b.name)));
  const home = $derived(doc.sectors.find(s => s.name.toLowerCase() === 'household') ?? doc.sectors[0]);
  /** The create buttons: + Unit… is the one filled. Each opens the form under them; pressed again, it closes. */
  const CREATE: { kind: CreateRequest['kind']; label: string; hint: string }[] = [
    { kind: 'unit', label: '+ Unit…', hint: '/new "‹title›" in ‹sector›' },
    { kind: 'area', label: '+ Area…', hint: '/obj add "‹name›" in ‹sector›' },
    { kind: 'pl', label: '+ Phase line…', hint: '/pl add "‹name›" ‹date›' },
    { kind: 'sector', label: '+ Sector…', hint: '/sector add ‹name›' },
  ];
  function create(kind: CreateRequest['kind']) { ui.create = ui.create?.kind === kind ? null : { kind, sectorId: home?.id }; }
</script>

{#snippet row(u: Unit, extra?: string)}
  {@const sym = miniSymbol(u, theme, 12)}
  <button class="urow" title={findOf({ kind: 'unit', id: u.id }, doc)} onclick={() => open({ kind: 'unit', id: u.id }, onfocus)}>
    <span class="usym"><img src={sym.href} alt="" width={Math.min(sym.width, 36)} height={Math.min(sym.height, 20)} /></span>
    <span class="udes">{u.designation}</span>
    <span class="utitle">{extra ?? u.title}</span>
  </button>
{/snippet}

{#if doc.intent?.date === localDay(now, doc.settings.tz)}<p class="intent"><b>Intent:</b> {doc.intent.text}</p>{/if}
<div class="actions" data-testid="situation-create">
  {#each CREATE as c, i (c.kind)}
    <button class="btn" class:primary={i === 0} data-testid="new-{c.kind}-open" aria-expanded={ui.create?.kind === c.kind} title={c.hint} use:echoes={c.hint} onclick={() => create(c.kind)}>{c.label}</button>
  {/each}
</div>
{#if ui.create}<CreateForm {doc} {now} req={ui.create} onclose={() => (ui.create = null)} />{/if}
<section class="block">
  <div class="cap sub-cap threat">Unopposed inside PL WEEK <b>{unopposed.length}</b></div>
  {#each unopposed as u (u.id)}{@render row(u)}{:else}<p class="muted">None. Every close threat has a friendly on it.</p>{/each}
</section>
<section class="block">
  <div class="cap sub-cap">Main efforts <b>{mains.length}</b></div>
  {#each mains as m (m.o.id)}{@render row(m.from!, `→ ${m.to?.designation ?? 'objective'} · ${sectorName(m.from!.sectorId)}`)}{:else}<p class="muted">No main effort assigned.</p>{/each}
</section>
<section class="block">
  <div class="cap sub-cap">Blocked <b>{blocked.length}</b></div>
  {#each blocked as u (u.id)}{@render row(u, u.note ?? u.title)}{:else}<p class="muted">Nothing blocked.</p>{/each}
</section>
<section class="block" data-testid="situation-inbox">
  <div class="cap sub-cap pending">Inbox (pending) <b>{inbox.length}</b></div>
  {#each inbox as u (u.id)}{@render row(u)}{:else}<p class="muted">Inbox empty.</p>{/each}
</section>
<section class="block" data-testid="situation-sectors">
  <div class="cap sub-cap">Sectors <b>{doc.sectors.length}</b></div>
  <table class="tbl">
    <thead><tr><th scope="col">Sector</th><th scope="col">Width</th><th scope="col">Units</th><th scope="col">Threats</th></tr></thead>
    <tbody>
      {#each sectorRows as r (r.s.id)}
        <tr>
          <th scope="row"><button class="link" onclick={() => open({ kind: 'sector', id: r.s.id })} title="/find sector {token(r.s.name)}">{r.s.name}</button></th>
          <td>{deg(r.s.widthDeg)}</td><td>{r.units}</td><td class:hot={r.threats > 0}>{r.threats}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
<section class="block" data-testid="situation-measures">
  <div class="cap sub-cap">Control measures <b>{measures.length}</b></div>
  {#each measures as m (m.id)}
    <button class="mrow" title={findOf({ kind: 'measure', id: m.id }, doc)} onclick={() => open({ kind: 'measure', id: m.id })}>
      <span class="mtag" class:pl={m.type === 'pl'}>{m.type.toUpperCase()}</span>
      <span class="mname">{m.name}</span>
      <span class="mmeta">{m.type === 'pl' ? plRingNote(m.date, now, doc.settings.tz).replace(/^Lands in the |\.$/g, '') : `${sectorName(m.sectorId ?? '')}${m.pos ? ` · ${ringLabel(ringForRadius(m.pos.r))}` : ''} · ${m.members?.length ?? 0} mbr`}</span>
    </button>
  {:else}<p class="muted">No OBJ, EA, NAI or phase line yet: + Area… or + Phase line… adds one.</p>{/each}
</section>
<section class="block ao" data-testid="ao-size">
  <div class="cap sub-cap" id="ao-label">AO size <code class="code">/ao size</code></div>
  <div class="seg" role="radiogroup" aria-labelledby="ao-label">
    {#each Object.keys(AO_SIZES) as AoSize[] as k (k)}
      {@const on = aoSizeName(aoScale(doc)) === k}
      {@const t = textOf(aoCmd(k), doc)}
      <button class="btn" role="radio" aria-checked={on} class:on data-size={k} use:echoes={t} title="{t}: {k === 'medium' ? 'default spacing' : AO_SIZES[k] > 1 ? 'smaller symbols, more room per ring' : 'larger symbols, less room'}"
        onclick={() => { if (!on) runCommand(aoCmd(k)); }}>{k === 'xl' ? 'XL' : k[0].toUpperCase() + k.slice(1)}</button>
    {/each}
  </div>
</section>
<VikunjaSection {doc} kind="map" />
{#if env.coarse || env.tier === 'phone'}
  <p class="hint">Tap a symbol to inspect it; double-tap or long-press for every field. Long-press, then drag to move it. Long-press open ground to capture there. Drag the round handle under a selected friendly onto a hostile to attack.</p>
{:else}
  <p class="hint">Click a symbol, an area, a phase line or a sector name to inspect it. Double-click open ground to capture there. Drag a symbol or an area to move it; drag a unit's handle onto a hostile to attack.</p>
{/if}

<style>
  .intent { margin: 0 0 var(--s2); font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-bottom: var(--s2); }
  .actions .btn { flex: 1 1 calc(50% - var(--s1)); justify-content: center; padding: 0 6px; letter-spacing: 0.06em; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .block { margin-top: var(--s3); padding-top: var(--s2); border-top: 1px solid var(--rule); }
  .block:first-of-type { margin-top: 0; }
  .sub-cap { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s1); }
  .sub-cap b { font-family: var(--font-mono); color: var(--ink); }
  .sub-cap.threat b { color: var(--hostile); }
  .code { font: 400 11px/1.3 var(--font-mono); letter-spacing: 0; text-transform: none; color: var(--ink-3); }
  .ao .seg { display: flex; margin-top: var(--s1); }
  .ao .seg .btn { flex: 1; justify-content: center; }
  .ao .seg .btn + .btn { margin-left: -1px; }
  .muted { color: var(--ink-3); margin: 2px 0; font-size: 12px; }
  .hint { color: var(--ink-3); font-size: 12px; margin: var(--s2) 0; }
  :global([data-tier='phone']) .urow { min-height: 44px; }
  .urow { display: grid; grid-template-columns: 40px 72px 1fr; align-items: center; gap: var(--s1); width: 100%; padding: 2px var(--s1); background: none; border: 0; border-bottom: 1px dotted var(--rule); text-align: left; }
  .urow:hover { background: var(--accent-bg); }
  .usym { display: flex; justify-content: center; }
  .udes { font: 700 12px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .utitle { font-size: 12px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
  .tbl th, .tbl td { padding: 2px var(--s1); border-bottom: 1px dotted var(--rule); text-align: right; font-family: var(--font-mono); }
  .tbl th[scope='row'], .tbl thead th:first-child { text-align: left; }
  .tbl thead th { color: var(--ink-3); font: 600 11px/1.3 var(--font-cond); letter-spacing: 0.06em; text-transform: uppercase; }
  .tbl td.hot { color: var(--hostile); font-weight: 700; }
  :global([data-tier='phone']) .tbl th, :global([data-tier='phone']) .tbl td { height: 44px; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: 700 12px/1.4 var(--font-mono); text-align: left; }
  .mrow { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 0 var(--s2); width: 100%; padding: 3px var(--s1); background: none; border: 0; border-bottom: 1px dotted var(--rule); text-align: left; font-size: 12px; }
  .mrow:hover { background: var(--accent-bg); }
  :global([data-tier='phone']) .mrow { min-height: 44px; }
  .mtag { grid-row: span 2; font: 700 10px/14px var(--font-mono); text-align: center; border: 1px dashed var(--ink-2); border-radius: 7px; color: var(--ink); }
  .mtag.pl { border: 0; border-bottom: 2px solid var(--pl); border-radius: 0; color: var(--pl); }
  .mname { font: 700 12px/1.3 var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mmeta { grid-column: 2; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
