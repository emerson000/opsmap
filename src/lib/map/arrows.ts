// Arrow and label geometry for FM 1-02.2-shaped graphics, drawn as custom SVG.
// All coordinates are world pixels (y down). Pure functions; no DOM.
export type Pt = { x: number; y: number };
export interface Curve { p0: Pt; c: Pt; p1: Pt }

const f = (n: number) => Number(n.toFixed(2));
const pt = (p: Pt) => `${f(p.x)} ${f(p.y)}`;
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
/** Left of travel in screen space (y down). */
const leftNormal = (d: Pt): Pt => ({ x: d.y, y: -d.x });

export function quadAt(c: Curve, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * c.p0.x + 2 * u * t * c.c.x + t * t * c.p1.x, y: u * u * c.p0.y + 2 * u * t * c.c.y + t * t * c.p1.y };
}
export function quadTangent(c: Curve, t: number): Pt {
  return { x: 2 * (1 - t) * (c.c.x - c.p0.x) + 2 * t * (c.p1.x - c.c.x), y: 2 * (1 - t) * (c.c.y - c.p0.y) + 2 * t * (c.p1.y - c.c.y) };
}
/** The part of the curve between t0 and t1, as its own quadratic (blossoming). */
export function subQuad(c: Curve, t0: number, t1: number): Curve {
  const w0 = (1 - t0) * (1 - t1), w1 = (1 - t0) * t1 + t0 * (1 - t1), w2 = t0 * t1;
  return {
    p0: quadAt(c, t0),
    c: { x: w0 * c.p0.x + w1 * c.c.x + w2 * c.p1.x, y: w0 * c.p0.y + w1 * c.c.y + w2 * c.p1.y },
    p1: quadAt(c, t1),
  };
}
/** Smallest t (searching from `from` toward `to`) where the curve is `distance` away from `origin`. */
function tAtDistance(c: Curve, origin: Pt, distance: number, from: number, to: number): number {
  if (distance <= 0) return from;
  let lo = from, hi = to;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (len(sub(quadAt(c, mid), origin)) < distance) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Shortest arrow drawn between close symbols; closer than twice this, no arrow. */
export const MIN_ARROW = 16;
/**
 * A quadratic from `a` to `b`, bowed to the left of travel, with each end trimmed so it
 * stops `startClear` / `endClear` short of the symbols there. When the symbols are close,
 * both clearances shrink so at least MIN_ARROW remains. Null when the symbols coincide.
 */
export function bentCurve(a: Pt, b: Pt, o: { startClear: number; endClear: number; bend?: number }): Curve | null {
  const d = sub(b, a), l = len(d);
  if (l < MIN_ARROW * 2) return null;
  const clear = o.startClear + o.endClear, fit = clear > 0 ? Math.min(1, (l - MIN_ARROW) / clear) : 1;
  const n = leftNormal(unit(d));
  const full: Curve = { p0: a, c: add(mul(add(a, b), 0.5), mul(n, (o.bend ?? 0.18) * l)), p1: b };
  const t0 = tAtDistance(full, a, o.startClear * fit, 0, 1);
  const t1 = tAtDistance(full, b, o.endClear * fit, 1, 0);
  return t1 > t0 ? subQuad(full, t0, t1) : null;
}

export const curvePath = (c: Curve) => `M${pt(c.p0)} Q${pt(c.c)} ${pt(c.p1)}`;

function head(c: Curve, headLen: number, headHalf: number) {
  const dir = unit(quadTangent(c, 1));
  const base = sub(c.p1, mul(dir, headLen));
  const n = leftNormal(dir);
  return { base, left: add(base, mul(n, headHalf)), right: sub(base, mul(n, headHalf)), tip: c.p1 };
}

/** Direction of attack: shaft (stroke it at `width`) ending under a head polygon (fill it for main, outline for support). */
export function attackArrow(c: Curve, o: { width: number; headLen: number; headHalf: number }) {
  // On a short arrow the head takes at most 45% of it, so the shaft still reads.
  const k = Math.min(1, (len(sub(c.p1, c.p0)) * 0.45) / o.headLen);
  const h = head(c, o.headLen * k, o.headHalf * Math.max(k, 0.6));
  const ts = tAtDistance(c, c.p1, o.headLen * k * 0.8, 1, 0);
  return { shaft: curvePath(subQuad(c, 0, ts)), head: `${pt(h.left)} ${pt(h.tip)} ${pt(h.right)}`, width: o.width };
}

/** Axis of advance: a broad hollow arrow outline that follows the curve. */
export function axisOutline(c: Curve, o: { halfWidth: number; headLen: number; headHalf: number }): string {
  const tb = tAtDistance(c, c.p1, o.headLen, 1, 0);
  const body = subQuad(c, 0, tb);
  const steps = 24, left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, p = quadAt(body, t), n = leftNormal(unit(quadTangent(body, t)));
    left.push(add(p, mul(n, o.halfWidth))); right.push(sub(p, mul(n, o.halfWidth)));
  }
  const dir = unit(quadTangent(body, 1)), n = leftNormal(dir), base = body.p1;
  const wingL = add(base, mul(n, o.headHalf)), wingR = sub(base, mul(n, o.headHalf));
  const ring = [...left, wingL, c.p1, wingR, ...right.reverse()];
  return `M${ring.map(pt).join(' L')} Z`;
}

