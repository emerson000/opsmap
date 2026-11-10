// Units this browser commanded or selected, most recent first, so the command bar can offer them first.
// Per browser tab and in memory only: another user's activity never reorders your suggestions.
import type { Command, Doc } from '../../core/model/types';

/** A unit by id, or by designation when only that is known yet (a capture's new unit). */
type Entry = { id?: string; designation?: string };
const LIMIT = 20;
export const recent = $state<{ entries: Entry[] }>({ entries: [] });

export function touchUnit(entry: Entry): void {
  if (!entry.id && !entry.designation) return;
  const same = (e: Entry) => (entry.id !== undefined && e.id === entry.id) || (entry.designation !== undefined && e.designation === entry.designation);
  recent.entries = [entry, ...recent.entries.filter(e => !same(e))].slice(0, LIMIT);
}

/** Record the unit a successful command acted on: its subject, or the unit `/new` just captured. */
export function noteCommand(cmd: Command, log: string): void {
  if (typeof cmd.args.unit === 'string') touchUnit({ id: cmd.args.unit });
  else if (cmd.verb === 'new') { const m = /^CAPTURE (\S+)/.exec(log); if (m) touchUnit({ designation: m[1] }); }
}

/** Recent unit ids that exist in this doc, most recent first. */
export function recentIds(doc: Doc): string[] {
  const ids: string[] = [];
  for (const e of recent.entries) {
    const id = e.id ?? doc.units.find(u => u.designation === e.designation)?.id;
    if (id && !ids.includes(id) && doc.units.some(u => u.id === id)) ids.push(id);
  }
  return ids;
}

export function clearRecent(): void { recent.entries = []; }
