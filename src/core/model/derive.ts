import type { Condition, Unit } from './types';
export function effectiveCondition(u: Unit): Condition {
  if (u.condition !== 'none') return u.condition;
  if (u.affiliation === 'hostile' && u.strength !== undefined) {
    if (u.strength === 0) return 'destroyed';
    if (u.strength < 50) return 'damaged';
  }
  return 'none';
}
export function designationFrom(title: string, taken: Set<string>): string {
  const words=title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const base=words.join('').slice(0,8);
  const occupied=new Set([...taken].map(d=>d.toUpperCase()));
  if(!base){let n=1;while(occupied.has(`NEW${n}`))n++;return `NEW${n}`;}
  if (!occupied.has(base)) return base;
  let suffix=2;
  while (occupied.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}
