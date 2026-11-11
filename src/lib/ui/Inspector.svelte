<script lang="ts">
  import { localDay } from '../../core/commands/tokenize';
  import type { Command, Doc, Ring, Unit } from '../../core/model/types';
  import { ECHELONS } from '../../core/model/echelon';
  import { FUNCTIONS } from '../../core/model/functions';
  import { formatDtg, toSidc } from '../../core/model/sidc';
  import { effectiveCondition } from '../../core/model/derive';
  import { selection } from '../model/store.svelte';
  import { dispatch } from '../commands/dispatch';
  import { parseDate } from '../../core/commands/tokenize';
  import { miniSymbol } from './mini';
  import { annotate, initials, color, nameOf } from '../sync/sync.svelte';
  import { isArchived } from '../map/scene';
  import { AO_SIZES, aoScale, aoSizeName, type AoSize } from '../../core/model/geometry';
  import { features } from '../model/features.svelte';
  import { ui, env, run, toast, type Theme } from './shell.svelte';
  import { AFFILIATIONS, AFF_LABEL, CONDITIONS, LIFECYCLE_LABEL, RINGS, band, echelonRange, orderLine, ringOf, unitLabel } from './words';

  const TRIAGE_IDS = [
    { key: 'friend', label: 'Friend', hint: 'My own effort or asset' },
    { key: 'hostile', label: 'Hostile', hint: 'A confirmed problem' },
    { key: 'suspect', label: 'Suspect', hint: 'Probably a problem (a risk)' },
    { key: 'neutral', label: 'Neutral', hint: 'Outside party or constraint' },
  ];
  const TRIAGE_SIZES = ECHELONS.filter(e => ['tm', 'sqd', 'plt', 'coy', 'bn'].includes(e.key));
  let { doc, now, theme, onfocus }: { doc: Doc; now: Date; theme: Theme; onfocus: (id: string) => void } = $props();

  const unit = $derived(doc.units.find(u => u.id === selection.selectedId));
  const sectorName = (id: string) => doc.sectors.find(s => s.id === id)?.name ?? id;
  const beyondUnits = $derived(ui.beyondSector ? doc.units.filter(u => u.sectorId === ui.beyondSector && ringOf(u) === 'beyond' && !isArchived(u, now, doc.lastTurn)) : []);

  function select(id: string) { selection.selectedId = id; ui.beyondSector = null; onfocus(id); }
  const cmd = (verb: string, args: Record<string, unknown> = {}): Command => ({ verb, args: { unit: unit!.id, ...args } });

  // Identity changes on a person need an explicit confirm.
  let confirmHostile = $state(false);
  function setIdentity(affiliation: string) {
    const res = dispatch(cmd('id', { affiliation }));
    if (res.ok) { confirmHostile = false; return; }
    if (/person hostile/i.test(res.error)) confirmHostile = true; else toast(res.error);
  }

  function dateInput(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function setDue(value: string) {
    if (!value) { run(cmd('due', { dueAt: null })); return; }
    try { run(cmd('due', { dueAt: parseDate(value,new Date(),doc.settings.tz) })); } catch (e) { toast(e instanceof Error ? e.message : 'Invalid date'); }
  }
  function setStrength(value: string) {
    if (value.trim() === '') return;
    const n = Number(value);
    if (!Number.isFinite(n)) { toast('Strength must be a number from 0 to 100'); return; }
    run(cmd('bda', { strength: n }));
  }
  function setTitle(value: string) { if (value.trim() && value !== unit!.title) run(cmd('rename', { title: value })); }
  function setDesignation(value: string) {
    const d = value.trim().toUpperCase();
    if (d && d !== unit!.designation) run(cmd('rename', { title: unit!.title, designation: d }));
  }
  function setNote(value: string) { if (value !== (unit!.note ?? '')) run(cmd('note', { note: value })); }
  function setRating(value: string) { if (value.trim() && value.toUpperCase() !== unit!.rating) run(cmd('rate', { rating: value.trim() })); }
  function setPlace(sectorId: string, ring: Ring) { run(cmd('move', { sectorId, ring })); }

  let blockReason = $state('');
  let blocking = $state(false);
  let sidcDraft = $state('');
  $effect(() => { void unit?.id; blocking = false; blockReason = ''; confirmHostile = false; sidcDraft = ''; });

  const history = $derived.by(() => {
    if (!unit) return [];
    const re = new RegExp(`(^|[^A-Z0-9_-])${unit.designation.replace(/-/g, '\\-')}([^A-Z0-9_-]|$)`);
    return doc.log.filter(l => re.test(l.text.toUpperCase())).slice(-8).reverse();
  });
  const orders = $derived(unit ? doc.orders.filter(o => o.from === unit.id || o.to === unit.id) : []);
  const parent = $derived(unit?.parentId ? doc.units.find(u => u.id === unit.parentId) : undefined);
  const members = $derived(unit ? doc.units.filter(u => u.parentId === unit.id) : []);
  const areas = $derived(doc.measures.filter(m => m.type !== 'pl'));
  const area = $derived(unit ? areas.find(m => m.members?.includes(unit.id)) : undefined);
  /** Join the chosen area (the unit moves inside it), or leave the current one. */
  function setArea(id: string) {
    if (!unit) return;
    const target = areas.find(m => m.id === id);
    if (target) run({ verb: target.type, args: { action: 'join', measure: target.id, units: [unit.id] } });
    else if (area) run({ verb: area.type, args: { action: 'leave', measure: area.id, units: [unit.id] } });
  }
  const cond = $derived(unit ? effectiveCondition(unit) : 'none');
  const k = $derived(band(unit?.strength));
  const resolved = $derived(unit ? unit.lifecycle === 'done' || unit.lifecycle === 'dropped' : false);
  const threat = $derived(unit ? unit.affiliation === 'hostile' || unit.affiliation === 'suspect' : false);

  // Situation overview when nothing is selected.
  const live = $derived(doc.units.filter(u => !isArchived(u, now, doc.lastTurn) && u.lifecycle !== 'done'));
  const inbox = $derived(live.filter(u => u.affiliation === 'pending'));
  const attacked = $derived(new Set(doc.orders.filter(o => o.type === 'attack').map(o => o.to)));
  const unopposed = $derived(live.filter(u => (u.affiliation === 'hostile' || u.affiliation === 'suspect') && u.pos.r < 2 && !attacked.has(u.id)).sort((a, b) => a.pos.r - b.pos.r));
  const mains = $derived(doc.orders.filter(o => o.type === 'attack' && o.role === 'main').map(o => ({ from: doc.units.find(u => u.id === o.from), to: doc.units.find(u => u.id === o.to) ?? undefined, o })).filter(m => m.from));
  const blocked = $derived(live.filter(u => u.lifecycle === 'blocked'));
  const CP_TYPES = [
    { key: 'main', label: 'main command post' }, { key: 'tac', label: 'tactical, forward' },
    { key: 'alt', label: 'alternate, backup' }, { key: 'rear', label: 'rear, support' },
  ] as const;
</script>

{#snippet row(u: Unit, extra?: string)}
  {@const sym = miniSymbol(u, theme, 12)}
  <button class="urow" onclick={() => select(u.id)}>
    <span class="usym"><img src={sym.href} alt="" width={Math.min(sym.width, 36)} height={Math.min(sym.height, 20)} /></span>
    <span class="udes">{u.designation}</span>
    <span class="utitle">{extra ?? u.title}</span>
  </button>
{/snippet}

<aside class="inspector scroll" aria-label="Inspector" data-testid="inspector">
  {#if ui.beyondSector}
    <header class="head">
      <div class="cap">Beyond PL QUARTER · {sectorName(ui.beyondSector).toUpperCase()}</div>
      <button class="btn" onclick={() => (ui.beyondSector = null)} aria-label="Close list">Close</button>
    </header>
    <p class="hint">Dated more than 90 days out, or parked off map. Select one to edit it, or pull it back on map.</p>
    {#each beyondUnits as u (u.id)}
      <div class="beyond-row">
        {@render row(u)}
        <button class="btn" onclick={() => run({ verb: 'move', args: { unit: u.id, ring: 'far' } })} title="Move into the far ring (sets the override pin on dated items)">Pull in</button>
      </div>
    {:else}
      <p class="hint">Nothing beyond the map edge in this sector.</p>
    {/each}
  {:else if unit}
    {@const sym = miniSymbol(unit, theme, 24)}
    <header class="head unit-head">
      <img class="big" src={sym.href} alt="" width={sym.width} height={sym.height} />
      <div class="who">
        <div class="desig">{unit.designation}</div>
        <div class="ttl">{unit.title}</div>
        <div class="sub">{AFF_LABEL[unit.affiliation]}{unit.cp ? ` · ${unit.cp.toUpperCase()} CP` : unit.fn === 'hq' ? ' · HQ' : ''} · {unit.presence === 'planned' ? 'planned (dashed)' : 'present'} · {LIFECYCLE_LABEL[unit.lifecycle]}</div>
        {#if unit.vk && features.vikunja}<a class="vk-link" data-testid="vk-link" href="{features.vikunja.url}/tasks/{unit.vk}" target="_blank" rel="noopener noreferrer">Vikunja task #{unit.vk} ↗</a>{/if}
      </div>
      <button class="btn close" onclick={() => { selection.selectedId = null; }} aria-label="Close inspector">✕</button>
    </header>

    <div class="actions">
      {#if !resolved}
        <button class="btn" onclick={() => onfocus(unit.id)}>Find</button>
        {#if !threat}
          {#if unit.lifecycle === 'blocked'}
            <button class="btn" onclick={() => run(cmd('unblock'))}>Unblock</button>
          {:else}
            <button class="btn" onclick={() => (blocking = !blocking)} class:on={blocking}>Block</button>
          {/if}
        {/if}
        <button class="btn" onclick={() => run(cmd('done'))} title={threat ? 'Destroyed (X)' : 'Complete: fully capable today, then withdraws to HQ'}>{threat ? 'Destroyed' : 'Done'}</button>
        <button class="btn" onclick={() => run(cmd('drop', threat ? { bypassed: true } : {}))} title={threat ? 'Went away by itself: BYPASSED' : 'Withdraw and archive'}>{threat ? 'Bypassed' : 'Drop'}</button>
      {:else}
        <span class="hint">{unit.lifecycle === 'done' ? 'Completed' : 'Archived'} {formatDtg(unit.updatedAt)}. Undo with /undo.</span>
      {/if}
    </div>
    {#if !resolved && (unit.affiliation === 'pending' || unit.affiliation === 'unknown')}
      <!-- Triage in two taps: what is it, and how much effort. -->
      <div class="triage" role="group" aria-label="Identify" data-testid="triage-identity">
        <span class="tri-label">What is it?</span>
        {#each TRIAGE_IDS as t (t.key)}<button class="btn chip-btn {t.key}" title={t.hint} onclick={() => setIdentity(t.key)}>{t.label}</button>{/each}
      </div>
      <div class="triage" role="group" aria-label="Effort" data-testid="triage-effort">
        <span class="tri-label">Effort</span>
        {#each TRIAGE_SIZES as e (e.key)}<button class="btn chip-btn" class:on={unit.echelon === e.key} title="{e.key} · {e.range}" aria-pressed={unit.echelon === e.key} onclick={() => run(cmd('size', { echelon: e.key }))}>{e.range}</button>{/each}
      </div>
    {/if}
    {#if blocking}
      <form class="inline" onsubmit={(e) => { e.preventDefault(); run(cmd('block', blockReason.trim() ? { note: blockReason.trim() } : {})); blocking = false; }}>
        <input class="field" placeholder="Blocked by… (goes in G)" bind:value={blockReason} aria-label="Block reason" />
        <button class="btn" type="submit">Set</button>
      </form>
    {/if}

    <dl class="fields">
      <dt><span class="tag">T</span> Designation</dt>
      <dd><input class="field mono" value={unit.designation} onchange={(e) => setDesignation(e.currentTarget.value)} aria-label="Designation" /></dd>

      <dt><span class="tag">H</span> Title</dt>
      <dd><input class="field" value={unit.title} onchange={(e) => setTitle(e.currentTarget.value)} aria-label="Title" /></dd>

      <dt><span class="tag">SIDC</span> Identity (frame)</dt>
      <dd>
        <select class="field" value={unit.affiliation} onchange={(e) => setIdentity(e.currentTarget.value)} aria-label="Identity">
          {#each AFFILIATIONS as a (a.key)}<option value={a.key}>{a.label} — {a.meaning}</option>{/each}
        </select>
        {#if confirmHostile}
          <div class="confirm">
            Mark a person hostile? The problem is usually the situation, not the person.
            <button class="btn warn" onclick={() => { run(cmd('id', { affiliation: 'hostile', confirm: true })); confirmHostile = false; }}>Mark hostile</button>
            <button class="btn" onclick={() => (confirmHostile = false)}>Keep</button>
          </div>
        {/if}
      </dd>

      <dt><span class="tag">AA</span> Command post</dt>
      <dd>
        <select class="field" value={unit.cp ?? ''} onchange={(e) => { const el = e.currentTarget; run(cmd('cp', { cp: el.value || null })); el.value = unit?.cp ?? ''; }} aria-label="Command post" data-testid="unit-cp">
          <option value="">None</option>
          {#each CP_TYPES as c (c.key)}<option value={c.key}>{c.key.toUpperCase()} · {c.label}</option>{/each}
        </select>
      </dd>

      <dt><span class="tag">SIDC</span> Function (icon)</dt>
      <dd>
        <select class="field" value={unit.fn} onchange={(e) => run(cmd('fn', { fn: e.currentTarget.value }))} aria-label="Function">
          {#each FUNCTIONS as f (f.key)}<option value={f.key}>{f.key} — {f.label}</option>{/each}
        </select>
      </dd>

      <dt><span class="tag">B</span> Effort (echelon)</dt>
      <dd>
        <select class="field" value={unit.echelon ?? ''} onchange={(e) => run(cmd('size', { echelon: e.currentTarget.value }))} aria-label="Echelon">
          {#if !unit.echelon}<option value="" disabled>Unknown effort</option>{/if}
          {#each ECHELONS as e (e.key)}<option value={e.key}>{e.mark} {e.key} · {e.range}</option>{/each}
        </select>
      </dd>

      <dt>Sector · ring</dt>
      <dd class="pair">
        <select class="field" value={unit.sectorId} onchange={(e) => setPlace(e.currentTarget.value, ringOf(unit))} aria-label="Sector">
          {#each doc.sectors as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
        </select>
        <select class="field" value={ringOf(unit)} onchange={(e) => setPlace(unit.sectorId, e.currentTarget.value as Ring)} aria-label="Ring">
          {#each RINGS as r (r.key)}<option value={r.key}>{r.label} · {r.horizon}</option>{/each}
        </select>
        {#if unit.posOverride}<span class="note">Pinned by hand: auto-advance skips it.</span>
          <button class="btn" data-testid="unpin" title="Return to the ring its due date gives (/unpin)" onclick={() => run(cmd('unpin'))}>Unpin</button>{/if}
      </dd>

      <dt>Area (OBJ · EA · NAI)</dt>
      <dd>
        <select class="field" value={area?.id ?? ''} onchange={(e) => { const el = e.currentTarget; setArea(el.value); el.value = area?.id ?? ''; }} aria-label="Area" data-testid="unit-area">
          <option value="">None</option>
          {#each areas as m (m.id)}<option value={m.id}>{m.type.toUpperCase()} {m.name}</option>{/each}
        </select>
      </dd>

      <dt><span class="tag">W</span> Due (DTG)</dt>
      <dd class="pair">
        <input class="field" type="date" value={dateInput(unit.dueAt)} onchange={(e) => setDue(e.currentTarget.value)} aria-label="Due date" />
        <span class="dtg">{unit.dueAt ? formatDtg(unit.dueAt) : 'undated'}</span>
      </dd>

      <dt><span class="tag">SIDC</span> Condition (status)</dt>
      <dd>
        <select class="field" value={unit.condition} onchange={(e) => run(cmd('bda', { condition: e.currentTarget.value }))} aria-label="Condition">
          {#each CONDITIONS as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
        </select>
        {#if unit.condition === 'none' && cond !== 'none'}<span class="note">Derived from strength: {cond}.</span>{/if}
      </dd>

      <dt><span class="tag">K</span> Strength</dt>
      <dd class="pair">
        <input class="field num" type="number" min="0" max="100" step="5" value={unit.strength ?? ''} placeholder="—"
          onchange={(e) => setStrength(e.currentTarget.value)} aria-label="Strength percent" />
        {#if k}<span class="k k-{k}">{k.toUpperCase()} {unit.strength}%</span>{/if}
        <span class="note">{threat ? 'Problem remaining. 0% destroys it.' : 'Capacity, for information only.'}</span>
      </dd>

      <dt><span class="tag">F</span> Reinforced / reduced</dt>
      <dd class="pair">
        <span class="mono">{unit.reinforced ? `(${unit.reinforced})` : '—'}</span>
        <button class="btn" onclick={() => run(cmd('reinforce'))}>(+)</button>
        <button class="btn" onclick={() => run(cmd('reduce'))}>(−)</button>
      </dd>

      <dt><span class="tag">G</span> Staff comments</dt>
      <dd><textarea class="field" rows="2" value={unit.note ?? ''} onchange={(e) => setNote(e.currentTarget.value)} aria-label="Staff comments"></textarea></dd>

      <dt><span class="tag">J</span> Rating (Admiralty)</dt>
      <dd><input class="field mono short" value={unit.rating ?? ''} placeholder="e.g. B2" maxlength="2" onchange={(e) => setRating(e.currentTarget.value)} aria-label="Evaluation rating" /></dd>

      <dt>Key terrain</dt>
      <dd><label class="check"><input type="checkbox" checked={Boolean(unit.keyTerrain)} onchange={(e) => run(cmd('key', { value: e.currentTarget.checked }))} /> Loss would be decisive</label></dd>

      <dt><span class="tag">M</span> Task force</dt>
      <dd>
        {#if parent}
          <span class="pair">Attached to <button class="link" onclick={() => select(parent.id)}>TF {parent.designation}</button>
            <button class="btn" onclick={() => run(cmd('detach'))}>Detach</button></span>
        {:else if members.length}
          <span>TF bracket over {members.length} unit{members.length > 1 ? 's' : ''}:
            {#each members as m, i (m.id)}{i ? ', ' : ' '}<button class="link" onclick={() => select(m.id)}>{m.designation}</button>{/each}</span>
        {:else}<span class="muted">Not attached</span>{/if}
      </dd>

      <dt><span class="tag">SIDC</span> SIDC</dt>
      <dd>
        <code class="sidc" title="2525E 20-digit symbol identification code">{toSidc(unit)}</code>
        {#if unit.sidcOverride}<span class="note">User override.</span>{/if}
        <form class="inline" onsubmit={(e) => { e.preventDefault(); if (sidcDraft.trim()) run(cmd('sidc', { sidc: sidcDraft.trim() })); }}>
          <input class="field mono" placeholder="Override: 20 digits" bind:value={sidcDraft} maxlength="20" aria-label="SIDC override" />
          <button class="btn" type="submit" disabled={sidcDraft.trim().length !== 20}>Set</button>
        </form>
      </dd>
    </dl>

    <section class="block">
      <div class="cap">Orders</div>
      {#each orders as o (o.id)}
        {@const line = orderLine(doc, o, unit.id)}
        <div class="order">
          {#if line.otherId}<button class="link" onclick={() => select(line.otherId!)}>{line.text}</button>{:else}<span>{line.text}</span>{/if}
          {#if line.ratio}<span class="ratio" class:under={line.ratio.under}>{line.ratio.text}</span>{/if}
          <button class="x" aria-label="Cancel order: {line.text}" title="Cancel this order (/halt)" data-testid="cancel-order"
            onclick={() => run({ verb: 'halt', args: { unit: o.from, order: o.id } })}>✕</button>
        </div>
      {:else}
        <p class="muted">No orders. {threat ? 'Unopposed.' : `Try /attack ${unit.designation} ‹target›.`}</p>
      {/each}
    </section>

    <section class="block">
      <div class="cap">History</div>
      {#each history as h (h.id)}
        {@const by = annotate(h.id)}
        <div class="hist" class:undone={by?.undone}><span class="when">{formatDtg(h.at).slice(0, 6)}</span>{#if by}<span class="by" style="--who:{by.color}" title="{by.name}{by.ai ? ' (AI agent)' : ''}">{by.initials}{by.ai ? ' AI' : ''}</span>{/if} {by?.text ?? h.text}</div>
      {:else}
        <p class="muted">No log entries.</p>
      {/each}
      <div class="meta">Created {formatDtg(unit.createdAt)}{#if unit.createdBy} by {nameOf(unit.createdBy)}{/if} · {unitLabel(unit)} · {echelonRange(unit.echelon)}</div>
      {#if unit.updatedBy}<div class="meta" data-testid="updated-by">Last changed {formatDtg(unit.updatedAt)} by <span class="by" style="--who:{color(unit.updatedBy)}">{initials(unit.updatedBy)}</span> {nameOf(unit.updatedBy)}</div>{/if}
    </section>
  {:else}
    <header class="head"><div class="cap">Situation</div>{#if env.tier === 'phone'}<button class="btn" onclick={() => (ui.sitrepOpen = true)} data-testid="situation-sitrep">SITREP</button>{/if}</header>
    {#if doc.intent?.date === localDay(now,doc.settings.tz)}<p class="intent"><b>Intent:</b> {doc.intent.text}</p>{/if}
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
    <section class="block ao" data-testid="ao-size">
      <div class="cap sub-cap" id="ao-label">AO size</div>
      <div class="seg" role="radiogroup" aria-labelledby="ao-label">
        {#each Object.keys(AO_SIZES) as AoSize[] as k (k)}
          {@const on = aoSizeName(aoScale(doc)) === k}
          <button class="btn" role="radio" aria-checked={on} class:on data-size={k} title="/ao size {k}: {k === 'medium' ? 'default spacing' : AO_SIZES[k] > 1 ? 'smaller symbols, more room per ring' : 'larger symbols, less room'}"
            onclick={() => { if (!on) run({ verb: 'sector', args: { action: 'size', size: k } }); }}>{k === 'xl' ? 'XL' : k[0].toUpperCase() + k.slice(1)}</button>
        {/each}
      </div>
    </section>
    {#if env.coarse || env.tier === 'phone'}
      <p class="hint">Tap a symbol to inspect it; double-tap or long-press for every field. Long-press, then drag to move it. Long-press open ground to capture there. Drag the round handle under a selected friendly onto a hostile to attack.</p>
    {:else}
      <p class="hint">Click a symbol to inspect it. Double-click open ground to capture there. Drag a symbol to move it; drag its handle onto a hostile to attack.</p>
    {/if}
  {/if}
</aside>

<style>
  .hist .by, .meta .by { display: inline-block; margin: 0 4px; padding: 0 3px; font: 700 12px/1.4 var(--font-mono); color: #fff; background: var(--who); border-radius: 2px; }
  .vk-link { display: inline-block; margin-top: 2px; font-size: 12px; color: var(--ink); }
  .ao .seg { display: flex; margin-top: var(--s1); }
  .ao .seg .btn { flex: 1; }
  .ao .seg .btn + .btn { margin-left: -1px; }
  .hist.undone { text-decoration: line-through; opacity: 0.65; }
  .inspector { height: 100%; padding: var(--s3); background: var(--panel-glass); border-left: 2px solid var(--rule-strong); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); padding-bottom: var(--s2); border-bottom: 1px solid var(--rule); margin-bottom: var(--s2); }
  .unit-head { justify-content: flex-start; }
  .big { flex: none; max-width: 96px; height: auto; }
  .who { flex: 1; min-width: 0; }
  .desig { font: 700 18px/1.1 var(--font-mono); letter-spacing: 0.04em; }
  .ttl { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { color: var(--ink-2); font-size: 12px; }
  .close { align-self: flex-start; padding: 0 6px; }
  :global([data-tier='phone']) .close { width: 44px; height: 44px; justify-content: center; padding: 0; }
  .triage { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); margin-bottom: var(--s2); }
  .tri-label { font: 600 12px/1.2 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); width: 100%; }
  .chip-btn { text-transform: none; letter-spacing: 0.02em; }
  .chip-btn.friend { border-color: var(--friend); color: var(--friend); }
  .chip-btn.hostile { border-color: var(--hostile); color: var(--hostile); }
  .chip-btn.suspect { border-color: var(--k-amber); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-bottom: var(--s2); }
  .inline { display: flex; gap: var(--s1); margin: var(--s1) 0 var(--s2); }
  .fields { display: grid; grid-template-columns: 1fr; margin: 0; }
  dt { margin-top: var(--s2); margin-bottom: 2px; font: 600 12px/1.3 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); display: flex; align-items: center; gap: 6px; }
  dt .tag { min-width: 22px; font-size: 12px; line-height: 13px; }
  dd { margin: 0; }
  .pair { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); }
  .pair .field { flex: 1 1 110px; width: auto; }
  .num { flex: 0 0 72px !important; }
  .short { width: 64px; }
  .mono, .sidc { font-family: var(--font-mono); }
  .sidc { display: block; font-size: 12px; letter-spacing: 0.04em; padding: 2px 0; }
  .dtg { font: 600 12px/1 var(--font-mono); color: var(--ink-2); }
  .note { display: block; width: 100%; color: var(--ink-3); font-size: 12px; }
  .muted { color: var(--ink-3); margin: 2px 0; font-size: 12px; }
  .hint { color: var(--ink-3); font-size: 12px; margin: var(--s2) 0; }
  .check { display: flex; align-items: center; gap: 6px; }
  .k { font: 700 12px/1 var(--font-mono); padding: 4px 5px; color: #fff; }
  .k-green { background: var(--k-green); } .k-amber { background: var(--k-amber); } .k-red { background: var(--k-red); } .k-black { background: var(--k-black); color: var(--panel); }
  .confirm { margin-top: var(--s1); padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; display: flex; flex-wrap: wrap; gap: var(--s1); align-items: center; }
  .block { margin-top: var(--s3); padding-top: var(--s2); border-top: 1px solid var(--rule); }
  .sub-cap { display: flex; justify-content: space-between; margin-bottom: var(--s1); }
  .sub-cap b { font-family: var(--font-mono); color: var(--ink); }
  .sub-cap.threat b { color: var(--hostile); }
  .order { display: flex; justify-content: space-between; gap: var(--s2); padding: 3px 0; border-bottom: 1px dotted var(--rule); }
  .ratio { font: 700 12px/1 var(--font-mono); }
  .order .x { margin-left: auto; flex: none; min-width: 24px; height: 22px; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .order .x:hover { color: var(--hostile); border-color: var(--hostile); }
  :global([data-tier='phone']) .order .x { min-width: 44px; height: 36px; }
  .ratio.under { color: var(--hostile); }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; text-align: left; }
  .hist { font-size: 12px; padding: 2px 0; color: var(--ink-2); }
  .when { color: var(--ink-3); }
  .meta { margin-top: var(--s2); color: var(--ink-3); font-size: 12px; }
  :global([data-tier='phone']) .urow { min-height: 44px; }
  :global([data-tier='phone']) .inspector { overscroll-behavior: contain; touch-action: pan-y; }
  .urow { display: grid; grid-template-columns: 40px 72px 1fr; align-items: center; gap: var(--s1); width: 100%; padding: 2px var(--s1); background: none; border: 0; border-bottom: 1px dotted var(--rule); text-align: left; }
  .urow:hover { background: var(--accent-bg); }
  .usym { display: flex; justify-content: center; }
  .udes { font: 700 12px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .utitle { font-size: 12px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .beyond-row { display: flex; align-items: center; gap: var(--s1); }
</style>
