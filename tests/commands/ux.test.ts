import { expect, it } from 'vitest';
import { suggest } from '../../src/lib/commands/suggest';
import { seedDoc } from '../../src/lib/model/seed';
const doc=seedDoc(new Date(2026,10,9,12));
const s=(text:string)=>suggest(text,text.length,doc);
it('/new advances through every optional slot, without repeating filled slots',()=>{
 expect(s('/new ').items[0].kind).toBe('identity');
 expect(s('/new hostile ').items[0].kind).toBe('echelon');
 expect(s('/new hostile coy ').items[0].kind).toBe('function');
 expect(s('/new hostile coy fin ').items[0].insert).toBe('"title"');
 expect(s('/new hostile coy fin "Tax" ').items[0].insert).toBe('in');
 expect(s('/new hostile coy fin "Tax" in ').items[0].kind).toBe('sector');
 expect(s('/new hostile coy fin "Tax" in Household ').items[0].insert).toBe('hq');
 expect(s('/new hostile coy fin "Tax" in Household near ').items.map(x=>x.insert)).toEqual(['due','as']);
 expect(s('/new hostile coy fin "Tax" in Household near due ').items[0].kind).toBe('date');
 expect(s('/new hostile coy fin "Tax" in Household near due today ').items.map(x=>x.insert)).toEqual(['as']);
 expect(s('/new hostile coy fin "Tax" in Household near due today as TAX ').items).toEqual([]);
});
it('attack suggestions exclude the attacker, friendlies and non-threat people and places',()=>{
 const items=s('/attack IRSRSP ').items;
 expect(items.some(x=>x.unitId==='irs')).toBe(true);
 for(const id of ['irsrsp','records','landlord','home'])expect(items.some(x=>x.unitId===id)).toBe(false);
 expect(items[0].unitId).toBe('irs');
});
it('unblock and attach suggestions fit their subject and target',()=>{
 expect(s('/unblock ').items.map(x=>x.unitId)).toEqual(['passport']);
 expect(s('/attach RECORDS to ').items.map(x=>x.unitId)).toEqual(['move']);
});

it('capture preview spells out the security section and designation',async()=>{
 const {parse}=await import('../../src/lib/commands/grammar');
 const result=parse('/new friend security "Walk"',doc);
 expect(result.ok).toBe(true);if(result.ok)expect(result.preview).toContain('FRIEND SECURITY SECTION');
 expect(s('/new friend sec ').ghost).toContain('sec read as size (section)');
});
it('SITREP records actual recent captures and completions, and names overdue threats',async()=>{
 const {apply}=await import('../../src/lib/commands/apply');const {sitrepText}=await import('../../src/lib/commands/sitrep');
 const now=new Date(2026,10,9,12);
 const result=apply(doc,{verb:'done',args:{unit:'irsrsp'}},now);expect('doc'in result).toBe(true);if(!('doc'in result))return;
 const text=sitrepText(result.doc,now);
 expect(text).toContain('completed IRSRSP');expect(text).toContain('Overdue, inside HQ (1): ESCALATION.');expect(text).not.toContain('1 hostiles');
});
it('/reinforce offers with after the reinforced unit, then units',()=>{
 const after=s('/reinforce TOOLS ').items;
 expect(after[0].insert).toBe('with');
 expect(after.some(i=>i.insert==='TOOLS')).toBe(false);
 expect(s('/reinforce TOOLS with ').items[0].kind).not.toBe('keyword');
});
