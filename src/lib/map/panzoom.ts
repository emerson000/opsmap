// Pan/zoom math. The map component drives these transforms from Pointer Events and the wheel.
import { RIM_LABEL_R, SCALE } from './constants';

export interface View2D { x: number; y: number; k: number }
export interface Insets { top: number; right: number; bottom: number; left: number }
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Transform that fits the whole map (out to the rim labels) into the free area. */
export function fitTransform(width: number, height: number, insets: Insets = NO_INSETS, pad = 0): View2D {
  const w = Math.max(1, width - insets.left - insets.right), h = Math.max(1, height - insets.top - insets.bottom);
  // `pad` (screen px) keeps the rim labels, whose size is fixed on screen, clear of the edge.
  const k = Math.max(1, Math.min(w, h) - 2 * pad) / (2 * (RIM_LABEL_R + 0.22) * SCALE);
  return { x: insets.left + w / 2, y: insets.top + h / 2, k };
}

/** Transform that centers a world point in the free area at zoom `k`. */
export function focusTransform(point: { x: number; y: number }, k: number, width: number, height: number, insets: Insets = NO_INSETS): View2D {
  const cx = insets.left + (width - insets.left - insets.right) / 2, cy = insets.top + (height - insets.top - insets.bottom) / 2;
  return { x: cx - point.x * k, y: cy - point.y * k, k };
}

/** Symbols grow slower than the map when zooming, so they stay readable at both ends. */
export function symbolScaleFor(k: number, fitK: number): number {
  const raw = Math.pow(fitK / k, 0.5);
  return Math.round(Math.min(1.5, Math.max(0.45, raw)) * 20) / 20;
}

export const lerpView = (a: View2D, b: View2D, t: number): View2D => {
  // Interpolate zoom geometrically so the motion feels even.
  const k = a.k * Math.pow(b.k / a.k, t);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, k };
};

/**
 * World-space multiplier for symbols, labels and arrow weights: constant screen size at the
 * fitted zoom (so a bigger window shows more ground, not bigger symbols), damped when zooming.
 */
export function mapScale(k: number, fitK: number): number {
  return Math.round((symbolScaleFor(k, fitK) / fitK) * 20) / 20;
}

export const ZOOM_MIN = 0.15, ZOOM_MAX = 8;
const clampK = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

/** Zoom by `factor` keeping the screen point `p` fixed. */
export function zoomAround(v: View2D, p: { x: number; y: number }, factor: number): View2D {
  const k = clampK(v.k * factor), f = k / v.k;
  return { x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, k };
}

/** Wheel zoom factor, matching d3-zoom's feel (trackpad pinch arrives as ctrl+wheel). */
export function wheelFactor(deltaY: number, deltaMode: number, ctrl: boolean): number {
  return Math.pow(2, -deltaY * (deltaMode === 1 ? 0.05 : deltaMode ? 1 : 0.002) * (ctrl ? 10 : 1));
}

type P = { x: number; y: number };
/**
 * Two-finger pinch: the world point under the start midpoint stays under the current midpoint,
 * and zoom follows the finger distance.
 */
export function pinchView(start: View2D, a0: P, b0: P, a1: P, b1: P): View2D {
  const d0 = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y)), d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const k = clampK(start.k * d1 / d0);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const wx = (m0.x - start.x) / start.k, wy = (m0.y - start.y) / start.k;
  return { x: m1.x - wx * k, y: m1.y - wy * k, k };
}
