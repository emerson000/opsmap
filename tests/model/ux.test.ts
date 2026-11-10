import { describe, expect, it } from 'vitest';
import ms from 'milsymbol';
import { readFileSync } from 'node:fs';
import { FUNCTIONS } from '../../src/lib/model/functions';
import { seedDoc } from '../../src/lib/model/seed';
import { toSidc } from '../../src/lib/model/sidc';
import { freeSpot, polarToXY, sectorAt } from '../../src/lib/model/geometry';
import { advanceDay } from '../../src/lib/commands/turn';
import { apply } from '../../src/lib/commands/apply';

const now=new Date(2026,10,9,12);
const names:Record<string,string>={inf:'FF.INFANTRY',armor:'ARMOUR',ca:'COMBINED ARMS',recon:'FF.RECONNAISSANCE',mi:'MILITARY INTELLIGENCE',eng:'ENGINEER',sig:'FF.SIGNAL',liaison:'LIAISON',civ:'CIVIL AFFAIRS',med:'FF.MEDICAL',mtf:'FF.MEDICAL TREATMENT FACILITY',fin:'FINANCE',sup:'FF.SUPPLY',trans:'TRANSPORTATION',maint:'MAINTENANCE',sec:'SECURITY',ad:'FF.AIR DEFENCE',mp:'MILITARY POLICE',eod:'EXPLOSIVE ORDNANCE DISPOSAL',sf:'SPECIAL FORCES',rel:'RELIGIOUS SUPPORT',learn:'INFORMATION OPERATIONS',hq:'COMMAND AND CONTROL'};
const distance=(a:{r:number;theta:number},b:{r:number;theta:number})=>{const x=polarToXY(a),y=polarToXY(b);return Math.hypot(x.x-y.x,x.y-y.y);};
describe('UX critical regressions',()=>{
 it('projects finance to the 2525E Finance entity rather than Materiel',()=>{
  const u=seedDoc(now).units.find(u=>u.fn==='fin')!;
  expect(toSidc(u).slice(10,16)).toBe('160700');
 });
 it('checks each palette metadata function against the intended name in milsymbol tables',()=>{
  const table=readFileSync('node_modules/milsymbol/src/numbersidc/sidc/landunit.js','utf8');
  for(const fn of FUNCTIONS) for(const affiliation of ['friend','hostile'] as const){
   const u={...seedDoc(now).units[0],fn:fn.key,affiliation};
   const symbol=new ms.Symbol(toSidc(u));const metadata=symbol.getMetadata();
   expect(symbol.isValid(),fn.key).toBe(true);
   const entity=metadata.functionid.slice(0,6);
   if(fn.symbolSet==='10'){
    const intended=fn.key==='med'&&affiliation==='hostile'?'CBRN':names[fn.key];
    expect(table,`${fn.key} must mean ${intended}`).toContain(`sId["${entity}"] = [icn["GR.IC.${intended}"]]`);
   }else{
    // These are the generic entities in the installation, civilian and activity sets.
    expect(entity,fn.key).toBe(fn.key==='place'?'120000':'110000');
    expect(metadata[fn.key==='place'?'installation':fn.key==='person'?'civilian':'activity'],fn.key).toBe(true);
   }
  }
 });
 it('freeSpot reserves a footprint including adjacent labels, even after repeated captures',()=>{
  const doc=seedDoc(now);doc.units=[];
  for(let i=0;i<4;i++){
   const p=freeSpot(doc,'household','near');
   for(const u of doc.units) expect(distance(p,u.pos)).toBeGreaterThanOrEqual(0.72);
   doc.units.push({...seedDoc(now).units[0],id:`t${i}`,pos:p});
  }
 });
 it('turn separates converging overdue threats and keeps them outside life HQ in the same ring',()=>{
  const doc=seedDoc(now);doc.units=Array.from({length:3},(_,i)=>({...doc.units[0],id:`t${i}`,pos:{r:2.5,theta:18},dueAt:new Date(2026,9,1).toISOString()}));
  const result=advanceDay(doc,now);
  for(const [i,u] of result.doc.units.entries()){
   expect(u.pos.r).toBeGreaterThanOrEqual(0.62);expect(u.pos.r).toBeLessThanOrEqual(1);
   expect(sectorAt(u.pos.theta,doc.sectors)?.id).toBe(u.sectorId);
   for(const v of result.doc.units.slice(0,i))expect(distance(u.pos,v.pos)).toBeGreaterThanOrEqual(0.42);
  }
 });
 it('a drop onto an occupied position resolves once inside the same sector and ring',()=>{
  const doc=seedDoc(now),target=doc.units.find(u=>u.id==='irsrsp')!;
  const result=apply(doc,{verb:'move',args:{unit:'records',...target.pos,sectorId:target.sectorId}},now);
  expect('doc'in result).toBe(true);if(!('doc'in result))return;
  const moved=result.doc.units.find(u=>u.id==='records')!;
  expect(distance(moved.pos,target.pos)).toBeGreaterThanOrEqual(0.72);
  expect(moved.pos.r).toBeGreaterThan(1);expect(moved.pos.r).toBeLessThanOrEqual(2);
 });
});
