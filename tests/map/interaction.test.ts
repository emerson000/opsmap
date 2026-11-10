import { describe, expect, it } from 'vitest';
import { seedDoc } from '../../src/lib/model/seed';
import { SCALE } from '../../src/lib/map/constants';
import { dropCommand, attackCommand, contextAt, measureDropCommand, ringOfRadius, worldFromClient } from '../../src/lib/map/interaction';
import { apply } from '../../src/core/commands/apply';
import { polarToXY } from '../../src/lib/model/geometry';

const now = new Date(2026, 10, 9, 12);
const doc = seedDoc(now);
const world = (r: number, theta: number) => { const p = polarToXY(r, theta); return { x: p.x * SCALE, y: p.y * SCALE }; };

describe('ringOfRadius', () => {
  it.each([[0.2,'hq'],[0.99,'hq'],[1,'near'],[1.99,'near'],[2.5,'mid'],[3.9,'far'],[4,'beyond'],[9,'beyond']] as const)('%s → %s', (r, ring) => {
    expect(ringOfRadius(r)).toBe(ring);
  });
});

describe('dropCommand (drag-to-move uses snap)', () => {
  it('a drop inside a sector becomes one move with that sector', () => {
    const cmd = dropCommand(doc, 'irsrsp', world(2.5, 10));
    expect(cmd.verb).toBe('move');
    expect(cmd.args).toMatchObject({ unit: 'irsrsp', sectorId: 'household' });
    expect(cmd.args.r as number).toBeCloseTo(2.5, 3);
    expect(cmd.args.theta as number).toBeCloseTo(10, 3);
  });
  it('a drop across a boundary takes the sector under the pointer', () => {
    const cmd = dropCommand(doc, 'irsrsp', world(1.5, 300));
    expect(cmd.args.sectorId).toBe('work');
  });
  it('a drop outside the map snaps to the beyond edge', () => {
    const cmd = dropCommand(doc, 'irsrsp', world(12, 100));
    expect(cmd.args.r as number).toBeLessThanOrEqual(4.45);
    expect(ringOfRadius(cmd.args.r as number)).toBe('beyond');
    expect(cmd.args.sectorId).toBe('family');
  });
  it('a drop on top of HQ stays inside the HQ ring, never at r=0', () => {
    const cmd = dropCommand(doc, 'irsrsp', { x: 0, y: 0 });
    expect(cmd.args.r as number).toBeGreaterThan(0);
    expect(ringOfRadius(cmd.args.r as number)).toBe('hq');
  });
  it('a drop into a gap between sectors snaps to the nearest sector edge', () => {
    const gappy = { ...doc, sectors: [{ id: 'a', name: 'A', startDeg: 0, widthDeg: 90 }, { id: 'b', name: 'B', startDeg: 180, widthDeg: 90 }] };
    expect(dropCommand(gappy, 'irsrsp', world(2, 100)).args.sectorId).toBe('a');
    expect(dropCommand(gappy, 'irsrsp', world(2, 170)).args.sectorId).toBe('b');
  });
  it('rejects non-finite positions', () => {
    expect(() => dropCommand(doc, 'irsrsp', { x: NaN, y: 0 })).toThrow();
  });
});

describe('attackCommand (edge-handle drag)', () => {
  it('friendly onto hostile in a sector that already has a main effort → support', () => {
    const cmd = attackCommand(doc, 'records', 'leak');
    expect(cmd).toEqual({ verb: 'attack', args: { unit: 'records', target: 'leak', role: 'support' } });
  });
  it('friendly in a sector with no main effort → main', () => {
    const cmd = attackCommand(doc, 'run', 'knee');
    expect(cmd).toMatchObject({ verb: 'attack', args: { role: 'main' } });
  });
  it('refuses a non-hostile target', () => {
    expect(attackCommand(doc, 'run', 'sleep')).toMatchObject({ error: expect.stringMatching(/hostile or suspect/i) });
  });
  it('refuses a hostile attacker and self-targeting', () => {
    expect(attackCommand(doc, 'leak', 'irs')).toHaveProperty('error');
    expect(attackCommand(doc, 'irs', 'irs')).toHaveProperty('error');
  });
});

describe('contextAt (double-click on empty ground)', () => {
  it('returns sector and ring under the point', () => {
    expect(contextAt(doc, world(2.5, 100))).toEqual({ sectorId: 'family', ring: 'mid' });
    expect(contextAt(doc, world(0.5, 300))).toEqual({ sectorId: 'work', ring: 'hq' });
  });
});

describe('worldFromClient', () => {
  it('inverts the pan/zoom transform', () => {
    const rect = { left: 10, top: 20 };
    const t = { x: 500, y: 400, k: 2 };
    expect(worldFromClient(10 + 500 + 2 * 30, 20 + 400 - 2 * 15, rect, t)).toEqual({ x: 30, y: -15 });
  });
});

describe('measureDropCommand', () => {
  it('turns an NAI drop into one undoable move op that lands in the sector and ring under the pointer', () => {
    const cmd = measureDropCommand(doc, 'nai-benefits', world(2.5, 20));
    expect(cmd).toEqual({ verb: 'nai', args: { action: 'move', measure: 'nai-benefits', r: 2.5, theta: 20 } });
    const r = apply(doc, cmd, now);
    if ('error' in r) throw new Error(r.error);
    expect(r.log).toBe('NAI BENEFITS ENROLLMENT MOVED → HOUSEHOLD MID');
  });
  it('refuses phase lines and unknown measures', () => {
    expect(() => measureDropCommand(doc, 'pl-launch', world(2, 20))).toThrow(/date/);
    expect(() => measureDropCommand(doc, 'nope', world(2, 20))).toThrow(/Unknown/);
  });
});
