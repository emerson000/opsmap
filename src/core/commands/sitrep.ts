import type { Affiliation, Doc, Unit } from '../model/types';
import { formatDtg } from '../model/sidc';
import { localDay, zonedTime } from '../model/time';
import { turnDetails, staleFriendly } from './turn';
import { unresolved } from './resolve';

const IDENTITY_ORDER: Affiliation[] = ['hostile', 'suspect', 'pending', 'unknown', 'friend', 'assumed', 'neutral'];
const list = (names: string[]) => names.join(', ');
/** "hostile A, B; friend C" — designations grouped by identity, threats first. */
function byIdentity(units: Unit[]): string {
  return IDENTITY_ORDER.map(a => [a, units.filter(u => u.affiliation === a).map(u => u.designation)] as const)
    .filter(([, names]) => names.length).map(([a, names]) => `${a} ${list(names)}`).join('; ');
}

/**
 * The five-paragraph situation report: one heading per paragraph, plain sentences under it. Changes are
 * summarized from the map as it stands (what opened, closed, was ordered or drawn since the morning turn or
 * the last 24 hours), not replayed from the log: something opened and dropped again leaves no trace.
 */
export function sitrepText(doc: Doc, now: Date = new Date()): string {
  const tz = doc.settings.tz, today = localDay(now, tz);
  const name = (u: Unit) => u.designation;
  const active = doc.units.filter(unresolved), enemies = active.filter(u => u.affiliation === 'hostile' || u.affiliation === 'suspect');
  const close = enemies.filter(u => u.pos.r <= 2), overdue = enemies.filter(u => u.dueAt && localDay(new Date(u.dueAt), tz) < today);
  const blocked = active.filter(u => u.affiliation === 'friend' && u.lifecycle === 'blocked');
  const stale = active.filter(u => staleFriendly(u, now));
  const sector = (id: string) => doc.sectors.find(s => s.id === id)?.name.toUpperCase() ?? '';
  const target = (id: string) => doc.units.find(x => x.id === id)?.designation ?? (() => { const m = doc.measures.find(x => x.id === id); return m ? `${m.type.toUpperCase()} ${m.name}` : id === 'hq' ? 'HQ' : id; })();

  const enemy = [
    close.length ? `Inside PL WEEK (${close.length}): ${list(close.map(u => `${name(u)} ${u.affiliation === 'suspect' ? 'suspect' : `${u.strength ?? 100}%`}`))}.` : 'No hostiles or suspects inside PL WEEK.',
    overdue.length ? `Overdue, inside HQ (${overdue.length}): ${list(overdue.map(name))}.` : 'None overdue.',
  ];
  const mains = doc.orders.filter(o => o.type === 'attack' && o.role === 'main').flatMap(o => {
    const u = doc.units.find(x => x.id === o.from);
    return u ? [`Main effort ${sector(u.sectorId)}: ${name(u)} (${u.echelon ?? 'unsized'}) ${o.planned ? 'planned against' : 'attacking'} ${target(o.to)}.`] : [];
  });
  const friendly = [
    ...(mains.length ? mains : ['No main effort assigned.']),
    blocked.length ? `Blocked: ${list(blocked.map(u => `${name(u)} (${u.note || 'no reason recorded'})`))}.` : 'Nothing blocked.',
    ...(stale.length ? [`No contact for 3+ days: ${list(stale.map(name))}.`] : []),
  ];
  const keyTerrain = active.filter(u => u.keyTerrain).map(u => {
    const threats = enemies.filter(h => h.sectorId === u.sectorId && Math.abs(h.pos.r - u.pos.r) <= 1);
    return `${name(u)}: ${threats.length ? `threatened by ${list(threats.map(name))} (within one ring)` : 'no threat within one ring'}.`;
  });

  // Changes since the morning turn, or the last 24 hours if that is shorter.
  const turnStart = doc.lastTurn ? zonedTime(new Date(`${doc.lastTurn}T04:00:00Z`), tz).getTime() : 0;
  const since = Math.max(now.getTime() - 86400000, turnStart);
  const within = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return t >= since && t <= now.getTime(); };
  const entries = doc.log.filter(e => within(e.at) && e.id !== 'log-seed' && !e.cmd?.startsWith('{"verb":"turn"'));
  const opened = doc.units.filter(u => within(u.createdAt) && unresolved(u));
  const closed = doc.units.filter(u => (u.lifecycle === 'done' || u.lifecycle === 'dropped') && within(u.updatedAt));
  const completed = closed.filter(u => u.lifecycle === 'done' && u.affiliation !== 'hostile' && u.affiliation !== 'suspect');
  const destroyed = closed.filter(u => u.lifecycle === 'done' && (u.affiliation === 'hostile' || u.affiliation === 'suspect'));
  const withdrawn = closed.filter(u => u.lifecycle === 'dropped');
  const kinds: Record<string, string> = { attack: 'attack', axis: 'axis', advance: 'advancing on', move: 'moving to', link: 'linked to', support: 'supporting' };
  const orders = doc.orders.filter(o => within(o.createdAt)).flatMap(o => {
    const from = doc.units.find(u => u.id === o.from);
    if (!from) return [];
    const kind = o.type === 'attack' ? `${o.role === 'main' ? 'main' : 'supporting'} attack →` : `${kinds[o.type] ?? o.type} →`;
    return [`${name(from)} ${kind} ${target(o.to)}${o.planned ? ' (planned)' : ''}`];
  });
  // Control measures have no timestamps: read the log, then keep only what still holds (added and still
  // there, removed and still gone).
  const measureLine = /^(OBJ|EA|NAI|PL) (.+) (ESTABLISHED|REMOVED)$/;
  const present = new Set(doc.measures.map(m => `${m.type.toUpperCase()} ${m.name.toUpperCase()}`));
  const added = new Set<string>(), removed = new Set<string>();
  for (const e of entries) {
    const m = measureLine.exec(e.text);
    if (!m) continue;
    const key = `${m[1]} ${m[2].toUpperCase()}`;
    // Drawn and removed again in the window cancels out.
    if (m[3] === 'ESTABLISHED') { if (!removed.delete(key)) added.add(key); } else if (!added.delete(key)) removed.add(key);
  }
  const addedNow = [...added].filter(k => present.has(k)), removedNow = [...removed].filter(k => !present.has(k));
  const listed = new Set([...opened, ...closed].map(u => u.id));
  const others = doc.units.filter(u => !listed.has(u.id) && within(u.updatedAt));
  const crossings = turnDetails(doc).crossings.map(c => `${doc.units.find(u => u.id === c.unitId)?.designation ?? c.unitId} crossed PL ${c.pl}`);
  const changes = [
    ...(opened.length ? [`New (${opened.length}): ${byIdentity(opened)}.`] : []),
    ...(closed.length ? [`Closed (${closed.length}): ${[completed.length && `completed ${list(completed.map(name))}`, destroyed.length && `destroyed ${list(destroyed.map(name))}`, withdrawn.length && `withdrawn ${list(withdrawn.map(name))}`].filter(Boolean).join('; ')}.`] : []),
    ...(orders.length ? [`Orders given: ${orders.join('; ')}.`] : []),
    ...(addedNow.length || removedNow.length ? [`Control measures: ${[addedNow.length && `added ${list(addedNow)}`, removedNow.length && `removed ${list(removedNow)}`].filter(Boolean).join('; ')}.`] : []),
    ...(crossings.length ? [`Morning turn: ${crossings.join('; ')}.`] : []),
    ...(others.length ? [`Also updated: ${others.length} other unit${others.length === 1 ? '' : 's'} (${list(others.slice(0, 8).map(name))}${others.length > 8 ? ', …' : ''}).`] : []),
  ];
  const span = since === turnStart ? 'SINCE THE 0400 TURN' : 'LAST 24 H';
  const intent = doc.intent?.date === today ? doc.intent.text : 'None set (/intent "…").';

  const section = (title: string, lines: string[]) => [title, ...lines.map(l => `   ${l}`)];
  return [
    `SITREP ${formatDtg(now, tz)}`,
    ...section('1. ENEMY', enemy),
    ...section('2. FRIENDLY', friendly),
    ...section('3. TERRAIN', keyTerrain.length ? keyTerrain : ['No key terrain marked.']),
    ...section(`4. CHANGES ${span}${entries.length ? ` (${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'})` : ''}`, changes.length ? changes : ['No changes recorded.']),
    ...section("5. COMMANDER'S INTENT TODAY", [intent]),
  ].join('\n');
}
