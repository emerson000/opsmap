// Seeded procedural terrain: value-noise heightfield → contour lines (marching squares),
// a river that carves a valley, woods blobs and hilltop spot heights. Pure and deterministic.
export type XY = { x: number; y: number };
export interface Bounds { x0: number; y0: number; x1: number; y1: number }
export interface Terrain {
  bounds: Bounds;
  contours: { level: number; index: boolean; d: string }[];
  river: { d: string };
  woods: { d: string }[];
  spots: { x: number; y: number; elev: number }[];
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D value noise in [0,1] with smoothstep interpolation. */
export function makeNoise(rand: () => number): (x: number, y: number) => number {
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const values = Array.from({ length: 256 }, () => rand());
  const lattice = (ix: number, iy: number) => values[(perm[ix & 255] + (iy & 255)) & 255];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const a = lattice(ix, iy), b = lattice(ix + 1, iy), c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };
}
function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves = 4): number {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let o = 0; o < octaves; o++) { sum += amp * noise(x * freq + o * 17.3, y * freq - o * 9.1); norm += amp; amp *= 0.5; freq *= 2; }
  return sum / norm;
}

/**
 * Marching squares over field[row][col] at `level`. Returns polylines in grid coordinates
 * (x = column, y = row). Closed loops repeat their first point at the end.
 */
