// One table of what the sidebar can do to each kind of object, and the text of each command.
// Sidebar controls, quick menus and the phone quick row read VERB_SLOTS; every control turns its Command
// into fully named text with format() and runs that text through the command bar's own parse and dispatch.
// tests/ui/sidebar-coverage.test.ts fails when an object-acting verb has no control here, and
// tests/ui/verbs.test.ts checks that parse(format(c)) gives c back.
import type { Command, ControlMeasure, Doc, Sector, Unit } from '../../core/model/types';
import { identities, sizes } from '../../core/commands/apply';
import { FUNCTIONS } from '../../core/model/functions';
import { parts } from '../../core/model/time';

/** The kinds of sidebar view. `area` is an OBJ, EA or NAI; `map` is the Situation view (nothing selected). */
export type ObjKind = 'unit' | 'area' | 'pl' | 'sector' | 'map';
/** The object a view shows, for `enabled`. */
export interface Obj { kind: ObjKind; unit?: Unit; measure?: ControlMeasure; sector?: Sector }

export interface VerbSlot {
  /** A VERBS entry. */
  verb: string;
  /** The action word of a verb with actions (`/sector rename`, `/obj join`), or a variant (`move near`). */
  form?: string;
  /** The views that have a control for it. */
  kinds: ObjKind[];
  /** Its slots in command order, from SYNTAX: `‹…›` must be filled, `[…]` is optional. */
  slots: string[];
  /** The sidebar control: its data-testid, the same on every view that has it. */
  control: string;
  /** Short label for buttons and menus. */
  label: string;
  /** What a quick menu item does: run at once, open a form in the sidebar, or fill the command bar. */
  menu?: 'run' | 'form' | 'bar';
  /** Order in the phone quick row (lower first); absent = not in the quick row. */
  rank?: number;
  /** True when the control applies to this object, or the reason it does not. */
  enabled?: (o: Obj, doc: Doc) => true | string;
}

const threat = (u?: Unit) => u?.affiliation === 'hostile' || u?.affiliation === 'suspect';
const friendly = (u?: Unit) => u?.affiliation === 'friend' || u?.affiliation === 'assumed';
const resolved = (u?: Unit) => u?.lifecycle === 'done' || u?.lifecycle === 'dropped';
const open = (o: Obj): true | string => resolved(o.unit) ? `${o.unit!.designation} is ${o.unit!.lifecycle}: reopen it first` : true;
/** `/collapse` (fold) or `/expand`: a task force in the other state, or on the map view any such task force. */
function foldable(o: Obj, doc: Doc, fold: boolean): true | string {
  const tf = (u: Unit) => Boolean(u.taskForce) && doc.units.some(c => c.parentId === u.id);
  if (o.kind === 'map') return doc.units.some(u => tf(u) && Boolean(u.collapsed) !== fold) ? true : `No ${fold ? 'expanded' : 'collapsed'} task force`;
  if (!o.unit || !tf(o.unit)) return 'Not a task force';
  return Boolean(o.unit.collapsed) !== fold ? true : `Already ${fold ? 'collapsed' : 'expanded'}`;
}
const AREAS = ['obj', 'ea', 'nai'] as const;
const AREA_WORD: Record<string, string> = { obj: 'objective', ea: 'engagement area', nai: 'named area of interest' };

