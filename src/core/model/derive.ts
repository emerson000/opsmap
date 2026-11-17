import type { Condition, Unit } from './types';
export function effectiveCondition(u: Unit): Condition {
  if (u.condition !== 'none') return u.condition;
  if (u.affiliation === 'hostile' && u.strength !== undefined) {
    if (u.strength === 0) return 'destroyed';
    if (u.strength < 50) return 'damaged';
  }
  return 'none';
}
/**
 * A designation given with `as`: taken as is when free. When it is taken and does not end in a digit, the next free
 * numbered one (DELTA → DELTA2, DELTA3…). One that ends in a digit is never changed, so the caller rejects a duplicate.
 */
export function freeDesignation(wanted: string, taken: Set<string>): string {
  const occupied=new Set([...taken].map(d=>d.toUpperCase()));
  if (!occupied.has(wanted) || /\d$/.test(wanted)) return wanted;
  let suffix=2;
  while (occupied.has(`${wanted}${suffix}`)) suffix++;
  return `${wanted}${suffix}`;
}
/**
 * A title typed as a designation: one word of letters and digits, ending in a digit, that fits a designation
 * whole (E1, BRAVO2). `/new "E1"` then means the designation E1, with the same rule as `as E1`: never renumbered.
 */
export function titleAsDesignation(title: string): string | undefined {
  const t=title.trim().toUpperCase();
  return /^[A-Z0-9]{1,8}$/.test(t)&&/[0-9]$/.test(t)?t:undefined;
}
/**
 * A free designation made from a title: its letters and digits, at most 8. When that is taken, the next free
 * number; after a base that ends in a digit, with a hyphen (PLAN2025-2), so it never reads as another number.
 */
export function designationFrom(title: string, taken: Set<string>): string {
  const words=title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const base=words.join('').slice(0,8);
  const occupied=new Set([...taken].map(d=>d.toUpperCase()));
  if(!base){let n=1;while(occupied.has(`NEW${n}`))n++;return `NEW${n}`;}
  if (!occupied.has(base)) return base;
  const sep=/[0-9]$/.test(base)?'-':'';
  let suffix=2;
  while (occupied.has(`${base}${sep}${suffix}`)) suffix++;
  return `${base}${sep}${suffix}`;
}
