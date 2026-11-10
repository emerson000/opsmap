import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { apply } from '../../src/core/commands/apply';
import { parse } from '../../src/core/commands/grammar';
import { emptyDoc, seedDoc } from '../../src/core/model/seed';
import { createInverse, touchedEntities } from '../../src/core/model/patch';
import { importJson } from '../../src/core/model/json';
import type { ApplyResult } from '../../src/core/commands/apply';
import type { Command, Doc } from '../../src/core/model/types';

const now=new Date(2026,10,9,12);
function success(result:ApplyResult) {
  if('error' in result)throw new Error(result.error);
  return result;
}
function command(input:string,doc:Doc):Command {
  const parsed=parse(input,doc,{now});
  if(!parsed.ok)throw new Error(parsed.error);
  return parsed.cmd;
}
afterEach(()=>vi.useRealTimers());

describe('shared core isolation',()=>{
  it('contains no browser globals, Svelte imports, or dependencies back into lib',()=>{
    const root=resolve('src/core');
    const files=(path:string):string[]=>readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(path,entry.name)):[join(path,entry.name)]);
    const violations:string[]=[];
    for(const path of files(root).filter(path=>path.endsWith('.ts'))) {
      const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
      const visit=(node:ts.Node)=>{
        if(ts.isIdentifier(node)&&['window','localStorage','document','navigator','$state','$derived','$effect'].includes(node.text))violations.push(`${path}: ${node.text}`);
        if(ts.isStringLiteral(node)) {
          const value=node.text;
          if(value==='svelte'||value.startsWith('svelte/'))violations.push(`${path}: ${value}`);
          if(value.startsWith('.')&&resolve(dirname(path),value).startsWith(resolve('src/lib')))violations.push(`${path}: ${value}`);
          if(['window','localStorage'].includes(value))violations.push(`${path}: ${value}`);
        }
        ts.forEachChild(node,visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
  it('uses explicit parse time and selection, independent of the wall clock',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date(2040,0,1));
    const doc=seedDoc(now);
    const result=parse('/new "Review" due +3d',doc,{now,selectedId:'q4rpt'});
    expect(result.ok).toBe(true);
    if(result.ok)expect(result.cmd.args).toMatchObject({sectorId:'work',dueAt:new Date(2026,10,12,17).toISOString()});
  });
});

describe('op replay',()=>{
  it('replays recorded commands, times, and actors from an empty map exactly',()=>{
    let doc=emptyDoc();
    const recorded:{cmd:Command;at:string;actor:string}[]=[];
    const history:Doc[]=[];
    const texts=[
      '/new hostile fin "Tax" in Household due +3d as TAX',
      '/new friend inf "Response" in Household near as RSP',
      '/new friend recon "Records" in Household near as REC',
      '/attack RSP TAX main','/attack REC TAX main','/size RSP plt',
      '/intent "Finish response"','/sector width Work 90',
      '/obj add "FILED" in Household near','/axis RSP to OBJ "FILED"',
      '/note TAX "Verify assessment"','/turn','/done RSP','/turn',
    ];
    for(const [i,input] of texts.entries()) {
      const at=new Date(2026,10,9+(i>=11?i-10:0),12).toISOString();
      const cmd=command(input,doc),actor=i%2?'bob':'alice';
      const before=JSON.stringify(doc),cmdBefore=JSON.stringify(cmd);
      const result=success(apply(doc,cmd,new Date(at),actor));
      expect(JSON.stringify(doc)).toBe(before);expect(JSON.stringify(cmd)).toBe(cmdBefore);
      doc=result.doc;recorded.push({cmd,at,actor});history.push(doc);
    }
    vi.useFakeTimers();vi.setSystemTime(new Date(2040,0,1));
    let replayed=emptyDoc();
    for(const [i,op] of recorded.entries()) {
      replayed=success(apply(replayed,JSON.parse(JSON.stringify(op.cmd)),new Date(op.at),op.actor)).doc;
      expect(replayed).toEqual(history[i]);
    }
    expect(replayed).toEqual(doc);
  });
  it('replays imports and resolved reverts as ordinary ops',()=>{
    const start=emptyDoc(),imported=seedDoc(now);
    const op:Command={verb:'import',args:{doc:imported}};
    const first=success(apply(start,op,now,'alice'));
    const revert:Command={verb:'revert',args:{seq:1,inverse:createInverse(start,first.touched)}};
    const second=success(apply(first.doc,revert,now,'bob'));
    const replayFirst=success(apply(emptyDoc(),JSON.parse(JSON.stringify(op)),now,'alice'));
    expect(success(apply(replayFirst.doc,JSON.parse(JSON.stringify(revert)),now,'bob'))).toEqual(second);
    expect(second.doc.units).toEqual([]);
  });
});

describe('attribution and touched entities',()=>{
  it('attributes creation and later edits without changing the original author',()=>{
    const first=success(apply(emptyDoc(),{verb:'new',args:{title:'Review'}},now,'alice'));
    expect(first.doc.units[0]).toMatchObject({createdBy:'alice',updatedBy:'alice'});
    expect(first.touched).toEqual({units:['u1'],orders:[],measures:[],sectors:[],top:[]});
    const second=success(apply(first.doc,{verb:'note',args:{unit:'u1',note:'Ready'}},now,'bob'));
    expect(second.doc.units[0]).toMatchObject({createdBy:'alice',updatedBy:'bob'});
    expect(importJson(JSON.stringify(second.doc))).toEqual(second.doc);
    expect(apply(first.doc,{verb:'note',args:{unit:'u1',note:'Ready'}},now,'')).toHaveProperty('error');
  });
  it('includes main-effort demotions and boundary cancellation of orders',()=>{
    const doc=seedDoc(now);
    const attack=success(apply(doc,command('/attack RECORDS IRS main',doc),now,'bob'));
    expect(attack.touched.orders).toContain(doc.orders.find(o=>o.from==='irsrsp'&&o.type==='attack')!.id);
    const move=success(apply(doc,command('/move IRS to Work near',doc),now,'bob'));
    for(const order of doc.orders.filter(o=>o.to==='irs'))expect(move.touched.orders).toContain(order.id);
  });
  it('attributes indirectly moved units and turn changes while leaving other units alone',()=>{
    const doc=seedDoc(now);
    const width=success(apply(doc,command('/sector width Work 100',doc),now,'alice'));
    for(const id of width.touched.units)expect(width.doc.units.find(u=>u.id===id)?.updatedBy).toBe('alice');
    const turn=success(apply(doc,{verb:'turn',args:{}},new Date(2026,10,12,6),'system'));
    expect(turn.touched.top).toContain('lastTurn');expect(turn.touched.units.length).toBeGreaterThan(0);
    for(const id of turn.touched.units)expect(turn.doc.units.find(u=>u.id===id)?.updatedBy).toBe('system');
  });
  it('does not count append-only audit log entries as undo conflicts',()=>{
    const doc=seedDoc(now),next=structuredClone(doc);
    next.log.push({id:'audit',at:now.toISOString(),text:'Audit'});
    expect(touchedEntities(doc,next)).toEqual({units:[],orders:[],measures:[],sectors:[],top:[]});
    expect(success(apply(doc,{verb:'help',args:{}},now)).touched.top).toEqual([]);
  });
});

describe('inverse patches and validation',()=>{
  it.each([
    '/new "Capture"','/attack RECORDS IRS main','/move IRS to Work near',
    '/sector remove Work reassign Household','/pl remove LAUNCH',
    '/intent "Finish response"','/view detail','/turn',
  ])('restores domain state for %s and permits redo by reverting the revert',input=>{
    const before=seedDoc(now),applied=success(apply(before,command(input,before),now));
    const inverse=JSON.parse(JSON.stringify(createInverse(before,applied.touched)));
    const inverseBefore=JSON.stringify(inverse);
    const reverted=success(apply(applied.doc,{verb:'revert',args:{seq:1,inverse}},now));
    expect({...reverted.doc,log:before.log}).toEqual(before);
    const redone=success(apply(reverted.doc,{verb:'revert',args:{seq:2,inverse:createInverse(applied.doc,reverted.touched)}},now));
    expect({...redone.doc,log:applied.doc.log}).toEqual(applied.doc);
    expect(JSON.stringify(inverse)).toBe(inverseBefore);
  });
  it('preserves unrelated later edits when reverting an entity',()=>{
    const before=seedDoc(now),one=success(apply(before,command('/note IRS "First"',before),now));
    const two=success(apply(one.doc,command('/note TOOLS "Other user"',one.doc),now));
    const undone=success(apply(two.doc,{verb:'revert',args:{seq:1,inverse:createInverse(before,one.touched)}},now));
    expect(undone.doc.units.find(u=>u.id==='tools')?.note).toBe('Other user');
    expect(undone.doc.units.find(u=>u.id==='irs')).toEqual(before.units.find(u=>u.id==='irs'));
  });
  it('undoes complete replacements including entity order and preserves original creators',()=>{
    const before=seedDoc(now);
    before.units[0].createdBy='alice';
    const replacement=structuredClone(before);
    replacement.units.reverse();
    const imported=success(apply(before,{verb:'import',args:{doc:replacement}},now,'bob'));
    const undone=success(apply(imported.doc,{verb:'revert',args:{seq:1,inverse:createInverse(before,imported.touched)}},now));
    expect(undone.doc).toEqual(before);
    const empty=success(apply(before,{verb:'import',args:{doc:emptyDoc()}},now,'bob'));
    const restored=success(apply(empty.doc,{verb:'revert',args:{seq:2,inverse:createInverse(before,empty.touched)}},now,'bob'));
    expect(restored.doc.units[0]).toMatchObject({createdBy:'alice',updatedBy:'bob'});
  });
  it('rejects malformed inverses and invalid replacement documents atomically',()=>{
    const doc=seedDoc(now),before=JSON.stringify(doc);
    const bad=[
      {verb:'revert',args:{seq:1}},
      {verb:'revert',args:{seq:0,inverse:createInverse(doc,touchedEntities(doc,doc))}},
      {verb:'revert',args:{seq:1,inverse:{...createInverse(doc,touchedEntities(doc,doc)),top:{log:[]}}}},
      {verb:'revert',args:{seq:1,inverse:{...createInverse(doc,touchedEntities(doc,doc)),units:[{id:'irs',index:0,value:{id:'wrong'}}]}}},
      {verb:'import',args:{doc:{version:2}}},
    ];
    for(const cmd of bad)expect(apply(doc,cmd,now)).toHaveProperty('error');
    expect(JSON.stringify(doc)).toBe(before);
  });
});