export const VERB_SLOTS: readonly VerbSlot[] = [
  // Units
  { verb: 'new', kinds: ['map', 'sector'], slots: ['[identity]', '[size]', '[function]', '"‹title›"', '[in ‹sector›]', '[ring]', '[due ‹date›]', '[as ‹designation›]', '[confirm]'], control: 'new-unit', label: 'Unit…', menu: 'form' },
  { verb: 'id', kinds: ['unit'], slots: ['‹unit›', '‹identity›', '[confirm]'], control: 'unit-identity', label: 'Identity' },
  { verb: 'size', kinds: ['unit'], slots: ['‹unit›', '‹echelon›'], control: 'unit-echelon', label: 'Effort' },
  { verb: 'fn', kinds: ['unit'], slots: ['‹unit›', '‹function›', '[confirm]'], control: 'unit-function', label: 'Function' },
  { verb: 'rename', kinds: ['unit'], slots: ['‹unit›', '"‹title›"', '[as ‹designation›]'], control: 'unit-title', label: 'Rename' },
  { verb: 'move', kinds: ['unit', 'sector'], slots: ['‹unit›', '[to ‹sector›]', '‹ring›'], control: 'unit-place', label: 'Move…', menu: 'bar', enabled: open },
  { verb: 'move', form: 'near', kinds: ['unit'], slots: ['‹unit›', 'near ‹unit›'], control: 'unit-near', label: 'Near…', menu: 'form', enabled: open },
  { verb: 'attack', kinds: ['unit', 'area'], slots: ['‹unit›', '‹target›', '[main|support]', '[planned]'], control: 'composer-attack', label: 'Attack…', menu: 'form', rank: 1,
    enabled: o => o.kind !== 'unit' ? (o.measure?.type === 'obj' ? true : 'Only an objective can be attacked') : friendly(o.unit) ? open(o) : 'Only a friendly attacks' },
  { verb: 'moving', kinds: ['unit', 'area', 'pl', 'sector'], slots: ['‹unit›', 'to ‹target|nearest hostile|hq|sector hq|‹sector› hq›'], control: 'composer-moving', label: 'Moving…', menu: 'form', enabled: o => o.kind === 'unit' ? open(o) : true },
  { verb: 'axis', kinds: ['unit', 'area', 'pl'], slots: ['‹unit›', 'to OBJ ‹name›', '[via PL ‹name›, ...]'], control: 'composer-axis', label: 'Axis…', menu: 'form',
    enabled: o => o.kind === 'unit' ? (friendly(o.unit) ? open(o) : 'Only a friendly gets an axis') : o.kind === 'area' && o.measure?.type !== 'obj' ? 'An axis ends on an objective' : true },
  { verb: 'advancing', kinds: ['unit', 'sector'], slots: ['‹hostile›', 'on ‹hq|sector hq|‹sector› hq|unit›'], control: 'composer-advancing', label: 'Advancing…', menu: 'form',
    enabled: o => o.kind === 'unit' && !threat(o.unit) ? 'Only a hostile or suspect advances' : o.kind === 'unit' ? open(o) : true },
  { verb: 'support', kinds: ['unit'], slots: ['‹friendly›', '‹friendly›'], control: 'composer-support', label: 'Support…', menu: 'form', enabled: o => friendly(o.unit) ? open(o) : 'Only a friendly supports' },
  { verb: 'link', kinds: ['unit'], slots: ['‹unit›', '‹unit›', '[as dependency|handoff]'], control: 'composer-link', label: 'Link…', menu: 'form', enabled: open },
  { verb: 'halt', kinds: ['unit', 'area', 'pl', 'sector'], slots: ['‹unit›', '[advance|move|attack|axis|link|support]'], control: 'cancel-order', label: 'Halt', menu: 'run' },
  { verb: 'bda', kinds: ['unit'], slots: ['‹unit›', '‹0–100%|fc|dmg|des|full›'], control: 'unit-condition', label: 'Condition' },
  { verb: 'block', kinds: ['unit'], slots: ['‹unit›', '[by "‹reason›"]'], control: 'unit-block', label: 'Block…', menu: 'form', rank: 3,
    enabled: o => threat(o.unit) ? 'A threat is not blocked' : o.unit?.lifecycle === 'blocked' ? 'Already blocked' : open(o) },
  { verb: 'unblock', kinds: ['unit'], slots: ['‹unit›'], control: 'unit-unblock', label: 'Unblock', menu: 'run', rank: 3, enabled: o => o.unit?.lifecycle === 'blocked' ? true : 'Not blocked' },
  { verb: 'unpin', kinds: ['unit'], slots: ['‹pinned unit›'], control: 'unpin', label: 'Unpin', menu: 'run', enabled: o => o.unit?.posOverride ? true : 'Not pinned' },
  { verb: 'reopen', kinds: ['unit'], slots: ['‹done or dropped unit›'], control: 'unit-reopen', label: 'Reopen', menu: 'run', rank: 1, enabled: o => resolved(o.unit) ? true : 'Still open' },
  { verb: 'done', kinds: ['unit'], slots: ['‹unit›'], control: 'unit-done', label: 'Done', menu: 'run', rank: 2, enabled: open },
  { verb: 'drop', kinds: ['unit'], slots: ['‹unit›', '[bypassed]'], control: 'unit-drop', label: 'Drop…', menu: 'run', rank: 4, enabled: open },
  { verb: 'reinforce', kinds: ['unit'], slots: ['‹unit›', '[with ‹unit›]'], control: 'reinforce-with', label: '(+)' },
  { verb: 'reduce', kinds: ['unit'], slots: ['‹unit›', '["‹scope cut›"]'], control: 'reduce-note', label: '(−)' },
  { verb: 'attach', kinds: ['unit'], slots: ['‹unit›', 'to ‹task force›'], control: 'unit-attach', label: 'Attach…', menu: 'form' },
  { verb: 'detach', kinds: ['unit'], slots: ['‹unit›'], control: 'unit-detach', label: 'Detach', menu: 'run', enabled: o => o.unit?.parentId ? true : 'Not attached' },
  { verb: 'collapse', kinds: ['unit', 'map'], slots: ['‹task force› | all'], control: 'tf-collapse', label: 'Collapse task force', menu: 'run', enabled: (o, doc) => foldable(o, doc, true) },
  { verb: 'expand', kinds: ['unit', 'map'], slots: ['‹task force› | all'], control: 'tf-expand', label: 'Expand task force', menu: 'run', enabled: (o, doc) => foldable(o, doc, false) },
  { verb: 'due', kinds: ['unit'], slots: ['‹unit›', '‹date|none›'], control: 'unit-due', label: 'Due…', menu: 'form' },
  { verb: 'note', kinds: ['unit'], slots: ['‹unit›', '"‹text›"'], control: 'unit-note', label: 'Note…', menu: 'form' },
  { verb: 'rate', kinds: ['unit'], slots: ['‹unit›', '‹A–F›‹1–6›'], control: 'unit-rating', label: 'Rating' },
  { verb: 'key', kinds: ['unit'], slots: ['‹unit›'], control: 'unit-key', label: 'Key terrain', menu: 'run' },
  { verb: 'cp', kinds: ['unit'], slots: ['‹unit›', '‹main|tac|alt|rear|none›'], control: 'unit-cp', label: 'Command post' },
  { verb: 'sidc', kinds: ['unit'], slots: ['‹unit›', '‹20 digits›'], control: 'unit-sidc', label: 'SIDC' },
  { verb: 'find', kinds: ['unit', 'area', 'pl', 'sector'], slots: ['‹unit› | obj|ea|nai|pl ‹name› | sector ‹name›'], control: 'find', label: 'Find', menu: 'run' },
  // Sectors and the AO
  { verb: 'sector', form: 'add', kinds: ['map'], slots: ['‹name›'], control: 'new-sector', label: 'Sector…', menu: 'form' },
  { verb: 'sector', form: 'rename', kinds: ['sector'], slots: ['‹name›', '‹new name›'], control: 'sector-name', label: 'Rename…' },
  { verb: 'sector', form: 'remove', kinds: ['sector'], slots: ['‹name›', '[reassign ‹sector›]'], control: 'manage-remove', label: 'Remove sector…',
    enabled: (_o, doc) => doc.sectors.length > 1 ? true : 'The last sector cannot be removed' },
  { verb: 'sector', form: 'width', kinds: ['sector'], slots: ['‹name›', '‹degrees›'], control: 'sector-width', label: 'Width' },
  { verb: 'sector', form: 'size', kinds: ['map'], slots: ['‹small|medium|large|xl›'], control: 'ao-size', label: 'AO size' },
  // Phase lines
  { verb: 'pl', form: 'add', kinds: ['map'], slots: ['"‹name›"', '‹date›'], control: 'new-pl', label: 'Phase line…', menu: 'form' },
  { verb: 'pl', form: 'date', kinds: ['pl'], slots: ['‹name›', '‹date›'], control: 'pl-date', label: 'Re-date', rank: 1 },
  { verb: 'pl', form: 'rename', kinds: ['pl'], slots: ['‹name›', '"‹new name›"'], control: 'measure-name', label: 'Rename…' },
  { verb: 'pl', form: 'remove', kinds: ['pl'], slots: ['‹name›'], control: 'manage-remove', label: 'Remove phase line…' },
  // Areas: the same forms for OBJ, EA and NAI
  ...AREAS.flatMap((v): VerbSlot[] => [
    { verb: v, form: 'add', kinds: ['map', 'sector'], slots: ['"‹name›"', 'in ‹sector›', '[ring]'], control: 'new-area', label: 'Area…', menu: 'form' },
    { verb: v, form: 'move', kinds: ['area'], slots: ['‹name›', '[to ‹sector›]', '‹ring›'], control: 'measure-place', label: 'Move…' },
    { verb: v, form: 'near', kinds: ['area'], slots: ['‹name›', 'near ‹unit›'], control: 'measure-near', label: 'Near…', menu: 'form' },
    { verb: v, form: 'join', kinds: ['area', 'unit'], slots: ['‹name›', '‹unit›…'], control: 'measure-add-members', label: 'Add units…', menu: 'form', rank: 2 },
    { verb: v, form: 'leave', kinds: ['area', 'unit'], slots: ['‹name›', '‹unit›…'], control: 'measure-leave', label: 'Leave' },
    { verb: v, form: 'size', kinds: ['area'], slots: ['‹name›', '‹small|medium|large|xl›'], control: 'measure-size', label: 'Min. size' },
    { verb: v, form: 'rename', kinds: ['area'], slots: ['‹name›', '"‹new name›"'], control: 'measure-name', label: 'Rename…' },
    { verb: v, form: 'remove', kinds: ['area'], slots: ['‹name›'], control: 'manage-remove', label: `Remove ${AREA_WORD[v]}…` },
  ]),
  // Map-wide verbs that the Situation view (and a sector's Vikunja section) offers
  { verb: 'intent', kinds: ['map'], slots: ['"‹one line›"'], control: 'situation-intent', label: 'Intent…', menu: 'form' },
  { verb: 'sitrep', kinds: ['map'], slots: ['[copy]'], control: 'situation-sitrep', label: 'SITREP', menu: 'run' },
  { verb: 'vk', form: 'bind', kinds: ['map', 'sector'], slots: ['"‹Vikunja project›"'], control: 'vk-bind', label: 'Bind…', menu: 'form' },
  { verb: 'vk', form: 'unbind', kinds: ['map', 'sector'], slots: [], control: 'vk-unbind', label: 'Unbind…' },
  { verb: 'vk', form: 'sync', kinds: ['map', 'unit', 'sector'], slots: [], control: 'vk-sync', label: 'Sync', menu: 'run' },
  { verb: 'vk', form: 'status', kinds: ['map', 'unit', 'sector'], slots: [], control: 'vk-status', label: 'Status', menu: 'run' },
];

