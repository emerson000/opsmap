import { describe, expect, it } from 'vitest';
import { suggest } from '../../src/core/commands/suggest';
import { seedDoc } from '../../src/core/model/seed';
import { clearRecent, noteCommand, recentIds, touchUnit } from '../../src/lib/commands/recent.svelte';
import type { Doc } from '../../src/core/model/types';

const now = new Date('2026-11-09T17:00:00Z');
const units = (doc: Doc, input: string, recent: string[] = []) => suggest(input, input.length, doc, { recent }).items.filter(i => i.kind === 'unit').map(i => i.insert);
const des = (doc: Doc, id: string) => doc.units.find(u => u.id === id)!.designation;

describe('unit order in suggestions', () => {
  it('puts the most recently used unit first, then its sector, then the most recently changed', () => {
    const doc = seedDoc(now);
    const irs = doc.units.find(u => u.designation === 'IRS')!;
    const list = units(doc, '/note ', [irs.id]);
    expect(list[0]).toBe('IRS');
    const sectorOf = (d: string) => doc.units.find(u => u.designation === d)!.sectorId;
    const firstOther = list.findIndex(d => sectorOf(d) !== irs.sectorId);
    expect(list.slice(1, firstOther).every(d => sectorOf(d) === irs.sectorId)).toBe(true);
    expect(list.slice(firstOther).every(d => sectorOf(d) !== irs.sectorId)).toBe(true);
    // Without recency: most recently changed first.
    doc.units.find(u => u.designation === 'TOOLS')!.updatedAt = '2026-11-09T17:30:00Z';
    expect(units(doc, '/note ')[0]).toBe('TOOLS');
  });

  it('keeps each verb’s own groups ahead of recency', () => {
    const doc = seedDoc(now);
    const hostile = doc.units.find(u => u.affiliation === 'hostile')!;
    const list = units(doc, '/attack ', [hostile.id]);
    expect(doc.units.find(u => u.designation === list[0])!.affiliation).toBe('friend');
    expect(units(doc, '/bda ', [hostile.id])[0]).toBe(hostile.designation);
  });

  it('puts a unit already named in the command last, and still ranks typed prefixes first', () => {
    const doc = seedDoc(now);
    const tools = doc.units.find(u => u.designation === 'TOOLS')!;
    expect(units(doc, '/link TOOLS ', [tools.id]).at(-1)).toBe('TOOLS');
    expect(units(doc, '/note T', [doc.units.find(u => u.designation === 'IRS')!.id])[0]).toMatch(/^T/);
  });

  it('records command subjects and captures, most recent first, without duplicates', () => {
    clearRecent();
    const doc = seedDoc(now);
    noteCommand({ verb: 'note', args: { unit: 'irs' } }, 'IRS NOTE');
    touchUnit({ id: 'tools' });
    noteCommand({ verb: 'note', args: { unit: 'irs' } }, 'IRS NOTE');
    expect(recentIds(doc)).toEqual(['irs', 'tools']);
    noteCommand({ verb: 'new', args: { title: 'X' } }, 'CAPTURE NEWONE — HOSTILE');
    expect(recentIds(doc)).toEqual(['irs', 'tools']);
    doc.units.push({ ...doc.units[0], id: 'u99', designation: 'NEWONE' });
    expect(recentIds(doc)).toEqual(['u99', 'irs', 'tools']);
    expect(des(doc, recentIds(doc)[0])).toBe('NEWONE');
    clearRecent();
  });
});
