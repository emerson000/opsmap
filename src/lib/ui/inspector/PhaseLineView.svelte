<script lang="ts">
  // A phase line: Re-date first, + Axis via… (pick the friendly, then its order composer with this line in via);
  // its name, date (with the ring it lands in), the axes that pass it and the orders moving to it, History and Manage.
  import type { Command, ControlMeasure, Doc } from '../../../core/model/types';
  import { radiusForDate, ringForRadius } from '../../../core/model/geometry';
  import { formatDtg } from '../../../core/model/sidc';
  import { localDay } from '../../../core/model/time';
  import { parseDate } from '../../../core/commands/tokenize';
  import { MAP_EDGE_R } from '../../map/constants';
  import { recentIds } from '../../commands/recent.svelte';
  import { env, runCommand, toast, ui, type PickSlot } from '../shell.svelte';
  import { orderingUnits } from '../compose';
  import { dayMonth, orderLine } from '../words';
  import { slotFor, token } from '../verbs';
  import Section from './Section.svelte';
  import Field from './Field.svelte';
  import ViewHead from './ViewHead.svelte';
  import Manage from './Manage.svelte';
  import PeekMore from './PeekMore.svelte';
  import OrderFrom from './OrderFrom.svelte';
  import { plRingNote } from './place';
  import { echoes, findOf, open, textOf } from './echo';

  const K = 'pl';
  const SHORT_RING: Record<string, string> = { hq: 'HQ ring', near: 'Close ring', mid: 'Deep ring', far: 'AOI ring' };
  let { doc, measure: m, now, onfocus }: { doc: Doc; measure: ControlMeasure; now: Date; onfocus: (id: string) => void } = $props();

  const tz = $derived(doc.settings.tz);
  const ref = $derived(/[\s",\\]/.test(m.name) ? JSON.stringify(m.name) : m.name);
  const mc = (args: Record<string, unknown>): Command => ({ verb: 'pl', args: { measure: m.id, ...args } });
  const slot = (form: string) => slotFor('pl', form, 'pl');
  const r = $derived(m.date ? radiusForDate(m.date, now, tz) : null);
  const ring = $derived(r === null ? null : ringForRadius(r));
  const drawn = $derived(r !== null && r > 0.3 && r <= MAP_EDGE_R);
  const days = $derived(m.date ? Math.round((Date.parse(localDay(new Date(m.date), tz)) - Date.parse(localDay(now, tz))) / 86400000) : null);
  const axes = $derived(doc.orders.filter(o => o.type === 'axis' && o.via?.includes(m.id)));
  const moving = $derived(doc.orders.filter(o => o.to === m.id));
  const history = $derived(doc.log.filter(l => l.text.toUpperCase().includes(`PL ${m.name.toUpperCase()}`)).slice(-8).reverse());
  const status = $derived([
    m.date ? dayMonth(m.date) : 'undated',
    days !== null ? (days === 0 ? 'today' : days > 0 ? `in ${days} d` : `${-days} d ago`) : '',
    drawn && ring ? SHORT_RING[ring] ?? '' : 'not drawn',
    `${axes.length} ax${axes.length === 1 ? 'is' : 'es'}`,
    moving.length ? `${moving.length} moving` : '',
  ].filter(Boolean).join(' · '));
  let dateEl: HTMLInputElement | undefined = $state();

  /** The date being typed: the ring note follows it before it runs. */
  let draft = $state<string | null>(null);
  $effect(() => { void m.id; void m.date; draft = null; });
  const draftIso = $derived.by(() => {
    if (draft === null) return m.date;
    try { return draft ? parseDate(draft, now, tz) : undefined; } catch { return undefined; }
  });
  const ringNote = $derived(plRingNote(draftIso, now, tz));

  function dateInput(iso?: string): string { return iso ? localDay(new Date(iso), tz) : ''; }
  function setDate(value: string) {
    if (!value) return;
    try { runCommand(mc({ action: 'date', date: parseDate(value, new Date(), tz) })); } catch (e) { toast(e instanceof Error ? e.message : 'Invalid date'); }
  }
  function rename(value: string) {
    const name = value.trim();
    if (name && name.toUpperCase() !== m.name.toUpperCase()) runCommand(mc({ action: 'rename', name }));
  }
  /** + Axis via…: first the friendly (a list, or ⌖ Map), then its composer on Axis with this line in via. */
  const axisSlots = $derived<PickSlot[]>([
    { text: '/axis', state: 'filled' }, { text: '‹unit›', state: 'active' }, { text: 'to OBJ ‹name›', state: 'empty' }, { text: `via PL ${token(m.name)}`, state: 'filled' },
  ]);
  const axisText = $derived(axisSlots.map(s => s.text).join(' '));
  let axing = $state(false);
  $effect(() => { void m.id; axing = false; });
  const axisFrom = $derived(axing ? orderingUnits('axis', doc, recentIds(doc)) : []);
  function axisVia() {
    axing = !axing;
    if (axing && env.tier === 'phone' && !env.landscape && ui.sheet === 'peek') ui.sheet = 'half';
  }
  function axisFor(unit: string) { axing = false; ui.compose = { unit, verb: 'axis', via: [m.id] }; }
  const impact = $derived.by(() => {
    const parts: string[] = [];
    if (axes.length) parts.push(`It comes off ${axes.length} axis${axes.length === 1 ? '' : 'es'}: ${axes.map(o => `${doc.units.find(u => u.id === o.from)?.designation ?? '?'} ${orderLine(doc, o, o.from, now).text}`).join('; ')}.`);
    if (moving.length) parts.push(`It drops ${moving.length} order${moving.length === 1 ? '' : 's'} moving to it.`);
    return parts.length ? parts.join(' ') : null;
  });
</script>

<ViewHead glyph="PL" kind="pl" name={m.name} find={textOf({ verb: 'find', args: { measure: m.id } }, doc)}
  sub="Phase line · {m.date ? formatDtg(m.date) : 'undated'}" {status} />

<div class="actions">
  <button class="btn primary" data-testid="pl-redate" title="Change its date (/pl date {ref} ‹date›)" use:echoes={`/pl date ${ref} ‹date›`} onclick={() => { dateEl?.focus(); try { dateEl?.showPicker?.(); } catch { /* not allowed here */ } }}>Re-date</button>
  <button class="btn" data-testid="pl-axis" aria-expanded={axing} title="An axis of advance through {m.name}: {axisText}" use:echoes={axisText} onclick={axisVia}>+ Axis via…</button>
  <PeekMore />
</div>
{#if axing}
  <OrderFrom options={axisFrom} title="Axis via PL {m.name}" command={axisText} slots={axisSlots} onchoose={axisFor} onclose={() => (axing = false)} />
{/if}

<Section kind={K} key="line" title="Line" summary={m.date ? formatDtg(m.date) : 'undated'}>
  <Field label="Name" entry={slot('rename')} cmd={textOf(mc({ action: 'rename', name: m.name }), doc)}>
    <input class="field mono" value={m.name} onchange={(e) => rename(e.currentTarget.value)} aria-label="Name" data-testid="measure-name" />
  </Field>
  <Field label="Date" entry={slot('date')} cmd={m.date ? textOf(mc({ action: 'date', date: m.date }), doc) : null}>
    <input class="field" type="date" bind:this={dateEl} value={dateInput(m.date)} oninput={(e) => (draft = e.currentTarget.value)} onchange={(e) => setDate(e.currentTarget.value)}
      aria-label="Phase line date" aria-describedby="pl-ring-note" data-testid="pl-date" />
    <p class="note" id="pl-ring-note" data-testid="pl-ring" class:off={ringNote.includes('not drawn')}>{ringNote}</p>
  </Field>
  <Field label="DTG"><span class="mono">{m.date ? formatDtg(m.date) : '—'}</span></Field>
</Section>

<Section kind={K} key="axes" title="Axes through it" count={axes.length} summary={axes.length ? axes.map(o => doc.units.find(u => u.id === o.from)?.designation ?? '?').join(', ') : 'none'}>
  <div data-testid="pl-axes">
    {#each axes as o (o.id)}
      {@const from = doc.units.find(u => u.id === o.from)}
      {@const halt = textOf({ verb: 'halt', args: { unit: o.from, order: o.id } }, doc)}
      <div class="row">
        <button class="link" title={findOf({ kind: 'unit', id: o.from }, doc)} onclick={() => open({ kind: 'unit', id: o.from }, onfocus)}>{from?.designation ?? o.from}</button>
        <span class="muted">{orderLine(doc, o, o.from, now).text}</span>
        <button class="x" aria-label="Cancel order: {from?.designation} axis" title={halt ?? '/halt'} use:echoes={halt} data-testid="cancel-order"
          onclick={() => runCommand({ verb: 'halt', args: { unit: o.from, order: o.id } })}>✕</button>
      </div>
    {:else}
      <p class="muted">No axis of advance passes {m.name}.</p>
    {/each}
  </div>
</Section>

<Section kind={K} key="moving" title="Moving to it" count={moving.length} summary={moving.length ? moving.map(o => doc.units.find(u => u.id === o.from)?.designation ?? '?').join(', ') : 'none'}>
  <div data-testid="pl-moving">
    {#each moving as o (o.id)}
      {@const from = doc.units.find(u => u.id === o.from)}
      {@const halt = textOf({ verb: 'halt', args: { unit: o.from, order: o.id } }, doc)}
      <div class="row">
        <button class="link" title={findOf({ kind: 'unit', id: o.from }, doc)} onclick={() => open({ kind: 'unit', id: o.from }, onfocus)}>{from?.designation ?? o.from}</button>
        <span class="muted">{orderLine(doc, o, o.from, now).text}</span>
        <button class="x" aria-label="Cancel order: {from?.designation} moving" title={halt ?? '/halt'} use:echoes={halt} data-testid="cancel-order"
          onclick={() => runCommand({ verb: 'halt', args: { unit: o.from, order: o.id } })}>✕</button>
      </div>
    {:else}
      <p class="muted">No /moving orders end at this line.</p>
    {/each}
  </div>
</Section>

<Section kind={K} key="history" title="History" count={history.length} open={false}>
  {#each history as h (h.id)}<div class="hist"><span class="muted">{formatDtg(h.at).slice(0, 6)}</span> {h.text}</div>{:else}<p class="muted">No log entries.</p>{/each}
</Section>

<Manage {doc} label="Remove phase line…" cmd={mc({ action: 'remove' })} {impact} />

<style>
  .actions { display: flex; flex-wrap: wrap; gap: var(--s1); margin-bottom: var(--s2); }
  .actions .btn { flex: 1 1 0; min-width: max-content; justify-content: center; padding: 0 6px; letter-spacing: 0.06em; }
  .btn.primary { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  .row { display: flex; align-items: center; gap: var(--s2); padding: 3px 0; border-bottom: 1px dotted var(--rule); font-size: 12px; }
  .row .muted { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { flex: none; width: 24px; height: 24px; border: 1px solid var(--rule); background: none; color: var(--ink-3); font: 12px/1 var(--font-mono); }
  .x:hover { color: var(--hostile); border-color: var(--hostile); }
  :global([data-tier='phone']) .x { width: 44px; height: 44px; }
  .link { background: none; border: 0; padding: 0; color: var(--friend); text-decoration: underline; text-underline-offset: 2px; font: 700 12px/1.4 var(--font-mono); }
  .muted { color: var(--ink-3); font-size: 12px; margin: 2px 0; }
  .mono { font-family: var(--font-mono); }
  .note { margin: 2px 0 0; font-size: 12px; color: var(--ink-2); }
  .note.off { color: var(--hostile); }
  .hist { font-size: 12px; padding: 2px 0; color: var(--ink-2); }
</style>