/**
 * The unit right-click menu, in order: each item's `data-action` key and the VERB_SLOTS entry it stands for.
 * An item shows when its entry applies to the unit (`enabled`); Inspect opens the unit's view (`/find`).
 */
export const UNIT_MENU: readonly { key: string; verb: string; form?: string }[] = [
  { key: 'reopen', verb: 'reopen' }, { key: 'attack', verb: 'attack' }, { key: 'move', verb: 'move' }, { key: 'due', verb: 'due' }, { key: 'note', verb: 'note' },
  { key: 'collapse', verb: 'collapse' }, { key: 'expand', verb: 'expand' }, { key: 'unblock', verb: 'unblock' }, { key: 'block', verb: 'block' }, { key: 'unpin', verb: 'unpin' }, { key: 'halt', verb: 'halt' }, { key: 'key', verb: 'key' },
  { key: 'done', verb: 'done' }, { key: 'drop', verb: 'drop' }, { key: 'inspect', verb: 'find' },
];
/** The table entry behind a unit menu item. */
export function menuEntry(key: string): VerbSlot | undefined {
  const m = UNIT_MENU.find(x => x.key === key);
  return m ? slotFor(m.verb, m.form, 'unit') : undefined;
}

/** The short command a control shows next to its label: `/size`, `/obj rename`, `/move … near`. */
export function verbCode(e: Pick<VerbSlot, 'verb' | 'form'>): string {
  return e.form === 'near' ? `/${e.verb === 'move' ? 'move' : `${e.verb} move`} … near` : `/${e.verb}${e.form ? ` ${e.form}` : ''}`;
}
/** The table entry for a verb (and form) on a kind of view. */
export function slotFor(verb: string, form: string | undefined, kind: ObjKind): VerbSlot | undefined {
  return VERB_SLOTS.find(e => e.verb === verb && e.form === form && e.kinds.includes(kind));
}
/** The entries a kind of view offers, in table order; `quick` keeps the phone quick row, ranked. */
export function slotsFor(kind: ObjKind, quick = false): VerbSlot[] {
  const all = VERB_SLOTS.filter(e => e.kinds.includes(kind));
  return quick ? all.filter(e => e.rank !== undefined).sort((a, b) => a.rank! - b.rank!) : all;
}
/** True, or the reason the control does not apply to this object. */
export function enabledFor(e: VerbSlot, o: Obj, doc: Doc): true | string { return e.enabled ? e.enabled(o, doc) : true; }

