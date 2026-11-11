// The order composer's model: which targets each order verb offers (ranked as the command bar suggests them),
// and the command text it builds, slot by slot. The composer runs that text through the command bar's parse.
import type { Doc, Unit } from '../../core/model/types';
import { suggest } from '../../core/commands/suggest';
import { parse } from '../../core/commands/grammar';
import { unresolved } from '../../core/commands/resolve';
import type { Sel } from '../model/store.svelte';
import { AFF_SHORT, dayMonth } from './words';
import { slotFor, token } from './verbs';

/** The order verbs, in the composer's 3 × 2 grid. */
export const ORDER_VERBS = ['attack', 'moving', 'axis', 'support', 'link', 'advancing'] as const;
export type OrderVerb = typeof ORDER_VERBS[number];
export const isOrderVerb = (v: unknown): v is OrderVerb => (ORDER_VERBS as readonly unknown[]).includes(v);

/**
 * A choice in a picker: `text` goes in the command, `sel` is the object on the map (null when it has none).
 * `why` is the parser's reason when the choice cannot work (a target in another sector): it shows dimmed, last.
 */
export interface Option { key: string; text: string; label: string; tag: string; detail?: string; sel: Sel | null; why?: string }

/** The word between the unit and its target. */
const LEAD: Record<OrderVerb, string> = { attack: '', moving: 'to', axis: 'to', support: '', link: '', advancing: 'on' };

export function unitOption(u: Unit, doc: Doc): Option {
  return { key: `u:${u.id}`, text: token(u.designation), label: u.designation, tag: AFF_SHORT[u.affiliation], detail: `${u.title} · ${doc.sectors.find(s => s.id === u.sectorId)?.name ?? ''}`, sel: { kind: 'unit', id: u.id } };
}
function measureOption(id: string, doc: Doc): Option | null {
  const m = doc.measures.find(x => x.id === id);
  if (!m) return null;
  const type = m.type.toUpperCase();
  return { key: `m:${m.id}`, text: `${type} ${token(m.name)}`, label: `${type} ${m.name}`, tag: type, detail: m.date ? dayMonth(m.date) : doc.sectors.find(s => s.id === m.sectorId)?.name, sel: { kind: 'measure', id: m.id } };
}
const hqOption = (): Option => ({ key: 'hq', text: 'hq', label: 'HQ', tag: 'HQ', detail: 'The center: you', sel: null });
const sectorHqOption = (id: string, doc: Doc): Option | null => {
  const s = doc.sectors.find(x => x.id === id);
  return s ? { key: `s:${s.id}`, text: `${token(s.name)} hq`, label: `${s.name} HQ`, tag: 'HQ', detail: 'Sector HQ', sel: { kind: 'sector', id: s.id } } : null;
};

/**
 * The targets an order verb offers for this unit, in the command bar's order (recent units first, then its sector…),
 * then the other objects the verb accepts that the bar does not suggest (moving to a friendly or to any measure).
 */
export function targetOptions(verb: OrderVerb, unit: Unit, doc: Doc, recent: readonly string[] = []): Option[] {
  const lead = LEAD[verb];
  const prefix = `/${verb} ${token(unit.designation)} ${lead ? `${lead} ` : ''}`;
  const out: Option[] = [];
  const add = (o: Option | null) => { if (o && !out.some(x => x.key === o.key)) out.push(o); };
  if (verb === 'advancing') add(hqOption());
  for (const s of suggest(prefix, prefix.length, doc, { recent }).items) {
    if (s.kind === 'unit') { const u = doc.units.find(x => x.id === s.unitId); if (u && u.id !== unit.id) add(unitOption(u, doc)); continue; }
    const m = /^(OBJ|EA|NAI|PL) (.+)$/.exec(s.label);
    if (m) { add(measureOption(doc.measures.find(x => x.type === m[1].toLowerCase() && x.name === m[2])?.id ?? '', doc)); continue; }
    if (s.insert === 'hq') add(hqOption());
    else if (s.insert === 'sector hq') add({ key: 'sector hq', text: 'sector hq', label: 'Sector HQ', tag: 'HQ', detail: `${doc.sectors.find(x => x.id === unit.sectorId)?.name ?? ''} HQ: its own sector`, sel: null });
    else if (s.insert === 'nearest hostile') add({ key: 'nearest hostile', text: 'nearest hostile', label: 'Nearest hostile', tag: 'HOS', detail: 'In its own sector', sel: null });
    else if (/ hq$/.test(s.insert)) add(sectorHqOption(doc.sectors.find(x => `${x.name} HQ` === s.label)?.id ?? '', doc));
  }
  if (verb === 'moving') {
    for (const u of doc.units) if (u.id !== unit.id && unresolved(u)) add(unitOption(u, doc));
    for (const m of doc.measures) add(measureOption(m.id, doc));
  }
  // The parser has the last word: a target it refuses keeps its place in the list, dimmed with the reason, after the rest.
  for (const o of out) { const res = parse(draftText({ verb, unit, target: o.text }, doc), doc); if (!res.ok) o.why = res.error; }
  return [...out.filter(o => !o.why), ...out.filter(o => o.why)];
}

