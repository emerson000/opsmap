// App-shell state: panels, theme, toasts and the command-bar prefill channel.
// Document changes never happen here; they go through dispatch.
import type { Command, Ring } from '../../core/model/types';
import { dispatch, type DispatchResult } from '../commands/dispatch';
import { parse } from '../commands/grammar';
import { getDoc, type Sel } from '../model/store.svelte';
import { tryFormat } from './verbs';
import { THEME_KEY, parsePref, type Theme, type ThemePref } from './theme';

export type { Theme, ThemePref } from './theme';
const LOG_KEY = 'opsmap.ui.log';
const KEYS_KEY = 'opsmap.ui.keys';

function read(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
export function write(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* storage may be disabled */ }
}

export const ui = $state({
  undoneLog: [] as {id:string;at:string;text:string;cmd?:string;undone:true}[],
  logOpen: read(LOG_KEY) === 'open' || (read(LOG_KEY) !== 'closed' && (typeof window === 'undefined' || window.innerWidth >= 1440)),
  sitrepOpen: false,
  legendOpen: false,
  /** The Vikunja account panel (connect an API token). */
  vikunjaOpen: false,
  /** The access tokens panel (MCP and API bearer tokens). */
  tokensOpen: false,
  legendTab: 'symbols' as 'symbols' | 'commands' | 'gestures' | 'keys',
  /** System unless this browser chose Day or Night. */
  themePref: parsePref(read(THEME_KEY)) as ThemePref,
  /** Bottom sheet (phone tier): which panel it shows and how tall it is. */
  sheet: 'peek' as SheetSize,
  sheetTab: 'info' as 'info' | 'log',
  /** The phone menu sheet. */
  menuOpen: false,
  /** The command input has focus (phone: the sheet hides so suggestions get the room). */
  barFocused: false,
  /** /CMD: every sidebar control shows its filled command. */
  cmdOn: read('opsmap.ui.cmd') === 'on',
  /** The Situation view's create form (a button there, or the capture menu), with the sector and ring to prefill. */
  create: null as CreateRequest | null,
  /** Single-letter keys in the sidebar (N, C, F, [ and ]); Legend → Keys turns them off. */
  singleKeys: read(KEYS_KEY) !== 'off',
  /**
   * The order composer. Set it to open the composer for a unit: the app selects that unit, opens its Orders
   * section (on a phone, the sheet at full) and prefills the composer. Any view may set it, for example an
   * area's "+ Order onto…" or a phase line's "+ Axis via…". The composer sets it back to null when it closes,
   * and selecting another object closes it.
   * - `unit`: the id of the unit that gets the order.
   * - `verb`: attack, moving, axis, support, link or advancing; left out, the first verb that applies.
   * - `target`: a target as Commands name it: a unit id, a control measure id, `hq` or `hq:‹sectorId›`.
   * - `via`: phase line ids for an axis, in order.
   */
  compose: null as Compose | null,
  /**
   * A quick menu (the area card) asks an area's view to start one of its flows: `order` (+ Order onto…: pick the
   * unit), `join` (Members, with the list of units to join) or `near` (Place, at Near). Select the area first;
   * its view starts the flow and sets this back to null.
   */
  areaFlow: null as AreaFlow | null,
});
export interface AreaFlow { measure: string; flow: 'order' | 'join' | 'near' }
export type SheetSize = 'peek' | 'half' | 'full';
export interface CreateRequest { kind: 'unit' | 'area' | 'pl' | 'sector'; sectorId?: string; ring?: Ring }
export interface Compose { unit: string; verb?: string; target?: string; via?: string[] }
/** Turn the single-letter sidebar keys on or off, for this browser. */
export function setSingleKeys(on: boolean): void { ui.singleKeys = on; write(KEYS_KEY, on ? 'on' : 'off'); }

/**
 * Screen tier, from media queries (updated live):
 * phone  = narrower than 760 px, or a short touch screen (landscape phone): one column, bottom sheets.
 * tablet = 760–1279 px: side columns, secondary top-bar items move into the menu.
 * desktop = 1280 px and up: everything inline.
 */
