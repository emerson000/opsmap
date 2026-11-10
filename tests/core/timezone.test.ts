import { it,expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('client/server replay and parsed calendars are identical under UTC and Tokyo',()=>{
 const replay=(TZ:string)=>JSON.parse(execFileSync(process.execPath,['--import','tsx','tests/core/zoned-replay.fixture.ts'],{env:{...process.env,TZ},encoding:'utf8'}));
 const utc=replay('UTC'),tokyo=replay('Asia/Tokyo');expect(tokyo).toEqual(utc);
 expect(utc.doc.intent.date).toBe('2026-11-09');expect(utc.doc.lastTurn).toBe('2026-11-10');
 expect(utc.dates.slice(0,2)).toEqual(['2026-03-08T21:00:00.000Z','2026-11-01T22:00:00.000Z']);
});