// ---------- command text ----------

export class FormatError extends Error {}
const fail = (message: string): never => { throw new FormatError(message); };
/** A name as one token: quoted when it holds a space, comma or quote (or is empty). */
export const token = (s: string) => /^[^\s",\\]+$/.test(s) ? s : quoted(s);
/** Free text, always quoted (titles, notes, reasons). */
export const quoted = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** A date as the parser reads it back exactly: YYYY-MM-DD when it is 1700 local (the parser's default), else a DTG. */
export function dateText(iso: string, tz?: string): string {
  const p = parts(new Date(iso), tz);
  if (p.hour === '17' && p.minute === '00' && p.second === '00') return `${p.year}-${p.month}-${p.day}`;
  return `${p.day}${p.hour}${p.minute}J${MONTHS[Number(p.month) - 1]}${p.year.slice(2)}`;
}
const CONDITION_TOKEN: Record<string, string> = { 'fully-capable': 'fc', damaged: 'dmg', destroyed: 'des', full: 'full', none: 'none' };
/** A function word /new cannot mistake for an identity or an echelon (`sec` is also section: use `security`). */
function fnToken(fn: string): string {
  if (!Object.hasOwn(sizes, fn) && !Object.hasOwn(identities, fn)) return fn;
  return FUNCTIONS.find(f => f.key === fn)?.aliases.find(a => !Object.hasOwn(sizes, a) && !Object.hasOwn(identities, a) && /^[^\s",]+$/.test(a)) ?? fail(`No unambiguous word for function ${fn}`);
}

/**
 * The fully named command-bar text for a Command, so that parse(text) gives the same Command back:
 * units by designation, sectors and control measures by name (quoted when needed), dates the parser reads exactly.
 * It never depends on the selection. Throws FormatError for a Command that has no text form (a drag position).
 */
export function format(cmd: Command, doc: Doc): string {
  const a = cmd.args, tz = doc.settings.tz;
  const unit = (id: unknown) => { const u = doc.units.find(x => x.id === id); return u ? token(u.designation) : fail(`Unknown unit: ${String(id)}`); };
  const sector = (id: unknown) => { const s = doc.sectors.find(x => x.id === id); return s ? token(s.name) : fail(`Unknown sector: ${String(id)}`); };
  const measure = (id: unknown) => { const m = doc.measures.find(x => x.id === id); return m ? token(m.name) : fail(`Unknown control measure: ${String(id)}`); };
  const target = (id: unknown) => {
    if (id === 'hq') return 'hq';
    if (typeof id === 'string' && id.startsWith('hq:')) return `${sector(id.slice(3))} hq`;
    const m = doc.measures.find(x => x.id === id);
    return m ? `${m.type.toUpperCase()} ${token(m.name)}` : unit(id);
  };
  const date = (v: unknown) => typeof v === 'string' ? dateText(v, tz) : fail('Expected a date');
  const text = (v: unknown) => typeof v === 'string' ? quoted(v) : fail('Expected text');
  if ('r' in a || 'theta' in a) fail('A position on the map has no command text');
  const words: string[] = [`/${cmd.verb}`];
  const add = (...w: (string | false | undefined | null)[]) => { for (const x of w) if (x) words.push(x); };
  switch (cmd.verb) {
    case 'new':
      add(a.affiliation as string, a.echelon as string, typeof a.fn === 'string' && fnToken(a.fn), typeof a.title === 'string' && quoted(a.title),
        a.sectorId !== undefined && `in ${sector(a.sectorId)}`, a.ring as string, a.dueAt !== undefined && `due ${date(a.dueAt)}`,
        typeof a.designation === 'string' && `as ${token(a.designation)}`, a.confirm === true && 'confirm');
      break;
    case 'id': add(unit(a.unit), String(a.affiliation), a.confirm === true && 'confirm'); break;
    case 'size': add(unit(a.unit), String(a.echelon)); break;
    case 'fn': add(unit(a.unit), String(a.fn), a.confirm === true && 'confirm'); break;
    case 'rename': add(unit(a.unit), text(a.title), typeof a.designation === 'string' && `as ${token(a.designation)}`); break;
    case 'move':
      add(unit(a.unit));
      if (a.nearUnit !== undefined) add('near', unit(a.nearUnit));
      else add(a.sectorId !== undefined && `to ${sector(a.sectorId)}`, typeof a.ring === 'string' ? a.ring : fail('Expected a ring'));
      break;
    case 'attack': add(unit(a.unit), target(a.target), typeof a.role === 'string' && a.role, a.planned === true && 'planned'); break;
    case 'moving': add(unit(a.unit), 'to', target(a.target)); break;
    case 'axis': {
      const via = Array.isArray(a.via) ? a.via : [];
      add(unit(a.unit), 'to', `OBJ ${measure(a.target)}`, via.length > 0 && `via ${via.map(id => `PL ${measure(id)}`).join(', ')}`);
      break;
    }
    case 'advancing': add(unit(a.unit), 'on', target(a.target)); break;
    case 'bda': add(unit(a.unit), typeof a.strength === 'number' ? `${a.strength}%` : CONDITION_TOKEN[String(a.condition)] ?? fail('Expected a strength or condition')); break;
    case 'block': add(unit(a.unit), typeof a.note === 'string' && `by ${quoted(a.note)}`); break;
    case 'unblock': case 'unpin': case 'reopen': case 'done': case 'detach': add(unit(a.unit)); break;
    case 'key': if (a.value !== undefined) fail('/key toggles: leave out value'); add(unit(a.unit)); break;
    case 'drop': add(unit(a.unit), a.bypassed === true && 'bypassed'); break;
    case 'reinforce': add(unit(a.unit), a.with !== undefined && `with ${unit(a.with)}`); break;
    case 'reduce': add(unit(a.unit), typeof a.note === 'string' && quoted(a.note)); break;
    case 'attach': add(unit(a.unit), 'to', unit(a.parent)); break;
    case 'collapse': case 'expand': add(a.all === true ? 'all' : unit(a.unit)); break;
    case 'link': add(unit(a.unit), unit(a.target), typeof a.kind === 'string' && `as ${a.kind}`); break;
    case 'due': add(unit(a.unit), a.dueAt === null ? 'none' : date(a.dueAt)); break;
    case 'note': add(unit(a.unit), text(a.note)); break;
    case 'rate': add(unit(a.unit), String(a.rating)); break;
    case 'support': add(unit(a.unit), unit(a.target)); break;
    case 'cp': add(unit(a.unit), a.cp === null ? 'none' : String(a.cp)); break;
    case 'sidc': add(unit(a.unit), String(a.sidc)); break;
    case 'halt': {
      let kind = a.kind as string | undefined;
      if (a.order !== undefined) {
        // One order by id: the bar names it by kind, which is exact while the unit has one order of that kind.
        const o = doc.orders.find(x => x.id === a.order) ?? fail('Unknown order');
        if (o.from !== a.unit) fail('Not this unit’s order');
        if (doc.orders.filter(x => x.from === o.from && x.type === o.type).length > 1) fail(`Several ${o.type} orders: no text names one`);
        kind = o.type;
      }
      add(unit(a.unit), kind);
      break;
    }
    case 'find':
      if (a.measure !== undefined) { const m = doc.measures.find(x => x.id === a.measure) ?? fail('Unknown control measure'); add(m.type, token(m.name)); }
      else if (a.sectorId !== undefined) add('sector', sector(a.sectorId));
      else add(unit(a.unit));
      break;
    case 'sector': {
      const action = String(a.action); add(action);
      if (action === 'add') add(token(String(a.name)));
      else if (action === 'size') add(String(a.size));
      else {
        add(sector(a.sectorId));
        if (action === 'rename') add(token(String(a.name)));
        else if (action === 'width') add(String(a.degrees));
        else if (action === 'remove') add(a.reassign !== undefined && `reassign ${sector(a.reassign)}`);
        else fail(`Unknown sector action: ${action}`);
      }
      break;
    }
    case 'pl': case 'obj': case 'ea': case 'nai': {
      const action = String(a.action); add(action);
      if (action === 'add') add(token(String(a.name)), cmd.verb === 'pl' ? date(a.date) : `in ${sector(a.sectorId)}`, cmd.verb !== 'pl' && typeof a.ring === 'string' && a.ring);
      else {
        add(measure(a.measure));
        if (action === 'rename') add(text(a.name));
        else if (action === 'date') add(date(a.date));
        else if (action === 'size') add(String(a.size));
        else if (action === 'join' || action === 'leave') add(...(Array.isArray(a.units) && a.units.length ? a.units.map(unit) : fail('Expected units')));
        else if (action === 'move') { if (a.nearUnit !== undefined) add('near', unit(a.nearUnit)); else add(a.sectorId !== undefined && `to ${sector(a.sectorId)}`, String(a.ring)); }
        else if (action !== 'remove') fail(`Unknown action: ${action}`);
      }
      break;
    }
    case 'vk': add(String(a.action), a.action === 'bind' && text(a.name)); break;
    case 'intent': add(text(a.text)); break;
    case 'view': add(String(a.view)); break;
    case 'sitrep': add(a.copy === true && 'copy'); break;
    case 'help': add(typeof a.verb === 'string' && a.verb); break;
    case 'map': add(typeof a.name === 'string' && token(a.name)); break;
    case 'turn': case 'undo': case 'redo': case 'export': case 'import': break;
    default: fail(`Unknown command: ${cmd.verb}`);
  }
  return words.join(' ');
}
/** format(), or null for a Command that has no text form. */
export function tryFormat(cmd: Command, doc: Doc): string | null {
  try { return format(cmd, doc); } catch (e) { if (e instanceof FormatError) return null; throw e; }
}
