import { describe, expect, it } from 'vitest';
import ms from 'milsymbol';
import type { Affiliation, Doc, Unit } from '../../src/lib/model/types';
import { ECHELONS } from '../../src/lib/model/echelon';
import { FUNCTIONS } from '../../src/lib/model/functions';
import { toSidc, renderSymbol, symbolOptions } from '../../src/lib/model/sidc';
import { effectiveCondition, designationFrom } from '../../src/lib/model/derive';
import { ringForDate, radiusForDate, snap, sectorAt, polarToXY, xyToPolar, freeSpot } from '../../src/lib/model/geometry';
import { forceRatio } from '../../src/lib/model/forceRatio';
import { seedDoc } from '../../src/lib/model/seed';

const now = new Date(2026, 10, 9, 12);
const date = (days: number) => new Date(2026, 10, 9 + days, 17);
const unit = (patch: Partial<Unit> = {}): Unit => ({ id:'u1', designation:'TEST', title:'Test', kind:'unit', affiliation:'friend', fn:'inf', echelon:'plt', lifecycle:'todo', presence:'present', condition:'none', sectorId:'work', pos:{r:2,theta:30}, createdAt:now.toISOString(), updatedAt:now.toISOString(), ...patch });

describe('SIDC projection', () => {
  it('projects canonical friend infantry and hostile finance', () => {
    expect(toSidc(unit())).toBe('13031000141211000000');
    expect(toSidc(unit({affiliation:'hostile',echelon:'coy',fn:'fin'}))).toBe('13061000151607000000');
  });
  it.each([
    [{lifecycle:'blocked'}, '3'], [{affiliation:'hostile',strength:0}, '4'],
    [{strength:0},'0'], [{presence:'planned'},'1'], [{lifecycle:'done'},'2'],
    [{affiliation:'hostile',lifecycle:'done'},'4'], [{condition:'full'},'5'], [{condition:'destroyed',lifecycle:'done'},'4'], [{condition:'destroyed',lifecycle:'blocked'},'4'],
  ] as [Partial<Unit>,string][])('maps lifecycle, presence and BDA %j', (patch, status) => {
    expect(toSidc(unit(patch))[6]).toBe(status);
  });
  it('encodes HQ and task-force bits', () => {
    expect(toSidc(unit({fn:'hq'}))[7]).toBe('2');
    expect(toSidc(unit({taskForce:true}))[7]).toBe('4');
    expect(toSidc(unit({fn:'hq',taskForce:true}))[7]).toBe('6');
  });
  for (const affiliation of ['pending','unknown','assumed','friend','neutral','suspect','hostile'] as Affiliation[]) {
    for (const echelon of ECHELONS) {
      it(`${affiliation} ${echelon.key}: valid in every status`, () => {
        for (const condition of ['none','fully-capable','damaged','destroyed','full'] as const) {
          const u = unit({affiliation,echelon:echelon.key,condition});
          expect(new ms.Symbol(toSidc(u), symbolOptions(u,'commander')).isValid()).toBe(true);
          expect(toSidc(u).slice(8,10)).toBe(echelon.code);
          expect(toSidc({...u,presence:'planned'})[6]).toBe('1');
          expect(new ms.Symbol(toSidc({...u,presence:'planned'})).isValid()).toBe(true);
        }
      });
    }
  }
  it('validates every palette function with friendly and hostile identities', () => {
    for (const fn of FUNCTIONS) for (const affiliation of ['friend','hostile'] as const) {
      expect(new ms.Symbol(toSidc(unit({fn:fn.key,affiliation}))).isValid(), fn.key).toBe(true);
    }
  });
  it('honors overrides and hides unknown echelon', () => {
    expect(toSidc(unit({echelon:undefined})).slice(8,10)).toBe('00');
    expect(toSidc(unit({sidcOverride:'13061000151612000000'}))).toBe('13061000151612000000');
  });
  it('uses view-specific amplifiers and bounded cached render results', () => {
    const u=unit({note:'Waiting',rating:'B2',strength:60,reinforced:'+',dueAt:date(3).toISOString()});
    expect(symbolOptions(u,'commander')).toMatchObject({simpleStatusModifier:true,uniqueDesignation:'TEST'});
    expect(symbolOptions(u,'commander').combatEffectiveness).toBeUndefined();
    expect(symbolOptions(u,'staff')).toMatchObject({combatEffectiveness:'60%',reinforcedReduced:'(+)'});
    expect(symbolOptions(u,'staff').staffComments).toBeUndefined();
    expect(symbolOptions(u,'detail')).toMatchObject({staffComments:'Waiting',evaluationRating:'B2'});
    const result = renderSymbol(u,'detail',40);
    expect(result.svg).toContain('<svg');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(Number.isFinite(result.anchor.x)).toBe(true);
    expect(renderSymbol(u,'detail',40)).toBe(result);
  });
});