/**
 * The friendlies that may give an order onto a target, for a view that starts the order at its target end (an area's
 * + Order onto…, a phase line's + Axis via…): ranked as the command bar suggests the unit after `/‹verb› `, then the
 * other open friendlies. `target` is the target's command text, when the view has one. A unit the order refuses
 * (the verb's rule, or the parser's reason) keeps its place in the list, dimmed with the reason, after the rest.
 */
export function orderingUnits(verb: OrderVerb, doc: Doc, recent: readonly string[] = [], target = ''): Option[] {
  const out: Option[] = [];
  const friendly = (u: Unit) => (u.affiliation === 'friend' || u.affiliation === 'assumed') && unresolved(u);
  const add = (u: Unit | undefined) => { if (u && friendly(u) && !out.some(o => o.key === `u:${u.id}`)) out.push(unitOption(u, doc)); };
  const prefix = `/${verb} `;
  for (const s of suggest(prefix, prefix.length, doc, { recent }).items) if (s.kind === 'unit') add(doc.units.find(x => x.id === s.unitId));
  for (const u of [...doc.units].sort((a, b) => a.designation.localeCompare(b.designation))) add(u);
  const entry = slotFor(verb, undefined, 'unit');
  for (const o of out) {
    const u = doc.units.find(x => `u:${x.id}` === o.key)!;
    const rule = entry?.enabled ? entry.enabled({ kind: 'unit', unit: u }, doc) : true;
    if (rule !== true) { o.why = rule; continue; }
    if (!target) continue;
    const res = parse(draftText({ verb, unit: u, target }, doc), doc);
    if (!res.ok) o.why = res.error;
  }
  return [...out.filter(o => !o.why), ...out.filter(o => o.why)];
}

/** The option for a target id as Commands name it (unit id, measure id, `hq`, `hq:‹sector›`), if the verb offers it. */
export function optionFor(target: string, options: Option[]): Option | undefined {
  const key = target === 'hq' ? 'hq' : target.startsWith('hq:') ? `s:${target.slice(3)}` : options.find(o => o.key === `u:${target}`) ? `u:${target}` : `m:${target}`;
  return options.find(o => o.key === key);
}
/** The option a map pick names. */
export function optionForSel(sel: Sel, options: Option[]): Option | undefined {
  const key = sel.kind === 'unit' ? `u:${sel.id}` : sel.kind === 'measure' ? `m:${sel.id}` : `s:${sel.id}`;
  return options.find(o => o.key === key);
}

/** What the composer has filled in. `target` is command text (an option's text, or what the user typed). */
export interface Draft { verb: OrderVerb; unit: Unit; target: string; role?: 'main' | 'support' | ''; planned?: boolean; via?: string[]; kind?: 'dependency' | 'handoff' | '' }
export type SlotKey = 'verb' | 'unit' | 'target' | 'role' | 'planned' | 'via' | 'kind';
export interface Slot { key: SlotKey; text: string; filled: boolean }

/** The slots of the draft's command, in order: filled ones carry their text, empty ones the SYNTAX placeholder. */
export function draftSlots(d: Draft, doc: Doc): Slot[] {
  const syntax = slotFor(d.verb, undefined, 'unit')?.slots ?? [];
  const lead = LEAD[d.verb];
  const via = (d.via ?? []).map(id => doc.measures.find(m => m.id === id)).filter(m => m !== undefined);
  const keys: SlotKey[] = ['unit', 'target', ...({ attack: ['role', 'planned'], axis: ['via'], link: ['kind'] } as Partial<Record<OrderVerb, SlotKey[]>>)[d.verb] ?? []];
  const fill: Record<string, string> = {
    unit: token(d.unit.designation),
    target: d.target.trim() ? `${lead ? `${lead} ` : ''}${d.target.trim()}` : '',
    role: d.role ?? '', planned: d.planned ? 'planned' : '',
    via: via.length ? `via ${via.map(m => `PL ${token(m.name)}`).join(', ')}` : '',
    kind: d.kind ? `as ${d.kind}` : '',
  };
  return [{ key: 'verb', text: `/${d.verb}`, filled: true }, ...keys.map((key, i) => ({ key, text: fill[key] || syntax[i] || '', filled: Boolean(fill[key]) }))];
}
/** The draft's command text: its filled slots. */
export function draftText(d: Draft, doc: Doc): string {
  return draftSlots(d, doc).filter(s => s.filled).map(s => s.text).join(' ');
}
/** What the active slot asks for, in a sentence. */
export const SLOT_HINT: Record<OrderVerb, string> = {
  attack: 'Target: a hostile or suspect unit, or an objective.',
  moving: 'Target: a unit, an area or phase line, HQ, a sector HQ or the nearest hostile. A hostile target makes it an attack.',
  axis: 'Target: the objective at the end of the axis. Via: the phase lines it passes, in order.',
  support: 'Target: the friendly it supports, in any sector.',
  link: 'Target: the unit it links up with.',
  advancing: 'Target: HQ, a sector HQ, or the unit it advances on.',
};
