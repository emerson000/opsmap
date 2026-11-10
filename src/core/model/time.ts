/** The calendar zone when a map has no settings.tz. Servers stamp their configured zone into every map. */
export const DEFAULT_TZ = 'UTC';
export function parts(now:Date,tz=DEFAULT_TZ):Record<string,string> {
 return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
}
export function localDay(now:Date,tz=DEFAULT_TZ):string {const p=parts(now,tz);return `${p.year}-${p.month}-${p.day}`;}
export function calendarDay(now:Date,tz=DEFAULT_TZ):number {return Date.parse(localDay(now,tz)+'T00:00:00Z');}
export function zonedTime(wall:Date,tz=DEFAULT_TZ):Date {
 let value=wall.getTime();
 for(let n=0;n<4;n++){const p=parts(new Date(value),tz);const represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);const delta=wall.getTime()-represented;if(!delta)break;value+=delta;}
 return new Date(value);
}
