// Where things land on the map, in words, for the area, phase line, sector and create views.
import type { Doc, Ring } from '../../../core/model/types';
import { radiusForDate, ringForRadius } from '../../../core/model/geometry';
import { MAP_EDGE_R } from '../../map/constants';
import { RINGS } from '../words';

/** The rings an area can be moved to or created in (`/obj move … ‹ring›`). */
export const AREA_RINGS = RINGS.filter(r => r.key !== 'beyond');
export const ringLabel = (key: Ring | null | undefined) => RINGS.find(r => r.key === key)?.label ?? '—';

/**
 * Which ring a phase line dated `iso` lands in, or why it is not drawn (the map draws a custom line only
 * between the HQ perimeter's inner edge and the map edge).
 */
export function plRingNote(iso: string | undefined, now: Date, tz?: string): string {
  if (!iso) return 'Undated: not drawn.';
  const r = radiusForDate(iso, now, tz);
  if (r > MAP_EDGE_R) return 'Beyond the map edge: not drawn.';
  if (r <= 0.3) return 'Inside the HQ perimeter: not drawn.';
  return `Lands in the ${ringLabel(ringForRadius(r))} ring.`;
}

/** A default date for a new phase line in a ring: about the middle of the ring's time span. */
export function ringDate(ring: Ring | undefined, now: Date): string {
  const days = ({ hq: 1, near: 4, mid: 19, far: 60, beyond: 120 } as Record<Ring, number>)[ring ?? 'mid'];
  return new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
}

/** Sector widths after one sector is set to `width`: the others scale in proportion to share the rest. */
export function scaledWidths(doc: Pick<Doc, 'sectors'>, sectorId: string, width: number): { id: string; name: string; from: number; to: number }[] {
  const s = doc.sectors.find(x => x.id === sectorId);
  if (!s) return [];
  const rest = 360 - s.widthDeg;
  return doc.sectors.filter(x => x.id !== sectorId).map(x => ({ id: x.id, name: x.name, from: x.widthDeg, to: rest > 0 ? x.widthDeg * (360 - width) / rest : 0 }));
}
/** Degrees for people: whole when whole, else one decimal. */
export const deg = (n: number) => `${Math.round(n * 10) / 10}°`;
