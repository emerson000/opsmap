<script lang="ts">
  // A unit's staff record: header, one constructive primary, then Identity, Place & time, Condition,
  // Task organization, Orders (with the order composer), Vikunja and History. Every control runs its
  // command-bar text (runCommand); pickers choose the second unit from a list or on the map.
  import type { Command, Doc, Ring, Unit } from '../../../core/model/types';
  import { ECHELONS } from '../../../core/model/echelon';
  import { FUNCTIONS } from '../../../core/model/functions';
  import { formatDtg, toSidc } from '../../../core/model/sidc';
  import { effectiveCondition } from '../../../core/model/derive';
  import { parseDate } from '../../../core/commands/tokenize';
  import { suggest } from '../../../core/commands/suggest';
  import { unresolved } from '../../../core/commands/resolve';
  import { recentIds } from '../../commands/recent.svelte';
  import { miniSymbol } from '../mini';
  import { annotate, initials, color, nameOf } from '../../sync/sync.svelte';
  import { features } from '../../model/features.svelte';
  import { env, runCommand, toast, ui, type Theme } from '../shell.svelte';
  import { AFFILIATIONS, AFF_LABEL, CONDITIONS, LIFECYCLE_LABEL, RINGS, band, dayMonth, echelonRange, orderLine, ringOf, unitLabel } from '../words';
  import { slotFor, token } from '../verbs';
  import { unitOption, type Option } from '../compose';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import Picker from './Picker.svelte';
  import Composer from './Composer.svelte';
  import PeekMore from './PeekMore.svelte';
  import { echoes, findOf, open, textOf } from './echo';

  const TRIAGE_IDS = [
    { key: 'friend', label: 'Friend', hint: 'My own effort or asset' },
    { key: 'hostile', label: 'Hostile', hint: 'A confirmed problem' },
    { key: 'suspect', label: 'Suspect', hint: 'Probably a problem (a risk)' },
    { key: 'neutral', label: 'Neutral', hint: 'Outside party or constraint' },
  ];
  const TRIAGE_SIZES = ECHELONS.filter(e => ['tm', 'sqd', 'plt', 'coy', 'bn'].includes(e.key));
  const CP_TYPES = [
    { key: 'main', label: 'main command post' }, { key: 'tac', label: 'tactical, forward' },
    { key: 'alt', label: 'alternate, backup' }, { key: 'rear', label: 'rear, support' },
  ] as const;
  const K = 'unit';

  let { doc, unit, now, theme, onfocus }: { doc: Doc; unit: Unit; now: Date; theme: Theme; onfocus: (id: string) => void } = $props();

  const cmd = (verb: string, args: Record<string, unknown> = {}): Command => ({ verb, args: { unit: unit.id, ...args } });
  /** The command-bar text of this unit's command. */
  const line = (verb: string, args: Record<string, unknown> = {}) => textOf(cmd(verb, args), doc);
  const run = (verb: string, args: Record<string, unknown> = {}) => runCommand(cmd(verb, args));
  const slot = (verb: string, form?: string) => slotFor(verb, form, 'unit');

  // Identity changes on a person need an explicit confirm.
  let confirmHostile = $state(false);
  function setIdentity(affiliation: string) {
    const res = runCommand(cmd('id', { affiliation, confirm: false }), true);
    if (res.ok) { confirmHostile = false; return; }
    if (/person hostile/i.test(res.error)) confirmHostile = true; else toast(res.error);
  }

  function dateInput(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function setDue(value: string) {
    if (!value) { run('due', { dueAt: null }); return; }
    try { run('due', { dueAt: parseDate(value, new Date(), doc.settings.tz) }); } catch (e) { toast(e instanceof Error ? e.message : 'Invalid date'); }
  }
  function setStrength(value: string) {
    if (value.trim() === '') return;
    const n = Number(value);
    if (!Number.isFinite(n)) { toast('Strength must be a number from 0 to 100'); return; }
    run('bda', { strength: n });
  }
  function setTitle(value: string) { if (value.trim() && value !== unit.title) run('rename', { title: value }); }
  function setDesignation(value: string) {
    const d = value.trim().toUpperCase();
    if (d && d !== unit.designation) run('rename', { title: unit.title, designation: d });
  }
  function setNote(value: string) { if (value !== (unit.note ?? '')) run('note', { note: value }); }
  function setRating(value: string) { if (value.trim() && value.toUpperCase() !== unit.rating) run('rate', { rating: value.trim() }); }
  function setPlace(sectorId: string, ring: Ring) { run('move', sectorId === unit.sectorId ? { ring } : { sectorId, ring }); }

  let blockReason = $state('');
  let blocking = $state(false);
  let dropping = $state(false);
  let sidcDraft = $state('');
  $effect(() => { void unit.id; blocking = false; dropping = false; blockReason = ''; confirmHostile = false; confirmFn = null; sidcDraft = ''; nearText = ''; attachText = ''; withText = ''; reduceNote = ''; });

  const history = $derived.by(() => {
    const re = new RegExp(`(^|[^A-Z0-9_-])${unit.designation.replace(/-/g, '\\-')}([^A-Z0-9_-]|$)`);
    return doc.log.filter(l => re.test(l.text.toUpperCase())).slice(-8).reverse();
  });
  const orders = $derived(doc.orders.filter(o => o.from === unit.id || o.to === unit.id));
  const parent = $derived(unit.parentId ? doc.units.find(u => u.id === unit.parentId) : undefined);
  const members = $derived(doc.units.filter(u => u.parentId === unit.id));
  const areas = $derived(doc.measures.filter(m => m.type !== 'pl'));
  const area = $derived(areas.find(m => m.members?.includes(unit.id)));
  /** Join the chosen area (the unit moves inside it), or leave the current one. */
  function areaCmd(id: string): Command | null {
    const target = areas.find(m => m.id === id);
    if (target) return { verb: target.type, args: { action: 'join', measure: target.id, units: [unit.id] } };
    if (area) return { verb: area.type, args: { action: 'leave', measure: area.id, units: [unit.id] } };
    return null;
  }
  function setArea(id: string) { const c = areaCmd(id); if (c) runCommand(c); }
  const cond = $derived(effectiveCondition(unit));
  const k = $derived(band(unit.strength));
  const resolved = $derived(unit.lifecycle === 'done' || unit.lifecycle === 'dropped');
  const threat = $derived(unit.affiliation === 'hostile' || unit.affiliation === 'suspect');
  const friendly = $derived(unit.affiliation === 'friend' || unit.affiliation === 'assumed');
  const sectorName = (id: string) => doc.sectors.find(s => s.id === id)?.name ?? id;
  const sym = $derived(miniSymbol(unit, theme, 24));
  const ringWord = $derived(RINGS.find(r => r.key === ringOf(unit))?.label ?? '');

  /** Phone sheet at peek: one filled and one outlined action, then More, as in the other views. */
  const peek = $derived(env.tier === 'phone' && !env.landscape && ui.sheet === 'peek');
  /** + Order opens the order composer in the Orders section. */
  const composing = $derived(ui.compose?.unit === unit.id ? ui.compose : null);
  const orderText = $derived(threat ? `/advancing ${token(unit.designation)} on ‹target›` : friendly ? `/attack ${token(unit.designation)} ‹target›` : `/moving ${token(unit.designation)} to ‹target›`);
  function compose() { ui.compose = { unit: unit.id }; }
  const findText = $derived(line('find'));

  // Function changes on a person need an explicit confirm, as identity does.
  let confirmFn = $state<string | null>(null);
  function setFunction(fn: string) {
    const res = runCommand(cmd('fn', { fn, confirm: false }), true);
    if (res.ok) { confirmFn = null; return; }
    if (/confirm/i.test(res.error)) confirmFn = fn; else toast(res.error);
  }

  /** Other units, ranked as the command bar suggests them after `prefix`, without this one. */
  function unitChoices(prefix: string, filter: (u: Unit) => boolean = () => true): Option[] {
    const out: Option[] = [];
    for (const s of suggest(prefix, prefix.length, doc, { recent: recentIds(doc) }).items) {
      const u = s.kind === 'unit' ? doc.units.find(x => x.id === s.unitId) : undefined;
      if (u && u.id !== unit.id && filter(u) && !out.some(o => o.key === `u:${u.id}`)) out.push(unitOption(u, doc));
    }
    return out;
  }
  const D = $derived(token(unit.designation));
  const nearChoices = $derived(unitChoices(`/move ${D} near `));
  const descendants = $derived.by(() => {
    const out = new Set<string>([unit.id]);
    for (let grew = true; grew;) { grew = false; for (const u of doc.units) if (u.parentId && out.has(u.parentId) && !out.has(u.id)) { out.add(u.id); grew = true; } }
    return out;
  });
  /** Task forces first (the bar's suggestions), then any other open unit that is not attached under this one. */
  const attachChoices = $derived.by(() => {
    const tfs = unitChoices(`/attach ${D} to `, u => !descendants.has(u.id));
    for (const u of doc.units) if (unresolved(u) && !descendants.has(u.id) && u.id !== unit.parentId && !tfs.some(o => o.key === `u:${u.id}`)) tfs.push(unitOption(u, doc));
    return tfs.filter(o => o.key !== `u:${unit.parentId}`);
  });
  const withChoices = $derived(unitChoices(`/reinforce ${D} with `, u => !descendants.has(u.id) && u.parentId !== unit.id));
  let nearText = $state(''), attachText = $state(''), withText = $state('');
  let reduceNote = $state('');
  const idOf = (o: Option) => o.key.slice(2);
  /** Halt by kind: the kinds of this unit's own orders. */
  const outKinds = $derived([...new Set(doc.orders.filter(o => o.from === unit.id).map(o => o.type))]);
  function find() { runCommand(cmd('find')); }
  const summaries = $derived({
    identity: `${AFFILIATIONS.find(a => a.key === unit.affiliation)?.label ?? ''} · ${unit.fn} · ${unit.echelon ?? '—'}${unit.cp ? ` · ${unit.cp.toUpperCase()} CP` : ''}`,
    place: `${sectorName(unit.sectorId)} · ${ringWord}${unit.dueAt ? ` · ${dayMonth(unit.dueAt)}` : ''}${area ? ` · ${area.type.toUpperCase()} ${area.name}` : ''}`,
    condition: `${CONDITIONS.find(c => c.key === unit.condition)?.label ?? ''}${unit.strength !== undefined ? ` · ${unit.strength}%` : ''}${unit.rating ? ` · ${unit.rating}` : ''}`,
    taskorg: parent ? `in TF ${parent.designation}` : members.length ? `TF of ${members.length}` : 'not attached',
  });
</script>

<header class="head">
  <button class="sym" type="button" onclick={find} title="Find on map: {findText} (F)" aria-label="Find {unit.designation} on the map" use:echoes={findText}>
    <img src={sym.href} alt="" width={sym.width} height={sym.height} />
  </button>
  <div class="who">
    <div class="desig">{unit.designation}</div>
    <div class="ttl">{unit.title}</div>
    <div class="sub">{AFF_LABEL[unit.affiliation]}{unit.cp ? ` · ${unit.cp.toUpperCase()} CP` : unit.fn === 'hq' ? ' · HQ' : ''} · {unit.presence === 'planned' ? 'planned (dashed)' : 'present'} · {LIFECYCLE_LABEL[unit.lifecycle]}</div>
    {#if unit.vk && features.vikunja}<a class="vk-link" data-testid="vk-link" href="{features.vikunja.url}/tasks/{unit.vk}" target="_blank" rel="noopener noreferrer">Vikunja task #{unit.vk} ↗</a>{/if}
  </div>
</header>

<div class="actions" data-testid="unit-actions">
  {#if resolved}
    {@const t = line('reopen')}
    <button class="btn primary" data-testid="unit-reopen" title={t} use:echoes={t} onclick={() => run('reopen')}>Reopen</button>
    <span class="hint">{unit.lifecycle === 'done' ? 'Completed' : 'Archived'} {formatDtg(unit.updatedAt)}.</span>
  {:else}
    <button class="btn primary" data-testid="unit-order" title="Give an order: {orderText} (N)" aria-expanded={composing !== null} use:echoes={orderText} onclick={compose}>+ Order</button>
    {#if threat}
      {@const t = line('done')}
      <button class="btn" data-testid="unit-done" title="Destroyed (X): {t}" use:echoes={t} onclick={() => run('done')}>Destroyed</button>
    {:else}
      {@const t = line('done')}
      <button class="btn" data-testid="unit-done" title="Complete: fully capable today, then withdraws to HQ ({t})" use:echoes={t} onclick={() => run('done')}>Done</button>
      {#if peek}<!-- Block and Drop: under More -->
      {:else if unit.lifecycle === 'blocked'}
        {@const u = line('unblock')}
        <button class="btn" data-testid="unit-unblock" title={u} use:echoes={u} onclick={() => run('unblock')}>Unblock</button>
      {:else}
        <button class="btn" data-testid="unit-block" aria-expanded={blocking} class:on={blocking} title="{line('block')} by &quot;‹reason›&quot;" use:echoes={line('block')} onclick={() => { blocking = !blocking; dropping = false; }}>Block…</button>
      {/if}
    {/if}
    {#if !peek}
      <button class="btn" data-testid="unit-drop" aria-expanded={dropping} class:on={dropping} title="{line('drop', { bypassed: false })} [bypassed]" use:echoes={line('drop', { bypassed: threat })} onclick={() => { dropping = !dropping; blocking = false; }}>Drop…</button>
    {/if}
  {/if}
  <PeekMore />
</div>
{#if dropping && !resolved}
  {@const plain = line('drop', { bypassed: false })}
  {@const bypassed = line('drop', { bypassed: true })}
  <div class="choice" role="group" aria-label="Drop {unit.designation}">
    <p>{threat ? `Drop ${unit.designation}: did it go away by itself (bypassed), or drop it from the map?` : `Drop ${unit.designation}: withdraw and archive it, or did it go away by itself (bypassed)?`}</p>
    <div class="row">
      <button class="btn" title={plain} use:echoes={plain} onclick={() => { dropping = false; run('drop', { bypassed: false }); }}>Drop</button>
      <button class="btn" title={bypassed} use:echoes={bypassed} onclick={() => { dropping = false; run('drop', { bypassed: true }); }}>Bypassed</button>
      <button class="btn" onclick={() => (dropping = false)}>Keep</button>
    </div>
  </div>
{/if}
{#if !resolved && (unit.affiliation === 'pending' || unit.affiliation === 'unknown')}
  <!-- Triage in two taps: what is it, and how much effort. -->
  <div class="triage" role="group" aria-label="Identify" data-testid="triage-identity">
    <span class="tri-label">What is it?</span>
    {#each TRIAGE_IDS as t (t.key)}<button class="btn chip-btn {t.key}" title="{t.hint}: {line('id', { affiliation: t.key, confirm: false })}" use:echoes={line('id', { affiliation: t.key, confirm: false })} onclick={() => setIdentity(t.key)}>{t.label}</button>{/each}
  </div>
  <div class="triage" role="group" aria-label="Effort" data-testid="triage-effort">
    <span class="tri-label">Effort</span>
    {#each TRIAGE_SIZES as e (e.key)}<button class="btn chip-btn" class:on={unit.echelon === e.key} title="{e.key} · {e.range}" aria-pressed={unit.echelon === e.key} use:echoes={line('size', { echelon: e.key })} onclick={() => run('size', { echelon: e.key })}>{e.range}</button>{/each}
  </div>
{/if}
{#if blocking}
  <form class="inline" onsubmit={(e) => { e.preventDefault(); run('block', blockReason.trim() ? { note: blockReason.trim() } : {}); blocking = false; }}
    use:echoes={line('block', blockReason.trim() ? { note: blockReason.trim() } : {})}>
    <input class="field" placeholder="Blocked by… (goes in G)" bind:value={blockReason} aria-label="Block reason" />
    <button class="btn" type="submit">Set</button>
  </form>
{/if}

<Section kind={K} key="identity" title="Identity" summary={summaries.identity}>
  <Field label="Designation" tag="T" entry={slot('rename')} cmd={line('rename', { title: unit.title, designation: unit.designation })}>
    <input class="field mono" value={unit.designation} onchange={(e) => setDesignation(e.currentTarget.value)} aria-label="Designation" />
  </Field>
  <Field label="Title" tag="H" entry={slot('rename')} cmd={line('rename', { title: unit.title })}>
    <input class="field" value={unit.title} onchange={(e) => setTitle(e.currentTarget.value)} aria-label="Title" />
  </Field>
  <Field label="Identity (frame)" entry={slot('id')} cmd={line('id', { affiliation: unit.affiliation, confirm: false })}>
    <select class="field" value={unit.affiliation} onchange={(e) => setIdentity(e.currentTarget.value)} aria-label="Identity">
      {#each AFFILIATIONS as a (a.key)}<option value={a.key}>{a.label} — {a.meaning}</option>{/each}
    </select>
    {#if confirmHostile}
      {@const t = line('id', { affiliation: 'hostile', confirm: true })}
      <div class="confirm" role="alertdialog" aria-label="Mark a person hostile">
        Mark a person hostile? The problem is usually the situation, not the person.
        <button class="btn warn" data-testid="id-confirm" title={t} use:echoes={t} onclick={() => { run('id', { affiliation: 'hostile', confirm: true }); confirmHostile = false; }}>Mark hostile</button>
        <button class="btn" onclick={() => (confirmHostile = false)}>Keep</button>
      </div>
    {/if}
  </Field>
  <Field label="Function (icon)" entry={slot('fn')} cmd={line('fn', { fn: unit.fn, confirm: false })}>
    <select class="field" value={unit.fn} onchange={(e) => { const el = e.currentTarget; setFunction(el.value); el.value = unit.fn; }} aria-label="Function">
      {#each FUNCTIONS as f (f.key)}<option value={f.key}>{f.key} — {f.label}</option>{/each}
    </select>
    {#if confirmFn}
      {@const fn = confirmFn}
      {@const t = line('fn', { fn, confirm: true })}
      <div class="confirm" role="alertdialog" aria-label="Make a hostile a person">
        Make {unit.designation} a person while it is hostile? The problem is usually the situation, not the person.
        <button class="btn warn" data-testid="fn-confirm" title={t} use:echoes={t} onclick={() => { run('fn', { fn, confirm: true }); confirmFn = null; }}>Make it {fn}</button>
        <button class="btn" onclick={() => (confirmFn = null)}>Keep</button>
      </div>
    {/if}
  </Field>
  <Field label="Effort (echelon)" tag="B" entry={slot('size')} cmd={unit.echelon ? line('size', { echelon: unit.echelon }) : null}>
    <select class="field" value={unit.echelon ?? ''} onchange={(e) => run('size', { echelon: e.currentTarget.value })} aria-label="Echelon">
      {#if !unit.echelon}<option value="" disabled>Unknown effort</option>{/if}
      {#each ECHELONS as e (e.key)}<option value={e.key}>{e.mark} {e.key} · {e.range}</option>{/each}
    </select>
  </Field>
  <Field label="Command post" tag="AA" entry={slot('cp')} cmd={line('cp', { cp: unit.cp ?? null })}>
    <select class="field" value={unit.cp ?? ''} onchange={(e) => { const el = e.currentTarget; run('cp', { cp: el.value || null }); el.value = unit.cp ?? ''; }} aria-label="Command post" data-testid="unit-cp">
      <option value="">None</option>
      {#each CP_TYPES as c (c.key)}<option value={c.key}>{c.key.toUpperCase()} · {c.label}</option>{/each}
    </select>
  </Field>
  {@const sidcText = sidcDraft.trim().length === 20 ? line('sidc', { sidc: sidcDraft.trim() }) : null}
  <Field label="SIDC" entry={slot('sidc')} cmd={sidcText}>
    <code class="sidc" title="2525E 20-digit symbol identification code: {toSidc(unit)}">{toSidc(unit)}</code>
    {#if unit.sidcOverride}<span class="note">User override.</span>{/if}
    <form class="inline" onsubmit={(e) => { e.preventDefault(); if (sidcDraft.trim()) run('sidc', { sidc: sidcDraft.trim() }); }}>
      <input class="field mono" placeholder="Override: 20 digits" bind:value={sidcDraft} maxlength="20" aria-label="SIDC override" />
      <button class="btn" type="submit" disabled={sidcText === null} title={sidcText ?? `/sidc ${D} ‹20 digits›`} data-testid="unit-sidc-set">Set</button>
    </form>
  </Field>
</Section>

<Section kind={K} key="place" title="Place & time" summary={summaries.place}>
  <Field label="Sector" entry={slot('move')} code="/move … to" cmd={line('move', { sectorId: unit.sectorId, ring: ringOf(unit) })}>
    <select class="field" value={unit.sectorId} onchange={(e) => setPlace(e.currentTarget.value, ringOf(unit))} aria-label="Sector">
      {#each doc.sectors as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
    </select>
    <button class="link field-link" title={findOf({ kind: 'sector', id: unit.sectorId }, doc)} onclick={() => open({ kind: 'sector', id: unit.sectorId })}>Open sector {sectorName(unit.sectorId)}</button>
  </Field>
  <Field label="Ring" entry={slot('move')} cmd={line('move', { ring: ringOf(unit) })}>
    <select class="field" value={ringOf(unit)} onchange={(e) => setPlace(unit.sectorId, e.currentTarget.value as Ring)} aria-label="Ring">
      {#each RINGS as r (r.key)}<option value={r.key}>{r.label} · {r.horizon}</option>{/each}
    </select>
    {#if unit.posOverride}
      {@const t = line('unpin')}
      <span class="note">Pinned by hand: auto-advance skips it.</span>
      <button class="btn" data-testid="unpin" title="Return to the ring its due date gives ({t})" use:echoes={t} onclick={() => run('unpin')}>Unpin</button>
    {/if}
  </Field>
  {#if !resolved}
    <Field label="Near" entry={slot('move', 'near')} cmd={null}>
      <Picker items={nearChoices} bind:value={nearText} label="Move near a unit" placeholder="A unit…" testid="unit-near" mapTestid="unit-near-map" command={`/move ${D} near ‹unit›`}
        pickLabel="Pick a unit to move near" pickSlots={() => [{ text: `/move ${D} near`, state: 'filled' }, { text: '‹unit›', state: 'active' }]}
        onchoose={(o) => { nearText = ''; run('move', { nearUnit: idOf(o) }); }} />
    </Field>
  {/if}
  <Field label="Due (DTG)" tag="W" entry={slot('due')} cmd={line('due', { dueAt: unit.dueAt ?? null })}>
    <div class="pair">
      <input class="field" type="date" value={dateInput(unit.dueAt)} onchange={(e) => setDue(e.currentTarget.value)} aria-label="Due date" />
      <span class="dtg">{unit.dueAt ? formatDtg(unit.dueAt) : 'undated'}</span>
      {#if unit.dueAt}
        {@const t = line('due', { dueAt: null })}
        <button class="btn" data-testid="due-none" title="Clear the due date ({t})" use:echoes={t} onclick={() => run('due', { dueAt: null })}>None</button>
      {/if}
    </div>
  </Field>
  <Field label="Area (OBJ · EA · NAI)" code="/{area?.type ?? 'obj'} join" cmd={area ? textOf({ verb: area.type, args: { action: 'join', measure: area.id, units: [unit.id] } }, doc) : null}>
    <select class="field" value={area?.id ?? ''} onchange={(e) => { const el = e.currentTarget; setArea(el.value); el.value = area?.id ?? ''; }} aria-label="Area" data-testid="unit-area">
      <option value="">None</option>
      {#each areas as m (m.id)}<option value={m.id}>{m.type.toUpperCase()} {m.name}</option>{/each}
    </select>
    {#if area}<button class="link field-link" title={findOf({ kind: 'measure', id: area.id }, doc)} onclick={() => open({ kind: 'measure', id: area.id })}>Open {area.type.toUpperCase()} {area.name}</button>{/if}
  </Field>
  <Field label="Key terrain" entry={slot('key')} cmd={line('key')}>
    <label class="check"><input type="checkbox" checked={Boolean(unit.keyTerrain)} onchange={() => run('key')} /> Loss would be decisive</label>
  </Field>
</Section>

<Section kind={K} key="condition" title="Condition" summary={summaries.condition}>
  <Field label="Condition (status)" entry={slot('bda')} cmd={line('bda', { condition: unit.condition })}>
    <select class="field" value={unit.condition} onchange={(e) => run('bda', { condition: e.currentTarget.value })} aria-label="Condition">
      {#each CONDITIONS as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
    </select>
    {#if unit.condition === 'none' && cond !== 'none'}<span class="note">Derived from strength: {cond}.</span>{/if}
  </Field>
  <Field label="Strength" tag="K" entry={slot('bda')} cmd={unit.strength !== undefined ? line('bda', { strength: unit.strength }) : null}>
    <div class="pair">
      <input class="field num" type="number" min="0" max="100" step="5" value={unit.strength ?? ''} placeholder="—"
        onchange={(e) => setStrength(e.currentTarget.value)} aria-label="Strength percent" />
      {#if k}<span class="k k-{k}">{k.toUpperCase()} {unit.strength}%</span>{/if}
    </div>
    <span class="note">{threat ? 'Problem remaining. 0% destroys it.' : 'Capacity, for information only.'}</span>
  </Field>
  <Field label="Reinforce" tag="F" entry={slot('reinforce')} cmd={line('reinforce')}>
    <div class="pair">
      <span class="mono">{unit.reinforced ? `now (${unit.reinforced})` : 'now —'}</span>
      <button class="btn" data-testid="unit-reinforce" title={line('reinforce')} use:echoes={line('reinforce')} onclick={() => run('reinforce')}>(+)</button>
    </div>
    <Picker items={withChoices} bind:value={withText} label="Reinforce with a unit" placeholder="With a unit… (it attaches)" testid="reinforce-with" mapTestid="reinforce-with-map" command={`/reinforce ${D} with ‹unit›`}
      pickLabel="Pick the unit that reinforces" pickSlots={() => [{ text: `/reinforce ${D} with`, state: 'filled' }, { text: '‹unit›', state: 'active' }]}
      onchoose={(o) => { withText = ''; run('reinforce', { with: idOf(o) }); }} />
  </Field>
  <Field label="Reduce" entry={slot('reduce')} cmd={line('reduce', reduceNote.trim() ? { note: reduceNote.trim() } : {})}>
    <form class="pair" onsubmit={(e) => { e.preventDefault(); run('reduce', reduceNote.trim() ? { note: reduceNote.trim() } : {}); reduceNote = ''; }}>
      <input class="field" placeholder="Scope cut (goes in G)" bind:value={reduceNote} aria-label="Scope cut" data-testid="reduce-note" />
      <button class="btn" type="submit" data-testid="unit-reduce" title={line('reduce', reduceNote.trim() ? { note: reduceNote.trim() } : {})}>(−)</button>
    </form>
  </Field>
  <Field label="Rating (Admiralty)" tag="J" entry={slot('rate')} cmd={unit.rating ? line('rate', { rating: unit.rating }) : null}>
    <input class="field mono short" value={unit.rating ?? ''} placeholder="e.g. B2" maxlength="2" onchange={(e) => setRating(e.currentTarget.value)} aria-label="Evaluation rating" />
  </Field>
  <Field label="Staff comments" tag="G" entry={slot('note')} cmd={line('note', { note: unit.note ?? '' })}>
    <textarea class="field" rows="2" value={unit.note ?? ''} onchange={(e) => setNote(e.currentTarget.value)} aria-label="Staff comments"></textarea>
  </Field>
</Section>

<Section kind={K} key="taskorg" title="Task organization" summary={summaries.taskorg}>
  <Field label="Task force" tag="M" entry={parent ? slot('detach') : slot('attach')} cmd={parent ? line('detach') : null}>
    {#if parent}
      <span class="pair">Attached to <button class="link" title={findOf({ kind: 'unit', id: parent.id }, doc)} onclick={() => open({ kind: 'unit', id: parent.id }, onfocus)}>TF {parent.designation}</button>
        <button class="btn" data-testid="unit-detach" title={line('detach')} use:echoes={line('detach')} onclick={() => run('detach')}>Detach</button></span>
    {:else if !members.length}<span class="muted">Not attached</span>{/if}
    {#if !resolved}
      <Picker items={attachChoices} bind:value={attachText} label={parent ? 'Attach to another task force' : 'Attach to a task force'} placeholder={parent ? 'Move to another TF…' : 'Attach to a TF…'}
        testid="unit-attach" mapTestid="unit-attach-map" pickLabel="Pick a task force" command={`/attach ${D} to ‹task force›`}
        pickSlots={() => [{ text: `/attach ${D} to`, state: 'filled' }, { text: '‹task force›', state: 'active' }]}
        onchoose={(o) => { attachText = ''; run('attach', { parent: idOf(o) }); }} />
    {/if}
  </Field>
  {#if members.length}
    <Field label="TF members" entry={slot('detach')} cmd={null}>
      <ul class="members" data-testid="tf-members">
        {#each members as m (m.id)}
          {@const t = textOf({ verb: 'detach', args: { unit: m.id } }, doc)}
          <li><button class="link" title={findOf({ kind: 'unit', id: m.id }, doc)} onclick={() => open({ kind: 'unit', id: m.id }, onfocus)}>{m.designation}</button><span class="detail">{m.title}</span>
            <button class="x" aria-label="Detach: {m.designation}" title="Detach {m.designation} ({t})" use:echoes={t} onclick={() => runCommand({ verb: 'detach', args: { unit: m.id } })}>✕</button></li>
        {/each}
      </ul>
    </Field>
  {/if}
</Section>

<Section kind={K} key="orders" title="Orders" count={orders.length} summary={orders.length ? '' : 'none'} force={composing !== null}>
  {#each orders as o (o.id)}
    {@const ol = orderLine(doc, o, unit.id, now)}
    {@const halt = textOf({ verb: 'halt', args: { unit: o.from, order: o.id } }, doc)}
    <div class="order">
      {#if ol.other}<button class="link" title={findOf(ol.other, doc)} onclick={() => open(ol.other, onfocus)}>{ol.text}</button>{:else}<span>{ol.text}</span>{/if}
      {#if ol.ratio}<span class="ratio" class:under={ol.ratio.under}>{ol.ratio.text}</span>{/if}
      <button class="x" aria-label="Cancel order: {ol.text}" title="Cancel this order{halt ? ` (${halt})` : ' (/halt)'}" data-testid="cancel-order" use:echoes={halt}
        onclick={() => runCommand({ verb: 'halt', args: { unit: o.from, order: o.id } })}>✕</button>
    </div>
  {:else}
    <p class="muted">No orders. {threat ? 'Unopposed.' : 'Give one with + Order.'}</p>
  {/each}
  {#if outKinds.length}
    <div class="halt" role="group" aria-label="Halt {unit.designation}'s orders">
      <span class="tri-label">Halt</span>
      {#each ['all', ...outKinds] as k (k)}
        {@const t = line('halt', k === 'all' ? {} : { kind: k })}
        <button class="btn" data-testid="halt-kind" data-kind={k} title="Halt {k === 'all' ? 'every order' : `its ${k} orders`} ({t})" use:echoes={t}
          onclick={() => run('halt', k === 'all' ? {} : { kind: k })}>{k === 'all' ? 'All' : k}</button>
      {/each}
      <code class="code">/halt</code>
    </div>
  {/if}
  {#if composing}
    {#key composing}<Composer {doc} {unit} init={composing} />{/key}
  {:else if !resolved}
    <button class="btn new-order" data-testid="unit-new-order" title="Give an order: {orderText} (N)" use:echoes={orderText} onclick={compose}>+ New order…</button>
  {/if}
</Section>

{#if features.vikunja}
  <Section kind={K} key="vikunja" title="Vikunja" summary={unit.vk ? `task #${unit.vk}` : 'no task'} open={false}>
    <Field label="Task" cmd={null}>
      {#if unit.vk}<a class="vk-link" href="{features.vikunja.url}/tasks/{unit.vk}" target="_blank" rel="noopener noreferrer">Task #{unit.vk} ↗</a>{:else}<span class="muted">Not synced to a task yet.</span>{/if}
    </Field>
    <Field label="Map sync" entry={slot('vk', 'sync')} cmd="/vk sync">
      <div class="pair">
        <button class="btn" data-testid="vk-sync" title="/vk sync" use:echoes={'/vk sync'} onclick={() => runCommand({ verb: 'vk', args: { action: 'sync' } })}>Sync</button>
        <button class="btn" data-testid="vk-status" title="/vk status" use:echoes={'/vk status'} onclick={() => runCommand({ verb: 'vk', args: { action: 'status' } })}>Status</button>
      </div>
      <span class="note">Sync and Status act on the whole map, not only this unit.</span>
    </Field>
  </Section>
{/if}

<Section kind={K} key="history" title="History" count={history.length}>
  {#each history as h (h.id)}
    {@const by = annotate(h.id)}
    <div class="hist" class:undone={by?.undone}><span class="when">{formatDtg(h.at).slice(0, 6)}</span>{#if by}<span class="by" style="--who:{by.color}" title="{by.name}{by.ai ? ' (AI agent)' : ''}">{by.initials}{by.ai ? ' AI' : ''}</span>{/if} {by?.text ?? h.text}</div>
  {:else}
    <p class="muted">No log entries.</p>
  {/each}
  <div class="meta">Created {formatDtg(unit.createdAt)}{#if unit.createdBy}{' '}by {nameOf(unit.createdBy)}{/if} · {unitLabel(unit)} · {echelonRange(unit.echelon)}</div>
  {#if unit.updatedBy}<div class="meta" data-testid="updated-by">Last changed {formatDtg(unit.updatedAt)} by <span class="by" style="--who:{color(unit.updatedBy)}">{initials(unit.updatedBy)}</span> {nameOf(unit.updatedBy)}</div>{/if}
</Section>

<style>
  .head { display: flex; align-items: flex-start; gap: var(--s2); padding-bottom: var(--s2); }
  .sym { flex: none; padding: 2px; border: 1px solid transparent; background: none; line-height: 0; }
  .sym:hover { border-color: var(--rule); background: var(--accent-bg); }
  .sym img { max-width: 96px; height: auto; }
  .who { flex: 1; min-width: 0; }
  .desig { font: 700 18px/1.1 var(--font-mono); letter-spacing: 0.04em; }
  .ttl { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { color: var(--ink-2); font-size: 12px; }
  .vk-link { display: inline-block; margin-top: 2px; font-size: 12px; color: var(--ink); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-bottom: var(--s2); }
  .actions .btn { flex: 1 1 0; min-width: max-content; justify-content: center; padding: 0 6px; letter-spacing: 0.06em; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  /* 280 px column: the four actions wrap two by two. */
  :global([data-tier='tablet']) .actions .btn { flex-basis: 40%; }
  .btn.primary:hover { background: var(--ink-2); }
  .choice { margin-bottom: var(--s2); padding: var(--s2); border: 1px solid var(--rule); background: var(--panel-2); font-size: 12px; }
  .choice p { margin: 0 0 var(--s1); }
  .row { display: flex; flex-wrap: wrap; gap: var(--s1); }
  .triage { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); margin-bottom: var(--s2); }
  .tri-label { font: 600 12px/1.2 var(--font-cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); width: 100%; }
  .chip-btn { text-transform: none; letter-spacing: 0.02em; }
  .chip-btn.friend { border-color: var(--friend); color: var(--friend); }
  .chip-btn.hostile { border-color: var(--hostile); color: var(--hostile); }
  .chip-btn.suspect { border-color: var(--k-amber); }
  .inline { display: flex; gap: var(--s1); margin: var(--s1) 0 var(--s2); }
  .pair { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); }
  .pair .field { flex: 1 1 110px; width: auto; min-width: 0; }
  .num { flex: 0 0 72px !important; }
  .short { width: 64px; }
  .mono, .sidc { font-family: var(--font-mono); }
  /* One line: the 20 digits never break; a narrow column cuts the tail, and the tooltip holds the whole code. */
  .sidc { display: block; font-size: 12px; letter-spacing: 0.02em; padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global([data-tier='tablet']) .sidc { font-size: 11px; letter-spacing: 0; }
  .dtg { font: 600 12px/1 var(--font-mono); color: var(--ink-2); }
  .note { display: block; width: 100%; color: var(--ink-3); font-size: 12px; }
  .muted { color: var(--ink-3); margin: 2px 0; font-size: 12px; }
  .hint { color: var(--ink-3); font-size: 12px; align-self: center; }
  .check { display: flex; align-items: center; gap: 6px; min-height: 24px; }
  .k { font: 700 12px/1 var(--font-mono); padding: 4px 5px; color: #fff; }
  .k-green { background: var(--k-green); } .k-amber { background: var(--k-amber); } .k-red { background: var(--k-red); } .k-black { background: var(--k-black); color: var(--panel); }
  .confirm { margin-top: var(--s1); padding: var(--s2); border: 1px solid var(--hostile); background: var(--hostile-bg); font-size: 12px; display: flex; flex-wrap: wrap; gap: var(--s1); align-items: center; }
  .order { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); padding: 3px 0; border-bottom: 1px dotted var(--rule); }
  .ratio { font: 700 12px/1 var(--font-mono); }
  .ratio.under { color: var(--hostile); }
  .x { margin-left: auto; flex: none; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .x:hover { color: var(--hostile); border-color: var(--hostile); }
  :global([data-tier='phone']) .x { width: 44px; height: 44px; }
  .halt { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); padding: var(--s1) 0; }
  .halt .tri-label { width: auto; margin-right: var(--s1); }
  .halt .btn { padding: 0 8px; }
  .halt .code { margin-left: auto; font: 400 11px/1.3 var(--font-mono); color: var(--ink-3); }
  .new-order { width: 100%; justify-content: center; margin-top: var(--s2); }
  .members { margin: 0; padding: 0; list-style: none; }
  .members li { display: flex; align-items: center; gap: var(--s2); padding: 2px 0; border-bottom: 1px dotted var(--rule); }
  .members .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); font-size: 12px; }
  :global([data-tier='phone']) .halt .btn, :global([data-tier='phone']) .new-order { min-height: 44px; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; text-align: left; font-size: 12px; }
  .field-link { display: block; margin-top: 2px; }
  .hist { font-size: 12px; padding: 2px 0; color: var(--ink-2); }
  .hist.undone { text-decoration: line-through; opacity: 0.65; }
  .hist .by, .meta .by { display: inline-block; margin: 0 4px; padding: 0 3px; font: 700 12px/1.4 var(--font-mono); color: #fff; background: var(--who); border-radius: 2px; }
  .when { color: var(--ink-3); }
  .meta { margin-top: var(--s2); color: var(--ink-3); font-size: 12px; }
</style>