describe('derived fields', () => {
  it('derives strength conditions only for hostiles; explicit conditions win', () => {
    expect(effectiveCondition(unit({strength:0}))).toBe('none');
    expect(effectiveCondition(unit({affiliation:'suspect',strength:0}))).toBe('none');
    expect(effectiveCondition(unit({affiliation:'hostile',strength:0}))).toBe('destroyed');
    expect(effectiveCondition(unit({affiliation:'hostile',strength:49}))).toBe('damaged');
    expect(effectiveCondition(unit({affiliation:'hostile',strength:50}))).toBe('none');
    expect(effectiveCondition(unit({affiliation:'hostile',strength:0,condition:'fully-capable'}))).toBe('fully-capable');
  });
  it('derives stable unique uppercase designations even for unicode and punctuation', () => {
    const taken=new Set<string>();
    for (const title of ['Fix sink','Fix sink','École café','🔥','/','Fix sink']) {
      const d=designationFrom(title,taken);
      expect(d).toMatch(/^[A-Z0-9]+$/);
      expect(taken.has(d)).toBe(false);
      taken.add(d);
    }
    expect(designationFrom('Fix sink', new Set())).toBe(designationFrom('Fix sink',new Set()));
  });
});

describe('date geometry', () => {
  it.each([[0,'hq'],[7,'near'],[8,'mid'],[30,'mid'],[31,'far'],[90,'far'],[91,'beyond'],[-1,'hq']] as const)('%i days => %s', (days, ring) => {
    expect(ringForDate(date(days),now)).toBe(ring);
  });
  it('keeps undated items far and uses local calendar days', () => {
    expect(ringForDate(undefined,now)).toBe('far');
    expect(ringForDate('2026-11-09',now)).toBe('hq');
    expect(ringForDate('2026-11-16',now)).toBe('near');
  });
  it('is monotonic, finite, and moves continuously within each band', () => {
    const radii=Array.from({length:101},(_,d)=>radiusForDate(date(d-5),now));
    expect(radii.every(Number.isFinite)).toBe(true);
    expect(radii).toEqual([...radii].sort((a,b)=>a-b));
    expect(radiusForDate(date(2),now)).toBeLessThan(radiusForDate(date(6),now));
    expect(radiusForDate(date(20),now)).toBeLessThan(radiusForDate(date(25),now));
    expect(radiusForDate(date(90),now)).toBeLessThanOrEqual(4);
    expect(radiusForDate(date(91),now)).toBeGreaterThan(4);
  });
});

describe('placement', () => {
  const sectors=[{id:'a',name:'A',startDeg:350,widthDeg:30},{id:'b',name:'B',startDeg:20,widthDeg:90}];
  it('handles wrapped sectors, crossing boundaries, gaps and off-map positions', () => {
    expect(sectorAt(0,sectors)?.id).toBe('a');
    expect(sectorAt(20,sectors)?.id).toBe('b');
    expect(snap({r:2.4,theta:35},sectors)).toEqual({r:2.4,theta:35,sectorId:'b'});
    const off=snap({r:999,theta:180},sectors);
    expect(off.r).toBeGreaterThan(4);
    expect(off.r).toBeLessThan(5);
    expect(off.sectorId).toBe('b');
    expect(sectorAt(off.theta,sectors)?.id).toBe('b');
    expect(snap({r:-3,theta:-360},sectors).r).toBeGreaterThanOrEqual(0);
    expect(()=>snap({r:1,theta:0},[])).toThrow();
    expect(()=>snap({r:NaN,theta:0},sectors)).toThrow();
  });
  it('round-trips polar coordinates and finds a free spot', () => {
    const p=xyToPolar(polarToXY({r:3,theta:310}));
    expect(p.r).toBeCloseTo(3); expect(p.theta).toBeCloseTo(310);
    const doc=seedDoc(now);
    const a=freeSpot(doc,doc.sectors[0].id,'near');
    expect(a.r).toBeGreaterThan(1); expect(a.r).toBeLessThan(2);
    expect(sectorAt(a.theta,doc.sectors)?.id).toBe(doc.sectors[0].id);
    doc.units.push(unit({pos:a,sectorId:doc.sectors[0].id}));
    expect(freeSpot(doc,doc.sectors[0].id,'near')).not.toEqual(a);
  });
});