export function contourLines(field: number[][], level: number): XY[][] {
  const h = field.length, w = field[0]?.length ?? 0;
  const points = new Map<string, XY>();
  const adjacency = new Map<string, number[]>();
  const segments: [string, string][] = [];
  const edgePoint = (key: string, ax: number, ay: number, bx: number, by: number) => {
    if (!points.has(key)) {
      const va = field[ay][ax], vb = field[by][bx], t = va === vb ? 0.5 : (level - va) / (vb - va);
      points.set(key, { x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
    }
    return key;
  };
  const link = (a: string, b: string) => {
    const id = segments.push([a, b]) - 1;
    for (const k of [a, b]) { const list = adjacency.get(k); if (list) list.push(id); else adjacency.set(k, [id]); }
  };
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    const tl = field[j][i] > level ? 8 : 0, tr = field[j][i + 1] > level ? 4 : 0, br = field[j + 1][i + 1] > level ? 2 : 0, bl = field[j + 1][i] > level ? 1 : 0;
    const c = tl | tr | br | bl;
    if (c === 0 || c === 15) continue;
    const T = () => edgePoint(`h${i},${j}`, i, j, i + 1, j);
    const R = () => edgePoint(`v${i + 1},${j}`, i + 1, j, i + 1, j + 1);
    const B = () => edgePoint(`h${i},${j + 1}`, i, j + 1, i + 1, j + 1);
    const L = () => edgePoint(`v${i},${j}`, i, j, i, j + 1);
    switch (c) {
      case 1: case 14: link(L(), B()); break;
      case 2: case 13: link(B(), R()); break;
      case 3: case 12: link(L(), R()); break;
      case 4: case 11: link(T(), R()); break;
      case 6: case 9: link(T(), B()); break;
      case 7: case 8: link(L(), T()); break;
      case 5: link(T(), R()); link(L(), B()); break;
      case 10: link(L(), T()); link(B(), R()); break;
    }
  }
  const used = new Uint8Array(segments.length);
  const walk = (startKey: string): XY[] => {
    const line: XY[] = [points.get(startKey)!];
    let key = startKey;
    for (;;) {
      const next = (adjacency.get(key) ?? []).find(id => !used[id]);
      if (next === undefined) break;
      used[next] = 1;
      const [a, b] = segments[next];
      key = a === key ? b : a;
      line.push(points.get(key)!);
    }
    return line;
  };
  const lines: XY[][] = [];
  for (const [key, list] of adjacency) if (list.length === 1 && !used[list[0]]) lines.push(walk(key));
  for (let id = 0; id < segments.length; id++) if (!used[id]) lines.push(walk(segments[id][0]));
  return lines;
}

const f = (n: number) => Math.round(n * 10) / 10;
/** Smooth polyline path: straight to the first midpoint, then quadratic through each vertex. */
export function smoothPath(points: XY[], closed = false): string {
  if (points.length < 2) return '';
  if (points.length < 3) return `M${f(points[0].x)} ${f(points[0].y)} L${f(points[1].x)} ${f(points[1].y)}`;
  const mid = (a: XY, b: XY) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const pts = closed ? points.slice(0, points[0] === points[points.length - 1] ? -1 : undefined) : points;
  if (closed) {
    const n = pts.length, start = mid(pts[n - 1], pts[0]);
    let d = `M${f(start.x)} ${f(start.y)}`;
    for (let i = 0; i < n; i++) { const m = mid(pts[i], pts[(i + 1) % n]); d += ` Q${f(pts[i].x)} ${f(pts[i].y)} ${f(m.x)} ${f(m.y)}`; }
    return `${d} Z`;
  }
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  const m0 = mid(pts[0], pts[1]); d += ` L${f(m0.x)} ${f(m0.y)}`;
  for (let i = 1; i < pts.length - 1; i++) { const m = mid(pts[i], pts[i + 1]); d += ` Q${f(pts[i].x)} ${f(pts[i].y)} ${f(m.x)} ${f(m.y)}`; }
  const last = pts[pts.length - 1];
  return `${d} L${f(last.x)} ${f(last.y)}`;
}

export function buildTerrain(seed: string, bounds: Bounds, cell = 20): Terrain {
  const rand = mulberry32(hashSeed(seed));
  const noise = makeNoise(rand);
  const H = bounds.y1 - bounds.y0;
  const riverBase = bounds.y0 + H * (0.62 + 0.12 * (rand() - 0.5));
  const riverY = (x: number) => riverBase + 260 * (noise(x / 640, 11.3) - 0.5) + 70 * (noise(x / 170, 4.1) - 0.5);
  const height = (x: number, y: number) => {
    const valley = 0.24 * Math.exp(-(((y - riverY(x)) / 190) ** 2));
    return Math.max(0, Math.min(1, fbm(noise, x / 560, y / 560) * 1.15 - valley));
  };
  const cols = Math.floor((bounds.x1 - bounds.x0) / cell) + 1, rows = Math.floor((bounds.y1 - bounds.y0) / cell) + 1;
  const field: number[][] = [];
  for (let j = 0; j < rows; j++) { const row: number[] = []; for (let i = 0; i < cols; i++) row.push(height(bounds.x0 + i * cell, bounds.y0 + j * cell)); field.push(row); }
  const toWorld = (p: XY) => ({ x: bounds.x0 + p.x * cell, y: bounds.y0 + p.y * cell });

  const contours: Terrain['contours'] = [];
  for (let k = 1; k <= 22; k++) {
    const level = Number((k * 0.04).toFixed(2));
    const lines = contourLines(field, level).filter(l => l.length > 3);
    if (!lines.length) continue;
    const d = lines.map(l => smoothPath(l.map(toWorld), l[0] === l[l.length - 1])).join(' ');
    contours.push({ level, index: k % 5 === 0, d });
  }

  const river: XY[] = [];
  for (let x = bounds.x0 - 40; x <= bounds.x1 + 40; x += 30) river.push({ x, y: riverY(x) });

  const woods: Terrain['woods'] = [];
  for (let tries = 0; tries < 60 && woods.length < 10; tries++) {
    const cx = bounds.x0 + rand() * (bounds.x1 - bounds.x0), cy = bounds.y0 + rand() * H, r = 70 + rand() * 110;
    if (Math.abs(cy - riverY(cx)) < r + 50) continue;
    const pts: XY[] = [];
    for (let v = 0; v < 22; v++) {
      const a = (v / 22) * Math.PI * 2, wobble = 0.65 + 0.6 * noise(cx / 40 + Math.cos(a) * 1.7, cy / 40 + Math.sin(a) * 1.7);
      pts.push({ x: cx + Math.cos(a) * r * wobble, y: cy + Math.sin(a) * r * wobble * 0.8 });
    }
    woods.push({ d: smoothPath(pts, true) });
  }

  const peaks: { x: number; y: number; v: number }[] = [];
  const win = 3;
  for (let j = win; j < rows - win; j++) for (let i = win; i < cols - win; i++) {
    const v = field[j][i];
    if (v < 0.4) continue;
    let top = true;
    for (let dj = -win; dj <= win && top; dj++) for (let di = -win; di <= win; di++) if ((di || dj) && field[j + dj][i + di] >= v) { top = false; break; }
    if (top) peaks.push({ ...toWorld({ x: i, y: j }), v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const spots: Terrain['spots'] = [];
  for (const p of peaks) {
    if (spots.length >= 6) break;
    if (spots.some(s => Math.hypot(s.x - p.x, s.y - p.y) < 340)) continue;
    spots.push({ x: p.x, y: p.y, elev: Math.round(80 + p.v * 420) });
  }
  return { bounds, contours, river: { d: smoothPath(river) }, woods, spots };
}
