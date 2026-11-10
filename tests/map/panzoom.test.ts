import { describe, expect, it } from 'vitest';
import { fitTransform, focusTransform, symbolScaleFor, lerpView, zoomAround, pinchView, wheelFactor, ZOOM_MAX } from '../../src/lib/map/panzoom';
import { RIM_LABEL_R, SCALE } from '../../src/lib/map/constants';

describe('pan/zoom math', () => {
  it('fits the rim inside the free area, centered between the insets', () => {
    const t = fitTransform(1280, 800, { top: 40, right: 0, bottom: 100, left: 0 });
    expect(t.x).toBe(640); expect(t.y).toBe(40 + 330);
    expect(2 * RIM_LABEL_R * SCALE * t.k).toBeLessThanOrEqual(660);
  });
  it('focus puts the world point at the free-area center', () => {
    const t = focusTransform({ x: 100, y: -50 }, 2, 1000, 600);
    expect(t.x + 100 * t.k).toBe(500); expect(t.y - 50 * t.k).toBe(300);
  });
  it('symbol scale is 1 at fit, shrinks when zoomed in, grows when zoomed out, and is clamped', () => {
    expect(symbolScaleFor(1, 1)).toBe(1);
    expect(symbolScaleFor(4, 1)).toBe(0.5);
    expect(symbolScaleFor(0.5, 1)).toBeCloseTo(1.4, 5);
    expect(symbolScaleFor(100, 1)).toBe(0.45);
  });
  it('interpolates zoom geometrically', () => {
    expect(lerpView({ x: 0, y: 0, k: 1 }, { x: 10, y: 10, k: 4 }, 0.5)).toEqual({ x: 5, y: 5, k: 2 });
  });
  it('fit padding keeps a pixel margin around the rim', () => {
    const a = fitTransform(390, 500), b = fitTransform(390, 500, undefined, 14);
    expect(2 * RIM_LABEL_R * SCALE * b.k).toBeLessThanOrEqual(390 - 28);
    expect(b.k).toBeLessThan(a.k);
  });
  it('zooms about a fixed screen point, clamped', () => {
    const v = zoomAround({ x: 100, y: 50, k: 1 }, { x: 200, y: 150 }, 2);
    expect(v.k).toBe(2);
    expect((200 - v.x) / v.k).toBeCloseTo(100); expect((150 - v.y) / v.k).toBeCloseTo(100);
    expect(zoomAround({ x: 0, y: 0, k: 6 }, { x: 0, y: 0 }, 10).k).toBe(ZOOM_MAX);
  });
  it('pinch keeps the world point under the fingers and follows their spread', () => {
    const start = { x: 0, y: 0, k: 1 };
    const v = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(v.k).toBe(2);
    expect((150 - v.x) / v.k).toBeCloseTo(150); expect((100 - v.y) / v.k).toBeCloseTo(100);
    const pan = pinchView(start, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 20 }, { x: 110, y: 20 });
    expect(pan).toEqual({ x: 10, y: 20, k: 1 });
  });
  it('wheel up zooms in, ctrl (trackpad pinch) zooms faster', () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-10, 0, true)).toBeCloseTo(wheelFactor(-100, 0, false));
  });
});
