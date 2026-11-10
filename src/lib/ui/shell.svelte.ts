// App-shell state: panels, theme, toasts and the command-bar prefill channel.
// Document changes never happen here; they go through dispatch.
import type { Command } from '../../core/model/types';
import { dispatch, type DispatchResult } from '../commands/dispatch';
import { THEME_KEY, parsePref, type Theme, type ThemePref } from './theme';

export type { Theme, ThemePref } from './theme';
const LOG_KEY = 'opsmap.ui.log';

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
  legendTab: 'symbols' as 'symbols' | 'commands' | 'gestures',
  beyondSector: null as string | null,
  /** System unless this browser chose Day or Night. */
  themePref: parsePref(read(THEME_KEY)) as ThemePref,
  /** Bottom sheet (phone tier): which panel it shows and how tall it is. */
  sheet: 'peek' as SheetSize,
  sheetTab: 'info' as 'info' | 'log',
  /** The phone menu sheet. */
  menuOpen: false,
  /** The command input has focus (phone: the sheet hides so suggestions get the room). */
  barFocused: false,
});
export type SheetSize = 'peek' | 'half' | 'full';

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

/** Dispatch from a panel or button: errors become toasts, the result line is published. */
export function run(cmd: Command): DispatchResult {
  let res: DispatchResult;
  try { res = dispatch(cmd); } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  if (res.ok) {
    lastResult.text = res.log; lastResult.ok = true; lastResult.seq++;
    assessPrompt(res.log);
  } else toast(res.error);
  return res;
}
