<script lang="ts">
  // An OBJ, EA or NAI: + Order onto… (pick the unit, then its order composer), then Place (name, sector and ring,
  // near a unit, size), Members (join and leave several at once), the orders that target it, History and Manage.
  // Every control runs its command text; the unit pickers also pick on the map (⌖ Map).
  import { onDestroy, tick, untrack } from 'svelte';
  import type { Command, ControlMeasure, Doc, Order, Ring, Unit } from '../../../core/model/types';
  import { AREA_SIZES, areaSizeName, ringForRadius, type AreaSize } from '../../../core/model/geometry';
  import { formatDtg } from '../../../core/model/sidc';
  import { isArchived } from '../../map/scene';
  import type { Sel } from '../../model/store.svelte';
  import { recentIds } from '../../commands/recent.svelte';
  import { cancelPick, env, pick, runCommand, startPick, ui, type PickSlot } from '../shell.svelte';
  import { orderLine } from '../words';
  import { slotFor, token } from '../verbs';
  import { orderingUnits } from '../compose';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import ViewHead from './ViewHead.svelte';
  import Manage from './Manage.svelte';
  import PeekMore from './PeekMore.svelte';
  import OrderFrom from './OrderFrom.svelte';
  import { AREA_RINGS, ringLabel } from './place';
  import { echoes, findOf, open, selection, textOf } from './echo';

  const WORD: Record<string, string> = { obj: 'Objective', ea: 'Engagement area', nai: 'Named area of interest' };
  const SIZE_LABEL: Record<AreaSize, string> = { small: 'Small', medium: 'Medium', large: 'Large', xl: 'XL' };
  const ORDER_TAG: Record<Order['type'], string> = { attack: 'ATK', axis: 'AXIS', move: 'MOVING', advance: 'ADV', link: 'LINK', support: 'SPT', withdraw: 'WDR' };
  const K = 'area';
  let { doc, measure: m, now, onfocus }: { doc: Doc; measure: ControlMeasure; now: Date; onfocus: (id: string) => void } = $props();

  const type = $derived(m.type.toUpperCase());
  const ref = $derived(/[\s",\\]/.test(m.name) ? JSON.stringify(m.name) : m.name);
  const joinHint = $derived(`/${m.type} join ${ref} ‹unit›…`);
  const mc = (args: Record<string, unknown>): Command => ({ verb: m.type, args: { measure: m.id, ...args } });
  const line = (args: Record<string, unknown>) => textOf(mc(args), doc);
  const slot = (form: string) => slotFor(m.type, form, 'area');
  const sector = $derived(doc.sectors.find(s => s.id === m.sectorId));
  const ring = $derived<Ring | null>(m.pos ? ringForRadius(m.pos.r) : null);
  const size = $derived(areaSizeName(m.size));
  const members = $derived((m.members ?? []).map(id => doc.units.find(u => u.id === id)).filter((u): u is Unit => u !== undefined));
  const targeting = $derived(doc.orders.filter(o => o.to === m.id));
  const history = $derived(doc.log.filter(l => l.text.toUpperCase().includes(`${type} ${m.name.toUpperCase()}`)).slice(-8).reverse());
  const desig = (id: string) => doc.units.find(u => u.id === id)?.designation ?? id;
  const status = $derived([
    `${members.length} member${members.length === 1 ? '' : 's'}`, SIZE_LABEL[size],
    ...targeting.slice(0, 2).map(o => `${ORDER_TAG[o.type]} ← ${desig(o.from)}`), targeting.length > 2 ? `+${targeting.length - 2}` : '',
  ].filter(Boolean).join(' · '));

  // ----- + Order onto… -----
  /** The order the area's primary action starts: an attack onto an objective, a move onto any other area. */
  const orderVerb = $derived(m.type === 'obj' ? 'attack' : 'moving');
  const targetText = $derived(`${type} ${token(m.name)}`);
  const orderSlots = $derived<PickSlot[]>([
    { text: `/${orderVerb}`, state: 'filled' }, { text: '‹unit›', state: 'active' }, { text: `${orderVerb === 'moving' ? 'to ' : ''}${targetText}`, state: 'filled' },
  ]);
  const orderText = $derived(orderSlots.map(s => s.text).join(' '));
  /** + Order onto…: first the unit that gets the order (a list, or ⌖ Map), then its composer with this area as the target. */
  let ordering = $state(false);
  const orderFrom = $derived(ordering ? orderingUnits(orderVerb, doc, recentIds(doc), targetText) : []);
  function orderOnto() {
    ordering = !ordering;
    // Phone: open the sheet to full so the list has room (its picker scrolls it into view).
    if (ordering && env.tier === 'phone' && !env.landscape) ui.sheet = 'full';
  }
  function orderFor(unit: string) { ordering = false; ui.compose = { unit, verb: orderVerb, target: m.id }; }

  // ----- Place -----
  function rename(value: string) {
    const name = value.trim();
    if (name && name.toUpperCase() !== m.name.toUpperCase()) runCommand(mc({ action: 'rename', name }));
  }
  const moveArgs = (sectorId: string, r: Ring) => (sectorId === m.sectorId ? { action: 'move', ring: r } : { action: 'move', sectorId, ring: r });
  function place(sectorId: string, r: Ring) { runCommand(mc(moveArgs(sectorId, r))); }
  const placeRing = $derived<Ring>(ring && ring !== 'beyond' ? ring : 'near');
  const live = $derived(doc.units.filter(u => !isArchived(u, now, doc.lastTurn) && u.lifecycle !== 'dropped'));
  /** Units to move near or join: this area's sector first, then by designation. */
  const ranked = $derived([...live].sort((a, b) => Number(b.sectorId === m.sectorId) - Number(a.sectorId === m.sectorId) || a.designation.localeCompare(b.designation)));
  let nearId = $state('');
  let nearEl: HTMLSelectElement | undefined = $state();
  $effect(() => { void m.id; nearId = ''; ordering = false; });
  const nearText = $derived(line({ action: 'move', nearUnit: nearId || members[0]?.id || ranked[0]?.id }));

  // ----- Members: join and leave several at once -----
  let joining = $state(false);
  let joinPick = $state<string[]>([]);
  let leavePick = $state<string[]>([]);
  let filter = $state('');
  $effect(() => { void m.id; joining = false; joinPick = []; leavePick = []; filter = ''; });
  // A member that left (or a candidate that joined) drops out of its pick.
  const leaveSel = $derived(leavePick.filter(id => (m.members ?? []).includes(id)));
  const joinSel = $derived(joinPick.filter(id => !(m.members ?? []).includes(id)));
  const candidates = $derived(ranked.filter(u => !(m.members ?? []).includes(u.id) && (!filter.trim() || `${u.designation} ${u.title}`.toLowerCase().includes(filter.trim().toLowerCase()))));
  const joinCmd = $derived(joinSel.length ? mc({ action: 'join', units: joinSel }) : null);
  const leaveCmd = $derived(leaveSel.length ? mc({ action: 'leave', units: leaveSel }) : null);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  function addUnits() {
    joining = true;
    // Phone: open the sheet to full first, so Members and its list have room. The filter is not focused there:
    // the keyboard would cover the list of units to tick.
    const phone = env.tier === 'phone' && !env.landscape;
    if (phone) ui.sheet = 'full';
    // Open Members and scroll to it (also when it is already the anchor), once the sheet has grown.
    selection.section = null;
    queueMicrotask(() => { selection.section = 'members'; });
    if (phone) setTimeout(() => { selection.section = null; queueMicrotask(() => { selection.section = 'members'; }); }, 240);
  }
  function join() { if (joinCmd && runCommand(joinCmd).ok) { joinPick = []; joining = false; } }
  let filterEl: HTMLInputElement | undefined = $state();

  // ----- ⌖ Map for Near and Join: one unit per pick -----
  /** Which of this view's map picks is running. */
  let mapping = $state<'near' | 'join' | null>(null);
  const mapOn = (what: 'near' | 'join') => mapping === what && pick.current !== null;
  onDestroy(() => { if (mapping) cancelPick(); });
  const unitSel = (sel: Sel) => (sel.kind === 'unit' ? sel.id : null);
  function mapNear() {
    if (mapOn('near')) { cancelPick(); return; }
    mapping = 'near';
    startPick({
      label: 'Pick the unit to move near',
      accept: sel => ranked.some(u => u.id === unitSel(sel)),
      slots: [{ text: `/${m.type} move`, state: 'filled' }, { text: ref, state: 'filled' }, { text: 'near ‹unit›', state: 'active' }],
      onpick: sel => { mapping = null; nearId = unitSel(sel) ?? ''; nearEl?.focus(); },
      onlist: () => { mapping = null; nearEl?.focus(); },
      oncancel: () => { mapping = null; },
    });
  }
  function mapJoin() {
    if (mapOn('join')) { cancelPick(); return; }
    mapping = 'join';
    const picked = joinSel.map(desig);
    startPick({
      label: 'Pick a unit to join',
      accept: sel => ranked.some(u => u.id === unitSel(sel) && !(m.members ?? []).includes(u.id) && !joinSel.includes(u.id)),
      slots: [{ text: `/${m.type} join`, state: 'filled' }, { text: ref, state: 'filled' }, ...picked.map(text => ({ text, state: 'filled' as const })), { text: '‹unit›…', state: 'active' }],
      onpick: sel => { mapping = null; const id = unitSel(sel); if (id && !joinPick.includes(id)) joinPick = [...joinPick, id]; filterEl?.focus(); },
      onlist: () => { mapping = null; filterEl?.focus(); },
      oncancel: () => { mapping = null; },
    });
  }

  // ----- The area card's shortcuts (ui.areaFlow) -----
  $effect(() => {
    const f = ui.areaFlow;
    if (!f || f.measure !== m.id) return;
    untrack(() => {
      ui.areaFlow = null;
      if (f.flow === 'order') { ordering = false; orderOnto(); }
      else if (f.flow === 'join') addUnits();
      else {
        selection.section = null;
        queueMicrotask(() => { selection.section = 'place'; void tick().then(() => nearEl?.focus({ preventScroll: true })); });
      }
    });
  });

  const impact = $derived.by(() => {
    if (!targeting.length) return null;
    const lines = targeting.map(o => `${desig(o.from)}: ${orderLine(doc, o, o.from, now).text}`);
    return `It drops ${targeting.length} order${targeting.length === 1 ? '' : 's'} on it: ${lines.join('; ')}.${members.length ? ` Its ${members.length} unit${members.length === 1 ? '' : 's'} stay where they are.` : ''}`;
  });
</script>

<ViewHead glyph={type} kind="area" name={m.name} find={textOf({ verb: 'find', args: { measure: m.id } }, doc)}
  sub="{WORD[m.type]} · {sector?.name ?? '—'} · {ringLabel(ring)}" {status} />

<div class="actions">
  <button class="btn primary" data-testid="measure-order" aria-expanded={ordering} title="Give an order onto {type} {m.name}: {orderText}" use:echoes={orderText} onclick={orderOnto}>+ Order onto…</button>
  <button class="btn" data-testid="measure-add-members" aria-expanded={joining} title="Add units: /{m.type} join {ref} ‹unit›…" use:echoes={`/${m.type} join ${ref} ‹unit›…`} onclick={addUnits}>+ Add units…</button>
  <PeekMore />
</div>
{#if ordering}
  <OrderFrom options={orderFrom} title="Order onto {type} {m.name}" command={orderText} slots={orderSlots} onchoose={orderFor} onclose={() => (ordering = false)} />
{/if}

<Section kind={K} key="place" title="Place" summary="{sector?.name ?? '—'} · {ringLabel(ring)} · {SIZE_LABEL[size]}">
  <Field label="Name" entry={slot('rename')} cmd={line({ action: 'rename', name: m.name })}>
    <input class="field mono" value={m.name} onchange={(e) => rename(e.currentTarget.value)} aria-label="Name" data-testid="measure-name" />
  </Field>
  <Field label="Sector" entry={slot('move')} code="/{m.type} move … to" cmd={line({ action: 'move', sectorId: m.sectorId, ring: placeRing })}>
    <select class="field" value={m.sectorId} onchange={(e) => place(e.currentTarget.value, placeRing)} aria-label="Sector" data-testid="measure-sector">
      {#each doc.sectors as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
    </select>
    {#if sector}<button class="link field-link" title={findOf({ kind: 'sector', id: sector.id }, doc)} onclick={() => open({ kind: 'sector', id: sector.id })}>Open sector {sector.name}</button>{/if}
  </Field>
  <Field label="Ring" entry={slot('move')} cmd={line({ action: 'move', ring: placeRing })}>
    <select class="field" value={placeRing} onchange={(e) => place(m.sectorId ?? '', e.currentTarget.value as Ring)} aria-label="Ring" data-testid="measure-place">
      {#each AREA_RINGS as r (r.key)}<option value={r.key}>{r.label} · {r.horizon}</option>{/each}
    </select>
  </Field>
  <Field label="Near" wide entry={slot('near')} cmd={nearText}>
    <div class="pair">
      <select class="field" bind:value={nearId} bind:this={nearEl} aria-label="Move near a unit" data-testid="measure-near">
        <option value="">Choose a unit…</option>
        {#each ranked as u (u.id)}<option value={u.id}>{u.designation} · {u.title}</option>{/each}
      </select>
      <button class="btn map" type="button" class:on={mapOn('near')} aria-pressed={mapOn('near')} data-testid="measure-near-map"
        title="Pick the unit on the map (Tab cycles, Enter picks, Esc cancels)" onclick={mapNear}><span aria-hidden="true">⌖</span> Map</button>
      <button class="btn" type="button" disabled={!nearId} title={nearText ?? undefined} use:echoes={nearId ? nearText : null}
        onclick={() => { if (nearId && runCommand(mc({ action: 'move', nearUnit: nearId })).ok) nearId = ''; }}>Move</button>
    </div>
  </Field>
  <Field label="Min. size" wide entry={slot('size')} cmd={line({ action: 'size', size })}>
    <div class="seg" role="radiogroup" aria-label="Minimum size" data-testid="measure-size">
      {#each Object.keys(AREA_SIZES) as AreaSize[] as k (k)}
        {@const t = line({ action: 'size', size: k })}
        <button class="btn" type="button" role="radio" aria-checked={size === k} class:on={size === k} data-size={k} title={t} use:echoes={t}
          onclick={() => { if (size !== k) runCommand(mc({ action: 'size', size: k })); }}>{SIZE_LABEL[k]}</button>
      {/each}
    </div>
  </Field>
</Section>

<Section kind={K} key="members" title="Members" count={members.length} summary={members.map(u => u.designation).join(', ') || 'empty'}>
  <div data-testid="area-members">
    {#each members as u (u.id)}
      {@const leave = line({ action: 'leave', units: [u.id] })}
      <div class="row">
        <input type="checkbox" class="pick" checked={leavePick.includes(u.id)} onchange={() => (leavePick = toggle(leavePick, u.id))} aria-label="Select {u.designation}" />
        <button class="link" title={findOf({ kind: 'unit', id: u.id }, doc)} onclick={() => open({ kind: 'unit', id: u.id }, onfocus)}>{u.designation}</button>
        <span class="muted">{u.title}</span>
        <button class="x" aria-label="Leave: {u.designation}" title={leave} use:echoes={leave} onclick={() => runCommand(mc({ action: 'leave', units: [u.id] }))}>✕</button>
      </div>
    {:else}
      <p class="muted">Empty. Join units below, or drop a unit inside on the map.</p>
    {/each}
  </div>
  <div class="member-actions">
    {#if members.length}
      {@const t = leaveCmd ? textOf(leaveCmd, doc) : `/${m.type} leave ${ref} ‹unit›…`}
      <button class="btn" type="button" data-testid="measure-leave" disabled={!leaveCmd} title={t} use:echoes={t} onclick={() => { if (leaveCmd && runCommand(leaveCmd).ok) leavePick = []; }}>Leave selected ({leaveSel.length})</button>
    {/if}
    <button class="btn" type="button" data-testid="measure-join-open" aria-expanded={joining} title={joinHint} use:echoes={joinHint} onclick={() => (joining = !joining)}>{joining ? 'Close list' : 'Join units…'}</button>
  </div>
  {#if joining}
    {@const t = joinCmd ? textOf(joinCmd, doc) : `/${m.type} join ${ref} ‹unit›…`}
    <div class="join" data-testid="measure-join-list">
      <div class="pair">
        <input class="field" type="search" bind:value={filter} bind:this={filterEl} placeholder="Filter units" aria-label="Filter units" />
        <button class="btn map" type="button" class:on={mapOn('join')} aria-pressed={mapOn('join')} data-testid="measure-join-map"
          title="Pick a unit on the map: each pick adds one (Tab cycles, Enter picks, Esc cancels)" onclick={mapJoin}><span aria-hidden="true">⌖</span> Map</button>
      </div>
      <div class="cands" role="group" aria-label="Units to join {type} {m.name}">
        {#each candidates as u (u.id)}
          <label class="cand">
            <input type="checkbox" checked={joinPick.includes(u.id)} onchange={() => (joinPick = toggle(joinPick, u.id))} />
            <span class="des">{u.designation}</span><span class="muted">{u.title}</span>
            {#if u.sectorId !== m.sectorId}<span class="other">{doc.sectors.find(s => s.id === u.sectorId)?.name}</span>{/if}
          </label>
        {:else}
          <p class="muted">No other units{filter.trim() ? ' match' : ''}.</p>
        {/each}
      </div>
      <code class="preview">› {t}</code>
      <button class="btn primary" type="button" data-testid="measure-join" disabled={!joinCmd} title={t} use:echoes={t} onclick={join}>Join ({joinSel.length})</button>
    </div>
  {/if}
</Section>

<Section kind={K} key="targeted" title="Targeted by" count={targeting.length} summary={targeting.length ? targeting.map(o => `${ORDER_TAG[o.type]} ← ${desig(o.from)}`).join(', ') : 'nothing'}>
  {#each targeting as o (o.id)}
    {@const from = doc.units.find(u => u.id === o.from)}
    {@const l = orderLine(doc, o, o.from, now)}
    {@const halt = textOf({ verb: 'halt', args: { unit: o.from, order: o.id } }, doc)}
    <div class="row">
      <button class="link" title={findOf({ kind: 'unit', id: o.from }, doc)} onclick={() => open({ kind: 'unit', id: o.from }, onfocus)}>{from?.designation ?? o.from}</button>
      <span class="muted">{l.text}</span>
      <button class="x" aria-label="Cancel order: {from?.designation} {l.text}" title={halt ?? '/halt'} use:echoes={halt} data-testid="cancel-order"
        onclick={() => runCommand({ verb: 'halt', args: { unit: o.from, order: o.id } })}>✕</button>
    </div>
  {:else}
    <p class="muted">No order aims at {type} {m.name}.</p>
  {/each}
</Section>

<Section kind={K} key="history" title="History" count={history.length} open={false}>
  {#each history as h (h.id)}<div class="hist"><span class="muted">{formatDtg(h.at).slice(0, 6)}</span> {h.text}</div>{:else}<p class="muted">No log entries.</p>{/each}
</Section>

<Manage {doc} label="Remove {WORD[m.type].toLowerCase()}…" cmd={mc({ action: 'remove' })} {impact} />

<style>
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-bottom: var(--s2); }
  .actions .btn { flex: 1 1 0; min-width: max-content; justify-content: center; padding: 0 6px; letter-spacing: 0.06em; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .btn.primary:disabled { opacity: 0.45; }
  .row { display: flex; align-items: center; gap: var(--s2); padding: 3px 0; border-bottom: 1px dotted var(--rule); font-size: 12px; }
  .row .muted { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick { flex: none; margin: 0; }
  .x { flex: none; width: 24px; height: 24px; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .x:hover { color: var(--hostile); border-color: var(--hostile); }
  :global([data-tier='phone']) .x { width: 44px; height: 44px; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: 700 12px/1.4 var(--font-mono); text-align: left; }
  .field-link { display: block; margin-top: 2px; font: 400 12px/1.4 var(--font-cond); }
  .muted { color: var(--ink-3); font-size: 12px; margin: 2px 0; }
  .mono { font-family: var(--font-mono); }
  .pair { display: flex; gap: var(--s1); }
  .pair .field { flex: 1; min-width: 0; }
  .pair .map { flex: none; padding: 0 6px; letter-spacing: 0.06em; }
  .seg { display: flex; }
  .seg .btn { flex: 1; justify-content: center; padding: 0 2px; }
  .seg .btn + .btn { margin-left: -1px; }
  .member-actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-top: var(--s1); }
  .join { display: flex; flex-direction: column; gap: var(--s1); margin-top: var(--s2); padding: var(--s2); border: 1px solid var(--rule); }
  .cands { max-height: 200px; overflow-y: auto; overscroll-behavior: contain; }
  .cand { display: flex; align-items: center; gap: var(--s2); padding: 2px 0; border-bottom: 1px dotted var(--rule); font-size: 12px; }
  :global([data-tier='phone']) .cand { min-height: 44px; }
  .cand .des { font: 700 12px/1.4 var(--font-mono); }
  .cand .muted { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cand .other { flex: none; font-size: 11px; color: var(--ink-3); }
  .preview { font: 400 11px/1.4 var(--font-mono); color: var(--ink-2); overflow-wrap: anywhere; }
  .hist { font-size: 12px; padding: 2px 0; color: var(--ink-2); }
</style>
