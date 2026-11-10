import { describe, expect, it } from 'vitest';
import { buildTerrain, makeNoise, mulberry32, contourLines } from '../../src/lib/map/terrain';

const bounds = { x0: -600, y0: -400, x1: 600, y1: 400 };

describe('terrain', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = buildTerrain('opsmap', bounds, 24), b = buildTerrain('opsmap', bounds, 24), c = buildTerrain('other', bounds, 24);
    expect(a).toEqual(b);
    expect(JSON.stringify(a.contours)).not.toEqual(JSON.stringify(c.contours));
  });
  it('produces contours with index lines, a river, woods and spot heights', () => {
    const t = buildTerrain('opsmap', bounds, 24);
    expect(t.contours.length).toBeGreaterThan(4);
    expect(t.contours.some(c => c.index)).toBe(true);
    expect(t.river.d).toMatch(/^M/);
    expect(t.woods.length).toBeGreaterThan(0);
    expect(t.spots.length).toBeGreaterThanOrEqual(3);
    for (const s of t.spots) {
      expect(s.x).toBeGreaterThanOrEqual(bounds.x0); expect(s.x).toBeLessThanOrEqual(bounds.x1);
      expect(Number.isInteger(s.elev)).toBe(true);
    }
  });
  it('noise is bounded to [0,1]', () => {
    const n = makeNoise(mulberry32(7));
    for (let i = 0; i < 500; i++) { const v = n(i * 0.37, i * 0.11); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
  it('marching squares chains a single closed ring for a cone', () => {
    const size = 21, field: number[][] = [];
    for (let j = 0; j < size; j++) { field.push([]); for (let i = 0; i < size; i++) field[j].push(1 - Math.hypot(i - 10, j - 10) / 10); }
    const lines = contourLines(field, 0.5);
    expect(lines).toHaveLength(1);
    const ring = lines[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const p of ring) expect(Math.hypot(p.x - 10, p.y - 10)).toBeCloseTo(5, 0);
  });
});
