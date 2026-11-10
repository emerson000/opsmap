// Plain-word labels for model values, shared by the inspector, legend and lists.
import type { Affiliation, Condition, Doc, Lifecycle, Order, Ring, Unit } from '../../core/model/types';
import { ringOfRadius } from '../map/interaction';
import { ECHELONS } from '../../core/model/echelon';
import { forceRatio } from '../../core/model/forceRatio';

export const AFFILIATIONS: { key: Affiliation; label: string; digit: string; meaning: string }[] = [
  { key: 'pending', label: 'Pending', digit: '0', meaning: 'Captured, not looked at' },
  { key: 'unknown', label: 'Unknown', digit: '1', meaning: 'On the radar, not assessed' },
  { key: 'assumed', label: 'Assumed friend', digit: '2', meaning: 'Probably helpful, not confirmed' },
  { key: 'friend', label: 'Friend', digit: '3', meaning: 'My own effort or asset' },
  { key: 'neutral', label: 'Neutral', digit: '4', meaning: 'Outside party or constraint' },
  { key: 'suspect', label: 'Suspect', digit: '5', meaning: 'Probably a problem (a risk)' },
  { key: 'hostile', label: 'Hostile', digit: '6', meaning: 'A confirmed problem' },
];
export const AFF_LABEL = Object.fromEntries(AFFILIATIONS.map(a => [a.key, a.label])) as Record<Affiliation, string>;
export const AFF_SHORT: Record<Affiliation, string> = { pending: 'PEN', unknown: 'UNK', assumed: 'AFR', friend: 'FR', neutral: 'NEU', suspect: 'SUS', hostile: 'HOS' };

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = { todo: 'To do', active: 'Active', blocked: 'Blocked', done: 'Done', dropped: 'Dropped' };
export const CONDITIONS: { key: Condition; label: string; token: string }[] = [
  { key: 'none', label: 'Not assessed', token: 'none' },
  { key: 'fully-capable', label: 'Fully capable', token: 'fc' },
  { key: 'damaged', label: 'Damaged (slash)', token: 'dmg' },
  { key: 'destroyed', label: 'Destroyed (X)', token: 'des' },
  { key: 'full', label: 'Full to capacity', token: 'full' },
];
export const RINGS: { key: Ring; label: string; horizon: string; pl: string }[] = [
  { key: 'hq', label: 'HQ perimeter', horizon: 'today / overdue', pl: 'PL TODAY' },
  { key: 'near', label: 'Close', horizon: '≤ 7 days', pl: 'PL WEEK' },
  { key: 'mid', label: 'Deep', horizon: '8–30 days', pl: 'PL MONTH' },
  { key: 'far', label: 'Area of interest', horizon: '31–90 days', pl: 'PL QUARTER' },
  { key: 'beyond', label: 'Beyond (off map)', horizon: '> 90 days', pl: 'edge chevron' },
];
export const ringOf = (u: Unit): Ring => ringOfRadius(u.pos.r);
export const echelonRange = (key?: string) => ECHELONS.find(e => e.key === key)?.range ?? 'unknown effort';
export const echelonMark = (key?: string) => ECHELONS.find(e => e.key === key)?.mark ?? '—';

/** Combat-effectiveness band for K. */
export function band(strength: number | undefined): 'green' | 'amber' | 'red' | 'black' | null {
  if (strength === undefined) return null;
  return strength >= 85 ? 'green' : strength >= 70 ? 'amber' : strength >= 50 ? 'red' : 'black';
}

export function unitLabel(u: Unit): string {
  return `${u.designation} (${AFF_SHORT[u.affiliation]}${u.echelon ? ` ${u.echelon.toUpperCase()}` : ''})`;
}

/** One line per order, from the point of view of `unitId`. */
export function orderLine(doc: Doc, o: Order, unitId: string): { text: string; otherId: string | null; ratio?: { text: string; under: boolean } } {
  const name = (id: string) => id === 'hq' ? 'HQ' : id.startsWith('hq:') ? `${doc.sectors.find(s => s.id === id.slice(3))?.name.toUpperCase() ?? ''} HQ` : doc.units.find(u => u.id === id)?.designation ?? doc.measures.find(m => m.id === id)?.name ?? id;
  const outgoing = o.from === unitId;
  const otherId = outgoing ? o.to : o.from;
  const verb = o.type === 'attack' ? (o.role === 'main' ? 'Main attack' : 'Supporting attack')
    : o.type === 'advance' ? 'Advancing' : o.type === 'axis' ? 'Axis of advance' : o.type === 'move' ? 'Moving' : `Linkup${o.kind ? ` (${o.kind})` : ''}`;
  const text = outgoing ? `${verb} → ${name(o.to)}` : `${verb} ← ${name(o.from)}`;
  const ratio = o.type === 'attack' ? forceRatio(doc, o.to) ?? undefined : undefined;
  return { text: `${text}${o.planned ? ' · planned' : ''}`, otherId: otherId === 'hq' || otherId.startsWith('hq:') || !doc.units.some(u => u.id === otherId) ? null : otherId, ratio };
}

/** The first unit designation that appears in a log line (for click-to-select). */
export function unitInLine(doc: Doc, text: string): string | null {
  const words = new Set(text.toUpperCase().split(/[^A-Z0-9_-]+/));
  // Prefer the earliest mention.
  let best: { id: string; at: number } | null = null;
  for (const u of doc.units) {
    if (!words.has(u.designation)) continue;
    const at = text.toUpperCase().search(new RegExp(`(^|[^A-Z0-9_-])${u.designation.replace(/[-]/g, '\\-')}([^A-Z0-9_-]|$)`));
    if (at >= 0 && (!best || at < best.at)) best = { id: u.id, at };
  }
  return best?.id ?? null;
}

export const quoteName = (name: string) => (/\s/.test(name) ? JSON.stringify(name) : name);