describe('force ratio', () => {
  const docFor=(echelons: (Unit['echelon'])[]): Doc => {
    const doc=seedDoc(now);
    doc.units=[unit({id:'h',affiliation:'hostile',echelon:'coy'}),...echelons.map((echelon,i)=>unit({id:`f${i}`,echelon}))];
    doc.orders=echelons.map((_,i)=>({id:`o${i}`,type:'attack',from:`f${i}`,to:'h',role:i===0?'main':'support',createdAt:now.toISOString()}));
    return doc;
  };
  it('shows a section against a company as 1:9, under-resourced', () => expect(forceRatio(docFor(['sec']),'h')).toEqual({text:'1:9',under:true}));
  it('adds two platoons to 1:1.5, adequately resourced', () => expect(forceRatio(docFor(['plt','plt']),'h')).toEqual({text:'1:1.5',under:false}));
  it('uses a strict one-third threshold', () => expect(forceRatio(docFor(['plt']),'h')).toEqual({text:'1:3',under:false}));
  it('hides ratios when any echelon is missing or there are no attackers', () => {
    expect(forceRatio(docFor([undefined]),'h')).toBeNull();
    expect(forceRatio(docFor([]),'h')).toBeNull();
    const doc=docFor(['sec']); doc.units[0].echelon=undefined;
    expect(forceRatio(doc,'h')).toBeNull();
  });
});

describe('seed', () => {
  it('seeds every sector with valid symbols and all required demo features', () => {
    const doc=seedDoc(now);
    expect(doc.units.length).toBeGreaterThanOrEqual(15);
    expect(doc.units.length).toBeLessThanOrEqual(20);
    expect(doc.sectors.map(s=>s.name)).toEqual(['Work','Household','Family','Wellness','Productivity']);
    for (const s of doc.sectors) expect(doc.units.some(u=>u.sectorId===s.id)).toBe(true);
    for (const u of doc.units) expect(new ms.Symbol(toSidc(u),symbolOptions(u,'commander')).isValid(),u.designation).toBe(true);
    expect(new Set(doc.units.map(u=>u.designation)).size).toBe(doc.units.length);
    expect(doc.units.filter(u=>u.affiliation==='pending')).toHaveLength(3);
    expect(doc.units.some(u=>u.lifecycle==='blocked')).toBe(true);
    expect(doc.units.some(u=>u.affiliation==='hostile' && effectiveCondition(u)==='destroyed')).toBe(true);
    expect(doc.units.some(u=>u.affiliation==='suspect' && u.rating)).toBe(true);
    expect(doc.units.some(u=>u.kind==='person' && u.affiliation==='neutral')).toBe(true);
    expect(doc.units.some(u=>u.kind==='place')).toBe(true);
    expect(doc.units.some(u=>u.parentId && doc.units.some(p=>p.id===u.parentId && p.taskForce))).toBe(true);
    expect(doc.orders.some(o=>o.type==='advance' && o.to==='hq')).toBe(true);
    expect(doc.orders.some(o=>o.role==='main')).toBe(true);
    expect(doc.orders.some(o=>o.role==='support')).toBe(true);
    for(const type of ['obj','ea','nai','pl']) expect(doc.measures.some(m=>m.type===type)).toBe(true);
    expect(seedDoc(now)).toEqual(doc);
  });
});
