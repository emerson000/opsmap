// Inspector helpers shared by the views: showing a control's command in the echo bar, and opening other objects.
import type { Command, Doc } from '../../../core/model/types';
import { select, selection, type Sel } from '../../model/store.svelte';
import { echo, runCommand } from '../shell.svelte';
import { tryFormat } from '../verbs';

/** Controls that show their command as a tooltip and an accessible description, not only in the echo bar. */
const CONTROL = 'button, a, input, select, textarea, [role="radio"], [role="option"], [role="checkbox"], [role="button"], [role="menuitem"]';

/**
 * Svelte action: while the pointer is over the element or focus is inside it, the echo bar shows `text`
 * (a control's filled command). Pass null for a control with no command. On a control, the command is
 * also its tooltip (unless it has its own title) and its aria-description (unless its title holds it).
 */
export function echoes(node: HTMLElement, text: string | null) {
  let current = text;
  const control = node.matches(CONTROL), ownTitle = node.hasAttribute('title');
  // A long-press on the control shows this command in a bubble (Inspector).
  const mark = (value: string | null) => {
    if (value) node.dataset.cmd = value; else delete node.dataset.cmd;
    if (!control) return;
    if (!ownTitle) { if (value) node.title = value; else node.removeAttribute('title'); }
    if (value && !(ownTitle && node.title.includes(value))) node.setAttribute('aria-description', value); else node.removeAttribute('aria-description');
  };
  mark(text);
  // Teardown and updates can run while Svelte renders: change the echo state after that, not during it.
  const clear = (value: string | null) => queueMicrotask(() => { if (value && echo.hover === value) echo.hover = null; });
  // Focus inside a control that has its own command (a button in a field row) shows that command, not the row's.
  const on = (e: Event) => {
    if (e.type === 'focusin' && (e.target as Element | null)?.closest?.('[data-cmd]') !== node && node.contains((e.target as Element | null)?.closest?.('[data-cmd]') ?? null)) return;
    if (current) echo.hover = current;
  };
  const off = (e: Event) => {
    if (e.type === 'focusout' && node.contains((e as FocusEvent).relatedTarget as Node | null)) return;
    clear(current);
  };
  node.addEventListener('pointerenter', on);
  node.addEventListener('pointerleave', off);
  node.addEventListener('focusin', on);
  node.addEventListener('focusout', off);
  return {
    update(next: string | null) {
      const was = current; current = next; mark(next);
      queueMicrotask(() => { if (was && echo.hover === was) echo.hover = next; });
    },
    destroy() {
      clear(current);
      node.removeEventListener('pointerenter', on); node.removeEventListener('pointerleave', off);
      node.removeEventListener('focusin', on); node.removeEventListener('focusout', off);
    },
  };
}

/** The command-bar text of a Command on this doc, or null when it has none. */
export const textOf = (cmd: Command, doc: Doc): string | null => tryFormat(cmd, doc);

/** The /find text that opens this object's view from the command bar (the tooltip of a link that opens it). */
export function findOf(sel: Sel, doc: Doc): string | undefined {
  const args = sel.kind === 'unit' ? { unit: sel.id } : sel.kind === 'measure' ? { measure: sel.id } : { sectorId: sel.id };
  return tryFormat({ verb: 'find', args }, doc) ?? undefined;
}

/** Open another object's view (a unit also centers on the map through `onfocus`). */
export function open(sel: Sel | null, onfocus?: (id: string) => void, section: string | null = null): void {
  select(sel, section);
  if (sel?.kind === 'unit') onfocus?.(sel.id);
}

/** Run a control's Command as command text; true when it ran. */
export function act(cmd: Command, quiet = false): boolean { return runCommand(cmd, quiet).ok; }

export { selection };