export type Tier = 'phone' | 'tablet' | 'desktop';
export const PHONE_QUERY = '(max-width: 759px), (max-height: 500px) and (pointer: coarse)';
export const DESKTOP_QUERY = '(min-width: 1280px)';
export const env = $state({ tier: 'desktop' as Tier, systemDark: false, coarse: false, landscape: false });
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const phone = matchMedia(PHONE_QUERY), desk = matchMedia(DESKTOP_QUERY), dark = matchMedia('(prefers-color-scheme: dark)'), coarse = matchMedia('(pointer: coarse)'), land = matchMedia('(orientation: landscape)');
  const update = () => {
    env.tier = phone.matches ? 'phone' : desk.matches ? 'desktop' : 'tablet';
    env.systemDark = dark.matches;
    env.coarse = coarse.matches;
    env.landscape = land.matches;
  };
  update();
  for (const q of [phone, desk, dark, coarse, land]) q.addEventListener?.('change', update);
}

/** Choosing System clears the override. */
export function setThemePref(pref: ThemePref): void {
  ui.themePref = pref;
  if (pref === 'system') { try { globalThis.localStorage?.removeItem(THEME_KEY); } catch { /* storage may be disabled */ } }
  else write(THEME_KEY, pref);
}
export function setLogOpen(open: boolean): void { ui.logOpen = open; write(LOG_KEY, open ? 'open' : 'closed'); }

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; text: string; kind: 'error' | 'info' | 'prompt'; action?: ToastAction }
export const toasts = $state<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'error', action?: ToastAction, ms = kind === 'prompt' ? 9000 : 4500): number {
  const id = ++toastSeq;
  toasts.push({ id, text, kind, action });
  if (toasts.length > 4) toasts.shift();
  setTimeout(() => dismissToast(id), ms);
  return id;
}
export function dismissToast(id: number): void {
  const i = toasts.findIndex(t => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

/** Ask the command bar to show text (and focus). `caret` is an offset into the text. */
export const barRequest = $state<{ seq: number; text: string; caret?: number }>({ seq: 0, text: '' });
export function prefill(text: string, caret?: number): void {
  barRequest.text = text; barRequest.caret = caret; barRequest.seq++;
}

/** The last executed order line, shown under the command bar. */
export const lastResult = $state<{ seq: number; text: string; ok: boolean }>({ seq: 0, text: '', ok: true });

/** "Assess target?" prompt after a completed attacker. */
export function assessPrompt(log: string): void {
  const m = /Assess target: (.+)$/.exec(log);
  if (!m) return;
  for (const designation of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
    toast(`Attack on ${designation} ended. Assess target?`, 'prompt', { label: `BDA ${designation}`, run: () => prefill(`/bda ${designation} `) });
  }
}

/** Dispatch from a panel or button: errors become toasts (unless quiet), the result line is published. */
export function run(cmd: Command, quiet = false): DispatchResult {
  let res: DispatchResult;
  try { res = dispatch(cmd); } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  if (res.ok) {
    lastResult.text = res.log; lastResult.ok = true; lastResult.seq++;
    assessPrompt(res.log);
  } else if (!quiet) toast(res.error);
  return res;
}

const HISTORY_KEY = 'opsmap.ui.history';
/** Commands run from the bar or the sidebar, newest first: the command bar's ↑ history. */
export const history = $state<string[]>((() => { try { const h = JSON.parse(read(HISTORY_KEY) ?? '[]'); return Array.isArray(h) ? h.filter(x => typeof x === 'string') : []; } catch { return []; } })());
/**
 * The sidebar's echo bar: the command of the hovered or focused control, else the last command run
 * (`fresh` for a few seconds after it ran). Nothing run yet: last is null.
 */
export const echo = $state({ hover: null as string | null, last: null as string | null, fresh: false });
let freshTimer: ReturnType<typeof setTimeout> | undefined;
/** A command ran: it leads the history and shows in the echo bar. */
export function remember(text: string): void {
  const i = history.indexOf(text);
  if (i >= 0) history.splice(i, 1);
  history.unshift(text);
  if (history.length > 50) history.length = 50;
  write(HISTORY_KEY, JSON.stringify(history));
  echo.last = text; echo.fresh = true;
  clearTimeout(freshTimer);
  freshTimer = setTimeout(() => (echo.fresh = false), 4000);
}

/**
 * Run command text exactly as the command bar does (its parse, then dispatch) and add it to the history.
 * Errors become toasts unless quiet; the result tells the caller either way.
 */
export function runText(text: string, quiet = false): DispatchResult {
  const parsed = parse(text, getDoc());
  if (!parsed.ok) { if (!quiet) toast(parsed.error); return parsed; }
  const res = run(parsed.cmd, quiet);
  if (res.ok) remember(text);
  return res;
}
/** A sidebar control's Command, run as its command-bar text (format); one with no text form (a drag position) runs as is. */
export function runCommand(cmd: Command, quiet = false): DispatchResult {
  const text = tryFormat(cmd, getDoc());
  return text === null ? run(cmd, quiet) : runText(text, quiet);
}

/** Collapse (false) or expand (true) every section of the open view: the `[` and `]` keys. */
export const allSections = $state({ seq: 0, open: true });
export function setAllSections(open: boolean): void { allSections.open = open; allSections.seq++; }

// ---------- map pick ----------

/** One slot of a pick's command preview: filled text, the slot being picked, or a slot still empty (grey). */
export interface PickSlot { text: string; state: 'filled' | 'active' | 'empty' }
export interface PickOptions {
  /** True when the object may be picked: the map rings what it accepts in amber and dims the rest. */
  accept: (sel: Sel) => boolean;
  /** What is being picked, for the banner: "Pick target", "Pick a task force". */
  label: string;
  /** Called with the picked object, after pick mode has ended. */
  onpick: (sel: Sel) => void;
  /** The command being built, slot by slot, for the banner. */
  slots?: PickSlot[];
  /** The banner's List button: back to the list picker (pick mode ends first). Without it, List cancels. */
  onlist?: () => void;
  /** Called when pick mode ends without a pick (Cancel, Esc, or another pick starting). */
  oncancel?: () => void;
}
/**
 * Map pick mode, for any view: `startPick({ accept, label, onpick })`.
 * While `pick.current` is set, the map rings the objects `accept` takes and dims the rest; a click or tap on an
 * accepted object picks it, Tab cycles the accepted objects and Enter picks the one Tab reached (`cursor`),
 * Esc cancels. The banner (data-testid pick-banner) shows the label, the slots, List and Cancel.
 * On a phone the sheet drops to peek during the pick and returns to its previous height after it.
 */
export const pick = $state<{ current: (PickOptions & { cursor: Sel | null }) | null }>({ current: null });
let sheetBeforePick: SheetSize | null = null;
/** Start map pick mode; a pick already running is cancelled first. */
export function startPick(options: PickOptions): void {
  if (pick.current) cancelPick();
  if (env.tier === 'phone' && !env.landscape) { sheetBeforePick = ui.sheet; ui.sheet = 'peek'; }
  pick.current = { ...options, cursor: null };
}
function endPick(): void {
  pick.current = null;
  if (sheetBeforePick) { ui.sheet = sheetBeforePick; sheetBeforePick = null; }
}
/** End pick mode without a pick. */
export function cancelPick(): void {
  const p = pick.current;
  if (!p) return;
  endPick();
  p.oncancel?.();
}
/** Pick an object: true when the pick accepts it (pick mode ends, then `onpick` runs). */
export function finishPick(sel: Sel): boolean {
  const p = pick.current;
  if (!p || !p.accept(sel)) return false;
  endPick();
  p.onpick(sel);
  return true;
}
/** The banner's List button. */
export function listPick(): void {
  const p = pick.current;
  if (!p) return;
  endPick();
  (p.onlist ?? p.oncancel)?.();
}
