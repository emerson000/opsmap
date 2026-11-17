import type { Condition, Unit } from './types';
export function effectiveCondition(u: Unit): Condition {
  if (u.condition !== 'none') return u.condition;
  if (u.affiliation === 'hostile' && u.strength !== undefined) {
    if (u.strength === 0) return 'destroyed';
    if (u.strength < 50) return 'damaged';
  }
  return 'none';
}
/** The characters a designation may use. */
export const DESIGNATION_FORMAT=/^[A-Z0-9][A-Z0-9_-]*$/;
/**
 * The designation a title asks for: its letters and digits, at most 8 (E1, FIXSINK, PLAN2025), or NEW when
 * there are none. Only a request: it goes through claimDesignation like one typed with `as`.
 */
export function designationOfTitle(title: string): string {
  const words=title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  return words.join('').slice(0,8) || 'NEW';
}
/**
 * The one place a requested designation becomes a unit's designation, whether it was typed with `as` or made
 * from the title: every rule lives here. Free: used as is. Taken and not ending in a digit: the next free
 * number (DELTA → DELTA2). Taken and ending in a digit: refused, never renumbered.
 */
export function claimDesignation(wanted: string, taken: ReadonlySet<string>): { designation: string } | { error: string } {
  const d=wanted.trim().toUpperCase();
  if (!DESIGNATION_FORMAT.test(d)) return { error: 'Designation must use letters, numbers, underscores, or hyphens' };
  const occupied=new Set([...taken].map(x=>x.toUpperCase()));
  if (!occupied.has(d)) return { designation: d };
  if (/[0-9]$/.test(d)) return { error: `Designation ${d} is already taken` };
  let suffix=2;
  while (occupied.has(`${d}${suffix}`)) suffix++;
  return { designation: `${d}${suffix}` };
}
/**
 * For callers that must never be refused (tasks pulled from a task service): what claimDesignation gives for the title, or,
 * when it refuses a taken name that ends in a digit, that name with a free hyphen number (E1-2), which it accepts.
 */
export function freeDesignationForTitle(title: string, taken: ReadonlySet<string>): string {
  const base=designationOfTitle(title),first=claimDesignation(base,taken);
  if ('designation' in first) return first.designation;
  const occupied=new Set([...taken].map(x=>x.toUpperCase()));
  let suffix=2;
  while (occupied.has(`${base}-${suffix}`)) suffix++;
  const r=claimDesignation(`${base}-${suffix}`,taken);
  if ('error' in r) throw new Error(r.error);
  return r.designation;
}