/** Axis of advance through waypoints (the phase lines named with `via`): the same broad hollow arrow, along a
 *  smooth curve through every point in order. `points` runs from the start to the tip, already clear of symbols. */
export function axisOutlineThrough(points: Pt[], o: { halfWidth: number; headLen: number; headHalf: number }): string {
  // Catmull-Rom through the points, sampled densely.
  const path: Pt[] = [];
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < 12; s++) {
      const t = s / 12, t2 = t * t, t3 = t2 * t;
      path.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  const tip = points[points.length - 1];
  path.push(tip);
  // The body stops where the head begins: headLen back along the path from the tip.
  let left = o.headLen, cut = path.length - 1;
  while (cut > 0 && left > 0) { left -= len(sub(path[cut], path[cut - 1])); cut--; }
  const body = path.slice(0, Math.max(2, cut + 1));
  const normalAt = (i: number) => leftNormal(unit(sub(body[Math.min(body.length - 1, i + 1)], body[Math.max(0, i - 1)])));
  const l: Pt[] = [], r: Pt[] = [];
  body.forEach((p, i) => { const n = normalAt(i); l.push(add(p, mul(n, o.halfWidth))); r.push(sub(p, mul(n, o.halfWidth))); });
  const base = body[body.length - 1], n = leftNormal(unit(sub(tip, base)));
  const ring = [...l, add(base, mul(n, o.headHalf)), tip, sub(base, mul(n, o.headHalf)), ...r.reverse()];
  return `M${ring.map(pt).join(' L')} Z`;
}

/**
 * Withdrawal: movement away from HQ. Two parallel lines `gap` apart (a hollow shaft) that stop at the base of an
 * open V head, so it reads apart from the filled advance arrow, the thin move arrow and the broad axis outline.
 */
export function withdrawArrow(c: Curve, o: { gap: number; headLen: number; headHalf: number }) {
  const h = head(c, Math.min(o.headLen, len(sub(c.p1, c.p0)) * 0.45), o.headHalf);
  const dir = unit(sub(h.tip, h.base)), n = mul(leftNormal(dir), o.gap / 2);
  // The lines stop where they meet the head's arms, so the shaft runs into the V.
  const stop = sub(h.base, mul(dir, -o.headLen * (o.gap / 2) / o.headHalf));
  const line = (side: number) => `M${pt(add(c.p0, mul(n, side)))} L${pt(add(stop, mul(n, side)))}`;
  return { shaft: `${line(1)} ${line(-1)}`, head: `${pt(h.left)} ${pt(h.tip)} ${pt(h.right)}` };
}

/** Movement arrow: a thin line with an open V head. */
export function moveArrow(c: Curve, headLen: number) {
  const h = head(c, headLen, headLen * 0.5);
  return { shaft: curvePath(c), head: `${pt(h.left)} ${pt(h.tip)} ${pt(h.right)}` };
}

/** A point beside the curve plus an upright rotation for text that follows the curve. */
export function labelAt(c: Curve, t: number, offset: number): Pt & { angle: number } {
  const tan = unit(quadTangent(c, t));
  const p = add(quadAt(c, t), mul(leftNormal(tan), offset));
  let angle = Math.atan2(tan.y, tan.x) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return { x: f(p.x), y: f(p.y), angle: f(angle) };
}

/** A small obstacle (wire) zigzag across the curve, for a blocked attacker. */
export function obstacleMark(c: Curve, t: number, size: number): string {
  const p = quadAt(c, t), tan = unit(quadTangent(c, t)), n = leftNormal(tan);
  const pts: Pt[] = [];
  for (let i = 0; i <= 4; i++) {
    const along = (i % 2 === 0 ? -1 : 1) * size * 0.35;
    pts.push(add(add(p, mul(n, -size + (2 * size * i) / 4)), mul(tan, along)));
  }
  return `M${pts.map(pt).join(' L')}`;
}

const polar = (r: number, deg: number): Pt => ({ x: r * Math.cos(deg * Math.PI / 180), y: r * Math.sin(deg * Math.PI / 180) });

/** An arc for <textPath>, centered on `centerDeg`, running left to right on screen in both halves. */
export function arcTextPath(r: number, centerDeg: number, spanDeg: number): string {
  const c = ((centerDeg % 360) + 360) % 360;
  const lower = c > 0 && c < 180;
  const a = polar(r, lower ? c + spanDeg / 2 : c - spanDeg / 2), b = polar(r, lower ? c - spanDeg / 2 : c + spanDeg / 2);
  return `M${pt(a)} A${f(r)} ${f(r)} 0 ${spanDeg > 180 ? 1 : 0} ${lower ? 0 : 1} ${pt(b)}`;
}

/** Closed band between radii r0 and r1 over a sector (clockwise from startDeg). */
export function annularSectorPath(r0: number, r1: number, startDeg: number, widthDeg: number): string {
  const w = Math.min(widthDeg, 359.99), end = startDeg + w, large = w > 180 ? 1 : 0;
  const o0 = polar(r1, startDeg), o1 = polar(r1, end);
  if (r0 <= 0) return `M0 0 L${pt(o0)} A${f(r1)} ${f(r1)} 0 ${large} 1 ${pt(o1)} Z`;
  const i0 = polar(r0, startDeg), i1 = polar(r0, end);
  return `M${pt(o0)} A${f(r1)} ${f(r1)} 0 ${large} 1 ${pt(o1)} L${pt(i1)} A${f(r0)} ${f(r0)} 0 ${large} 0 ${pt(i0)} Z`;
}
