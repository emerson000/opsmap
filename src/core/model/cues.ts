// Which sound, if any, a change to the map deserves. Pure, so it is testable; the browser plays it.
// Only three events speak: a new track, a new (or newly identified) hostile track, and a hostile destroyed.
import type { Doc, Unit } from './types';

export type Cue = 'track' | 'hostile' | 'splash';

const threat = (u: Unit) => u.affiliation === 'hostile' || u.affiliation === 'suspect';
const destroyed = (u: Unit) => u.lifecycle === 'done' || u.condition === 'destroyed';

/** The one cue for the change from `before` to `after`, the most urgent first: hostile, then splash, then track. */
export function cueFor(before: Doc, after: Doc): Cue | null {
  const old = new Map(before.units.map(u => [u.id, u]));
  let cue: Cue | null = null;
  for (const u of after.units) {
    const was = old.get(u.id);
    if (!was) {
      if (u.lifecycle === 'done' || u.lifecycle === 'dropped') continue;
      if (threat(u)) return 'hostile';
      cue = cue ?? 'track';
      continue;
    }
    if (threat(u) && !threat(was) && !destroyed(u)) return 'hostile';
    if (threat(u) && destroyed(u) && !destroyed(was)) cue = 'splash';
  }
  return cue;
}
