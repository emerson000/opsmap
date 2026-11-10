import { mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Maps } from './maps';
import { parts } from '../src/core/model/time';
/** Calendar day and hour in a zone. */
export function zonedDay(now:Date,tz:string):{day:string;hour:number} {
  const p=parts(now,tz);
  return {day:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};
}
export function schedulerTick(maps:Maps,dataDir:string,now=new Date()) {
  const store=maps.store;
  store.db.prepare('DELETE FROM sessions WHERE expires_at<? OR created_at<?').run(now.toISOString(),new Date(now.getTime()-86400000).toISOString());
  // Each map takes its own morning turn at 04:00 in its own zone; one failing map does not hold up the others.
  for(const hub of maps.hubs.values()) {
    const {day,hour}=zonedDay(now,hub.doc.settings.tz??maps.tz);
    if(hour<4||(store.lastTurn(hub.mapId)??'')>=day)continue;
    try {hub.submit('system','system',`turn:${day}:${randomUUID()}`,{verb:'turn',args:{}},now);}catch(error){
      // The doc already had today's turn (e.g. a map imported this morning): record the day, do not retry each minute.
      if(error instanceof Error&&error.message==='No change'){store.setLastTurn(hub.mapId,day);continue;}
      console.error('Daily turn failed',hub.mapId,error instanceof Error?error.message:'Unknown error');}
  }
  // Backups follow the server's zone.
  const {day,hour}=zonedDay(now,maps.tz);
  if(hour<4||store.meta('last_backup')===day)return;
  const dir=join(dataDir,'backups');mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,`opsmap-${day}.db`);
  if(!existsSync(file)) {
    const temporary=`${file}.tmp`;if(existsSync(temporary))unlinkSync(temporary);
    store.db.prepare('VACUUM INTO ?').run(temporary);renameSync(temporary,file);
  }
  store.setMeta('last_backup',day);
  const backups=readdirSync(dir).filter(f=>/^opsmap-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for(const old of backups.slice(0,-14))unlinkSync(join(dir,old));
}
