import type { Doc } from '../model/types';
import { formatDtg } from '../model/sidc';
import { localDay, zonedTime } from '../model/time';
import { turnDetails, staleFriendly } from './turn';
import { unresolved } from './resolve';
export function sitrepText(doc:Doc,now:Date=new Date()):string {
 const active=doc.units.filter(unresolved),enemies=active.filter(u=>u.affiliation==='hostile'||u.affiliation==='suspect');
 const close=enemies.filter(u=>u.pos.r<=2),overdue=enemies.filter(u=>u.dueAt&&localDay(new Date(u.dueAt),doc.settings.tz)<localDay(now,doc.settings.tz));
 const blocked=active.filter(u=>u.affiliation==='friend'&&u.lifecycle==='blocked');
 const stale=active.filter(u=>staleFriendly(u,now));
 const mains=doc.orders.filter(o=>o.type==='attack'&&o.role==='main').map(o=>{const u=doc.units.find(x=>x.id===o.from),t=doc.units.find(x=>x.id===o.to)??doc.measures.find(x=>x.id===o.to);if(!u)return '';return `Main effort ${doc.sectors.find(s=>s.id===u.sectorId)?.name.toUpperCase()} = ${u.designation} (${u.echelon??'unknown'}), ${o.planned?'planned against':'attacking'} ${t?('designation'in t?t.designation:t.name):'unknown'}`;}).filter(Boolean);
 const terrain=active.filter(u=>u.keyTerrain).map(u=>{const threats=enemies.filter(h=>h.sectorId===u.sectorId&&Math.abs(h.pos.r-u.pos.r)<=1);return `${u.designation} — ${threats.length?`threat inside 1 ring: ${threats.map(h=>h.designation).join(', ')}`:'no threat inside 1 ring'}`;});
 const turnStart=doc.lastTurn?zonedTime(new Date(`${doc.lastTurn}T04:00:00Z`),doc.settings.tz).getTime():0;
 const since=Math.max(now.getTime()-86400000,turnStart);
 const changes=doc.log.filter(e=>Date.parse(e.at)>=since&&Date.parse(e.at)<=now.getTime()&&e.id!=='log-seed'&&!e.cmd?.startsWith('{"verb":"turn"')).map(e=>e.text);
 const crossings=turnDetails(doc).crossings.map(c=>`${doc.units.find(u=>u.id===c.unitId)?.designation??c.unitId} crossed PL ${c.pl}`);
 return [
  `SITREP ${formatDtg(now,doc.settings.tz)}${stale.length?` — ${stale.length} NO CONTACT 3D`:''}`,
  `1. ENEMY: ${close.length} ${close.length===1?'hostile/suspect':'hostiles/suspects'} inside PL WEEK (${close.map(u=>`${u.designation} ${u.affiliation==='suspect'?'suspect':`${u.strength??100}%`}`).join(', ')||'none'}). ${overdue.length} overdue${overdue.length?`: ${overdue.map(u=>u.designation).join(', ')}`:''} (PEN).`,
  `2. FRIENDLY: ${mains.join('. ')||'No main effort assigned'}. ${blocked.length} blocked (slash)${blocked.length?`: ${blocked.map(u=>`${u.designation} (${u.note??'no reason recorded'})`).join(', ')}`:''}.`,
  `3. TERRAIN: Key terrain ${terrain.join('; ')||'none marked'}.`,
  `4. CHANGES LAST 24H: ${changes.length?changes.join('; '):'No changes recorded'}${crossings.length?`. ${crossings.join('; ')}`:''}.`,
  `5. CDR'S INTENT TODAY: ${doc.intent?.date===localDay(now,doc.settings.tz)?doc.intent.text:'<state today’s intent>'}`,
 ].join('\n');
}
