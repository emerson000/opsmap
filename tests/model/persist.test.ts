import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { load, save, exportJson, importJson } from '../../src/lib/model/persist';
import { seedDoc } from '../../src/lib/model/seed';
const KEY='opsmap.doc.v1';
let data: Map<string,string>;
beforeEach(()=>{
  data=new Map(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026,10,9,12));
  vi.stubGlobal('localStorage',{ getItem:(k:string)=>data.get(k)??null, setItem:(k:string,v:string)=>data.set(k,v), removeItem:(k:string)=>data.delete(k) });
});
afterEach(()=>{vi.runOnlyPendingTimers(); vi.useRealTimers();vi.unstubAllGlobals();});
describe('persistence',()=>{
  it('round-trips a versioned document without changing it',()=>{
    const doc=seedDoc(new Date());
    expect(importJson(exportJson(doc))).toEqual(doc);
    data.set(KEY,exportJson(doc)); expect(load()).toEqual(doc);
  });
  it.each(['{not json','null','{"version":0}', '{"version":1,"units":[]}'])('backs up corrupt or old data: %s',(bad)=>{
    data.set(KEY,bad); const doc=load();
    expect(doc.units.length).toBeGreaterThanOrEqual(15);
    expect([...data.entries()].find(([k])=>k.startsWith('opsmap.doc.corrupt.'))?.[1]).toBe(bad);
    expect(importJson(data.get(KEY)!)).toEqual(doc);
  });
  it('debounces saves by 300 ms and persists a captured snapshot',()=>{
    const doc=seedDoc(new Date()); save(doc);
    vi.advanceTimersByTime(299); expect(data.has(KEY)).toBe(false);
    const next=structuredClone(doc); next.units[0].title='Latest'; save(next);
    next.units[0].title='Later mutation';
    vi.advanceTimersByTime(300);
    expect(importJson(data.get(KEY)!).units[0].title).toBe('Latest');
  });
  it('rejects malformed version-1 data, dangling references and nonfinite positions',()=>{
    const doc=seedDoc(new Date());
    expect(()=>importJson('{"version":2}')).toThrow(/version/i);
    doc.units[0].sectorId='missing'; expect(()=>importJson(JSON.stringify(doc))).toThrow();
    doc.units[0].sectorId=doc.sectors[0].id;doc.units[0].pos.r=NaN;
    expect(()=>importJson(JSON.stringify(doc))).toThrow();
  });
  it('still loads and saves when browser storage is unavailable',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>{throw new Error('disabled');},setItem:()=>{throw new Error('full');}});
    expect(load().units.length).toBeGreaterThan(0);
    expect(()=>{save(seedDoc(new Date()));vi.advanceTimersByTime(300);}).not.toThrow();
  });
});
describe('link order persistence',()=>{
  it.each([undefined,'dependency','handoff'] as const)('round-trips a link with kind %s through save, reload, and import',kind=>{
    const doc=seedDoc(new Date());
    doc.orders.push({id:'link-test',type:'link',from:'irsrsp',to:'records',createdAt:new Date().toISOString(),...(kind?{kind}:{})});
    expect(importJson(exportJson(doc))).toEqual(doc);
    save(doc);vi.advanceTimersByTime(300);expect(load()).toEqual(doc);
  });
  it.each(['hq','obj-settled','missing'])('refuses non-unit link target %s',to=>{
    const doc=seedDoc(new Date());doc.orders.push({id:'link-test',type:'link',from:'irsrsp',to,createdAt:new Date().toISOString()});
    expect(()=>importJson(exportJson(doc))).toThrow(/link/i);
  });
  it('rejects a missing link source or an unsupported link kind',()=>{
    const doc=seedDoc(new Date());doc.orders.push({id:'link-test',type:'link',from:'missing',to:'records',createdAt:new Date().toISOString()});
    expect(()=>importJson(exportJson(doc))).toThrow();
    const bad=JSON.parse(exportJson(doc));bad.orders.at(-1).from='irsrsp';bad.orders.at(-1).kind='other';
    expect(()=>importJson(JSON.stringify(bad))).toThrow(/kind/i);
  });
});
