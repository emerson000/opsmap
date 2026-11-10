import { describe, expect, it } from 'vitest';
import {
  bentCurve, quadAt, quadTangent, subQuad, attackArrow, axisOutline, moveArrow, labelAt, obstacleMark, arcTextPath, annularSectorPath,
} from '../../src/lib/map/arrows';

const dist = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x-b.x, a.y-b.y);
const nums = (s: string) => (s.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('quadratic helpers', () => {
  const c = { p0:{x:0,y:0}, c:{x:50,y:50}, p1:{x:100,y:0} };
  it('evaluates endpoints and midpoint', () => {
    expect(quadAt(c,0)).toEqual({x:0,y:0});
    expect(quadAt(c,1)).toEqual({x:100,y:0});
    expect(quadAt(c,0.5)).toEqual({x:50,y:25});
  });
  it('tangent at the ends points toward the control point', () => {
    const t0 = quadTangent(c,0), t1 = quadTangent(c,1);
    expect(t0.x).toBeGreaterThan(0); expect(t0.y).toBeGreaterThan(0);
    expect(t1.x).toBeGreaterThan(0); expect(t1.y).toBeLessThan(0);
  });
  it('subQuad keeps points on the original curve', () => {
    const s = subQuad(c, 0.2, 0.7);
    expect(dist(s.p0, quadAt(c,0.2))).toBeLessThan(1e-9);
    expect(dist(s.p1, quadAt(c,0.7))).toBeLessThan(1e-9);
    expect(dist(quadAt(s,0.5), quadAt(c,0.45))).toBeLessThan(1e-9);
  });
});

describe('bentCurve', () => {
  it('trims both ends to the requested clearance from the symbols', () => {
    const a = {x:0,y:0}, b = {x:300,y:40};
    const curve = bentCurve(a, b, { startClear: 24, endClear: 30 })!;
    expect(dist(curve.p0, a)).toBeCloseTo(24, 1);
    expect(dist(curve.p1, b)).toBeCloseTo(30, 1);
  });
  it('bows to the left of travel so it does not run through either symbol', () => {
    const curve = bentCurve({x:0,y:0}, {x:200,y:0}, { startClear: 10, endClear: 10, bend: 0.2 })!;
    // Travel is +x; left of travel in screen space (y down) is -y.
    expect(quadAt(curve, 0.5).y).toBeLessThan(-10);
  });
  it('returns null only when the symbols sit on top of each other', () => {
    expect(bentCurve({x:0,y:0}, {x:20,y:0}, { startClear: 20, endClear: 20 })).toBeNull();
  });
  it('close symbols still get a short arrow: clearances shrink to keep it visible', () => {
    const a = {x:0,y:0}, b = {x:52,y:0};
    const curve = bentCurve(a, b, { startClear: 32, endClear: 32 })!;
    expect(curve).not.toBeNull();
    expect(dist(curve.p0, curve.p1)).toBeGreaterThanOrEqual(15.5);
    expect(dist(curve.p0, a)).toBeGreaterThan(10);
    expect(dist(curve.p1, b)).toBeGreaterThan(10);
  });
  it('a zero bend is a straight line', () => {
    const curve = bentCurve({x:0,y:0}, {x:100,y:0}, { startClear: 0, endClear: 0, bend: 0 })!;
    expect(quadAt(curve,0.5).y).toBeCloseTo(0, 9);
  });
});

describe('arrow shapes', () => {
  const curve = bentCurve({x:0,y:0}, {x:300,y:0}, { startClear: 20, endClear: 20 })!;
  it('main attack: the head tip is the curve end and the shaft stops at the head base', () => {
    const arrow = attackArrow(curve, { width: 4, headLen: 16, headHalf: 9 });
    const head = nums(arrow.head);
    expect(head).toHaveLength(6);
    expect(head[2]).toBeCloseTo(curve.p1.x, 1); expect(head[3]).toBeCloseTo(curve.p1.y, 1);
    const shaftEnd = nums(arrow.shaft).slice(-2);
    expect(dist({x:shaftEnd[0],y:shaftEnd[1]}, curve.p1)).toBeCloseTo(16 * 0.8, 0);
    // Head wings are symmetric about the tip.
    expect(dist({x:head[0],y:head[1]}, curve.p1)).toBeCloseTo(dist({x:head[4],y:head[5]}, curve.p1), 1);
  });
  it('axis outline is a closed polygon wider than the shaft', () => {
    const outline = axisOutline(curve, { halfWidth: 10, headLen: 28, headHalf: 20 });
    expect(outline.startsWith('M')).toBe(true);
    expect(outline.trim().endsWith('Z')).toBe(true);
    const ys = nums(outline).filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(40 - 1e-6);
  });
  it('caps the head on a short arrow so the shaft stays visible', () => {
    const short = bentCurve({x:0,y:0}, {x:40,y:0}, { startClear: 10, endClear: 10, bend: 0 })!;
    const arrow = attackArrow(short, { width: 4, headLen: 18, headHalf: 10 });
    const head = nums(arrow.head);
    expect(dist({x:head[0],y:head[1]}, short.p1)).toBeLessThan(18);
    expect(nums(arrow.shaft)[0]).toBeCloseTo(short.p0.x, 1);
  });
  it('move arrow ends in an open head at the curve end', () => {
    const m = moveArrow(curve, 10);
    const head = nums(m.head);
    expect(head[2]).toBeCloseTo(curve.p1.x, 1);
  });
  it('labels stay upright', () => {
    const backwards = bentCurve({x:300,y:0}, {x:0,y:0}, { startClear: 20, endClear: 20 })!;
    const l = labelAt(backwards, 0.5, 10);
    expect(l.angle).toBeGreaterThan(-90); expect(l.angle).toBeLessThanOrEqual(90);
  });
  it('obstacle mark is a path near the curve point', () => {
    const d = obstacleMark(curve, 0.4, 8);
    const p = quadAt(curve, 0.4);
    const pts = nums(d);
    for (let i = 0; i < pts.length; i += 2) expect(dist({x:pts[i],y:pts[i+1]}, p)).toBeLessThan(20);
  });
});

describe('arc text and bands', () => {
  it('reverses the arc in the lower half so text reads left to right', () => {
    const top = nums(arcTextPath(100, 270, 40));
    const bottom = nums(arcTextPath(100, 90, 40));
    expect(top[0]).toBeLessThan(top[top.length-2]);       // top: starts left, ends right
    expect(bottom[0]).toBeLessThan(bottom[bottom.length-2]); // bottom: also starts left
  });
  it('builds a closed annular sector', () => {
    const d = annularSectorPath(100, 200, 0, 90);
    expect(d.trim().endsWith('Z')).toBe(true);
  });
});
