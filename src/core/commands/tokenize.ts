import { DEFAULT_TZ, localDay, zonedTime } from '../model/time';
/** Character offsets are retained so the command bar can underline a bad token. */
export interface Token { value: string; start: number; end: number; quoted: boolean; }
export class CommandError extends Error {
  constructor(message: string, public at = 0) { super(message); }
}
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }
    const start = i, quoted = input[i] === '"';
    let value = '';
    if (quoted) {
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i++];
        if (c === '"') { closed = true; break; }
        if (c === '\\') {
          if (i >= input.length) throw new CommandError('Incomplete escape', i - 1);
          const escaped = input[i++];
          if (escaped !== '"' && escaped !== '\\') throw new CommandError('Escape quotes or backslashes with \\', i - 2);
          value += escaped;
        } else value += c;
      }
      if (!closed) throw new CommandError('Unclosed quote', start);
      if (i < input.length && !/[\s,]/.test(input[i])) throw new CommandError('Add a space after the quoted text', i);
    } else if (input[i] === ',') { value = ','; i++; }
    else { while (i < input.length && !/[\s,]/.test(input[i])) value += input[i++]; }
    tokens.push({ value, start, end: i, quoted });
  }
  return tokens;
}
export { localDay } from '../model/time';
/** Calendar tokens are due at 1700 local; an explicit DTG retains its time. */
export function parseDate(token: string, now = new Date(), tz = DEFAULT_TZ): string {
  const key = token.toLowerCase();
  const date = new Date(localDay(now,tz)+'T00:00:00Z'); date.setUTCHours(17,0,0,0);
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  if (key === 'today') { /* same local day */ }
  else if (key === 'tmw') date.setUTCDate(date.getUTCDate()+1);
  else if (/^\+\d+d$/.test(key)) date.setUTCDate(date.getUTCDate()+Number(key.slice(1,-1)));
  else if (days.includes(key) || key === 'eow') date.setUTCDate(date.getUTCDate()+((days.indexOf(key === 'eow' ? 'fri' : key)-date.getUTCDay()+7)%7));
  else if (key === 'eom') date.setUTCMonth(date.getUTCMonth()+1,0);
  else {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
    const dtg = /^(\d{2})(\d{2})(\d{2})J([A-Z]{3})(\d{2})$/i.exec(token);
    let y: number, m: number, d: number, h = 17, min = 0;
    if (iso) { y = +iso[1]; m = +iso[2]-1; d = +iso[3]; }
    else if (dtg) { y=2000+Number(dtg[5]); m=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(dtg[4].toUpperCase()); d=+dtg[1]; h=+dtg[2]; min=+dtg[3]; }
    else throw new CommandError(`Invalid date: ${token}`);
    date.setUTCFullYear(y,m,d); date.setUTCHours(h,min,0,0);
    if (m<0 || date.getUTCFullYear()!==y || date.getUTCMonth()!==m || date.getUTCDate()!==d || h>23 || min>59) throw new CommandError(`Invalid date: ${token}`);
  }
  if (!Number.isFinite(date.getTime())) throw new CommandError(`Invalid date: ${token}`);
  return zonedTime(date,tz).toISOString();
}
