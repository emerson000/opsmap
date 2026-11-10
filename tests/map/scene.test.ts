import { describe, expect, it } from 'vitest';
import { seedDoc } from '../../src/lib/model/seed';
import type { Doc, Unit } from '../../src/lib/model/types';
import { buildScene, isArchived, derivedTrails } from '../../src/lib/map/scene';

const now = new Date(2026, 10, 9, 12);
const fresh = (): Doc => structuredClone(seedDoc(now));
const unitOf = (doc: Doc, id: string) => doc.units.find(u => u.id === id)!;

describe('buildScene from the seed', () => {
  const doc = fresh();
  const commander = buildScene(doc, { view: 'commander', now });
  const staff = buildScene(doc, { view: 'staff', now });

  it('draws one wedge, boundary and rim label per sector, and four time phase lines', () => {
    expect(commander.sectors).toHaveLength(5);
    expect(commander.sectors.every(s => s.wedge && s.boundary && s.rimPath)).toBe(true);
    expect(commander.rings.map(r => r.label)).toEqual(['PL TODAY', 'PL WEEK', 'PL MONTH', 'PL QUARTER']);
    expect(commander.rings[1].date).toBe('16NOV');
  });
  it('places a custom PL by its date', () => {
    expect(commander.customPls).toHaveLength(1);
    expect(commander.customPls[0].label).toBe('PL LAUNCH');
    expect(commander.customPls[0].r).toBeGreaterThan(300); expect(commander.customPls[0].r).toBeLessThan(400);
  });
  it('shows every seed unit (none are beyond or archived)', () => {
    expect(commander.units).toHaveLength(20);
    expect(commander.sectors.reduce((n, s) => n + s.beyondCount, 0)).toBe(0);
  });
  it('flags the overdue hostile with a penetration marker inside the HQ ring', () => {
    const esc = commander.units.find(u => u.id === 'escalation')!;
    expect(esc.ring).toBe('hq');
    expect(esc.penetration).toBe(true);
  });
  it('pulses only unopposed live hostiles in hq or near', () => {
    const pulsing = commander.units.filter(u => u.pulse).map(u => u.id);
    expect(pulsing).toEqual(['leak']);   // ESCALATION is attacked by Q4RPT; INBOX is destroyed; IRS is attacked
  });
  it('marks contact (ENG) when attacker and target are both close', () => {
    expect(commander.units.find(u => u.id === 'q4rpt')!.contact).toBe(true);
    expect(commander.units.find(u => u.id === 'irsrsp')!.contact).toBe(false); // IRS is in the mid ring
  });
  it('commander view draws main efforts and hostile advances only', () => {
    expect(commander.orders.map(o => o.id).sort()).toEqual(['o-escalation', 'o-tax-main', 'o-work-main']);
    expect(commander.flot).toBeNull();
    expect(commander.orders.every(o => !o.ratio)).toBe(true);
  });
  it('staff view adds support, axis, force ratios and the FLOT', () => {
    expect(staff.orders.map(o => o.id).sort()).toEqual(['o-escalation', 'o-move-axis', 'o-tax-main', 'o-tax-support', 'o-work-main']);
    const taxMain = staff.orders.find(o => o.id === 'o-tax-main')!;
    // plt (3^3) + plt (3^3) vs coy (3^4) = 54:81 → 1:1.5
    expect(taxMain.ratio).toEqual({ text: '1:1.5', under: false });
    expect(staff.orders.find(o => o.id === 'o-tax-support')!.ratio).toBeUndefined();
    // coy (3^4) vs bn (3^5) → 1:3, not under one third
    expect(staff.orders.find(o => o.id === 'o-work-main')!.ratio).toEqual({ text: '1:3', under: false });
    expect(staff.orders.find(o => o.id === 'o-move-axis')!.kind).toBe('axis');
    expect(staff.flot).toMatch(/^M/);
  });
  it('control measures carry doctrinal labels', () => {
    expect(commander.measures.map(m => m.label).sort()).toEqual(['EA', 'NAI', 'OBJ']);
    expect(commander.measures.find(m => m.label === 'NAI')!.name).toBe('BENEFITS ENROLLMENT');
  });
  it('detail view gives full amplifiers only to the selected unit', () => {
    const detail = buildScene(doc, { view: 'detail', now, selectedId: 'irs' });
    expect(detail.units.find(u => u.id === 'irs')!.symbolView).toBe('detail');
    expect(detail.units.find(u => u.id === 'leak')!.symbolView).toBe('staff');
  });
});

describe('beyond, archive and blocked', () => {
  it('collects beyond units into the sector chevron count', () => {
    const doc = fresh();
    unitOf(doc, 'tools').pos = { r: 4.2, theta: 320 };
    unitOf(doc, 'files').pos = { r: 4.3, theta: 230 };
    const scene = buildScene(doc, { view: 'commander', now });
    expect(scene.sectors.find(s => s.id === 'work')!.beyondCount).toBe(1);
    expect(scene.sectors.find(s => s.id === 'productivity')!.beyondCount).toBe(1);
    expect(scene.units.find(u => u.id === 'tools')).toBeUndefined();
  });
  it('archives dropped units, yesterday\'s done friendlies, and done hostiles after the next turn', () => {
    const u = (patch: Partial<Unit>) => ({ ...unitOf(fresh(), 'irsrsp'), ...patch });
    expect(isArchived(u({ lifecycle: 'dropped' }), now)).toBe(true);
    expect(isArchived(u({ lifecycle: 'done', updatedAt: new Date(2026, 10, 9, 8).toISOString() }), now)).toBe(false);
    expect(isArchived(u({ lifecycle: 'done', updatedAt: new Date(2026, 10, 8, 20).toISOString() }), now)).toBe(true);
    const hostile = u({ affiliation: 'hostile', lifecycle: 'done', updatedAt: new Date(2026, 10, 8, 20).toISOString() });
    expect(isArchived(hostile, now, undefined)).toBe(false);
    expect(isArchived(hostile, now, '2026-11-08')).toBe(false);
    expect(isArchived(hostile, now, '2026-11-09')).toBe(true);
  });
  it('a blocked attacker puts an obstacle mark on its arrow', () => {
    const doc = fresh();
    unitOf(doc, 'irsrsp').lifecycle = 'blocked';
    const scene = buildScene(doc, { view: 'commander', now });
    expect(scene.orders.find(o => o.id === 'o-tax-main')!.obstacle).toMatch(/^M/);
  });
  it('hides the force ratio when an involved unit has no echelon', () => {
    const doc = fresh();
    delete unitOf(doc, 'records').echelon;
    const scene = buildScene(doc, { view: 'staff', now });
    expect(scene.orders.find(o => o.id === 'o-tax-main')!.ratio).toBeUndefined();
  });
});

describe('trails for auto-advanced units', () => {
  it('derives a ghost at yesterday\'s radius for dated hostiles after a turn today', () => {
    const doc = fresh(); doc.lastTurn = '2026-11-09';
    const trails = derivedTrails(doc, now);
    const ids = trails.map(t => t.unitId).sort();
    expect(ids).toContain('irs'); expect(ids).toContain('leak'); expect(ids).toContain('knee');
    expect(ids).not.toContain('irsrsp');        // friendlies never auto-move
    const irs = trails.find(t => t.unitId === 'irs')!;
    expect(irs.from.r).toBeGreaterThan(unitOf(doc, 'irs').pos.r);
  });
  it('skips pinned items and docs without a turn today', () => {
    const doc = fresh(); doc.lastTurn = '2026-11-09';
    unitOf(doc, 'irs').posOverride = true;
    expect(derivedTrails(doc, now).some(t => t.unitId === 'irs')).toBe(false);
    doc.lastTurn = '2026-11-07';
    expect(derivedTrails(doc, now)).toEqual([]);
    delete doc.lastTurn;
    expect(derivedTrails(doc, now)).toEqual([]);
  });
  it('explicit trails win and become scene ghosts', () => {
    const doc = fresh();
    const scene = buildScene(doc, { view: 'commander', now, trails: [{ unitId: 'irs', from: { r: 3.5, theta: 6 } }] });
    expect(scene.ghosts).toHaveLength(1);
    expect(scene.ghosts[0].unitId).toBe('irs');
  });
});

describe('link orders', () => {
  it('draws a straight line with a linkup point at the midpoint (staff view)', () => {
    const doc = fresh();
    doc.orders.push({ id: 'o-link', type: 'link', from: 'packing', to: 'movers', kind: 'handoff', createdAt: now.toISOString() });
    const staff = buildScene(doc, { view: 'staff', now });
    const link = staff.orders.find(o => o.id === 'o-link')!;
    expect(link.kind).toBe('link');
    expect(link.linkKind).toBe('handoff');
    const a = staff.units.find(u => u.id === 'packing')!, b = staff.units.find(u => u.id === 'movers')!;
    expect(link.linkup!.x).toBeCloseTo((a.x + b.x) / 2, 1);
    expect(link.linkup!.y).toBeCloseTo((a.y + b.y) / 2, 1);
    expect(buildScene(doc, { view: 'commander', now }).orders.some(o => o.id === 'o-link')).toBe(false);
  });
});

describe('arrows between close symbols', () => {
  it('every seed order still draws at the fitted symbol scale (regression: clearances hid short arrows)', () => {
    for (const symbolScale of [1, 1.5, 2.2]) {
      const scene = buildScene(fresh(), { view: 'staff', now, symbolScale });
      expect(scene.orders.map(o => o.id).sort()).toEqual(['o-escalation', 'o-move-axis', 'o-tax-main', 'o-tax-support', 'o-work-main']);
    }
  });
});
