import { describe, expect, it } from 'vitest';
import { seedDoc } from '../../src/core/model/seed';
import { buildScene } from '../../src/lib/map/scene';
import { fitTransform, mapScale } from '../../src/lib/map/panzoom';
import { mapLabels, visibleWorld } from '../../src/lib/map/maplabels';
import { boxDistance } from '../../src/lib/map/labels';

// The phone map at its fitted zoom, as OpsMap computes it (compact symbols, 12 px text floor, decluttered
// commander view, staggered phase lines). Chrome: 44 px top bar, about 90 px dock and the 52 px sheet header.
const now = new Date(2026, 10, 9, 12);
const PHONES = { 'iPhone SE': [320, 568], 'iPhone 13': [390, 664], 'Pixel 7': [412, 839] } as const;

function phoneLabels(width: number, height: number, view: 'commander' | 'staff' = 'commander', selectedId: string | null = null) {
  const doc = seedDoc(now);
  doc.settings.view = view;
  const insets = { top: 48, right: 0, bottom: 90 + 52 + 4, left: 0 };
  const fit = fitTransform(width, height, insets, 14), k = fit.k;
  const s = mapScale(k, k) * Math.max(1, Math.min(1.3, k / 0.64)) * 0.72;
  const mt = 12 / k, ls = Math.max(1, 12 / (10.5 * s * k));
  const declutter = view === 'commander';
  const scene = buildScene(doc, { view, now, selectedId, symbolScale: s, plFont: Math.max(8.5 * s, mt), compactPl: true });
  const bounds = visibleWorld(fit, width, height, insets, 4);
  return { scene, bounds, labels: mapLabels(doc, scene, { s, ls, mt, declutter, bounds, maxOffset: 48 }) };
}

describe('unit labels on phones sit by their own symbol', () => {
  for (const [name, [w, h]] of Object.entries(PHONES)) {
    for (const view of ['commander', 'staff'] as const) {
      it(`${name}, ${view}: each label's nearest symbol is its own, and the label is on screen`, () => {
        const { scene, bounds, labels } = phoneLabels(w, h, view);
        
        // Of about 13 candidates, labels that cannot sit cleanly by their own symbol are dropped (they show on
        // selection or zoom). The 320 px SE keeps fewer.
        expect(labels.size).toBeGreaterThanOrEqual(w < 360 ? 6 : 10);
        const boxes = [...labels.values()].map(l => l.box);
        const overlap = (a: typeof boxes[0], b: typeof boxes[0]) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(boxes.some((a, i) => boxes.some((b, j) => i < j && overlap(a, b))), 'labels overlap').toBe(false);
        for (const [id, label] of labels) {
          const own = scene.units.find(u => u.id === id)!;
          const dOwn = boxDistance(own, label.box);
          const nearest = scene.units.filter(u => u.id !== id).map(u => ({ id: u.id, d: boxDistance(u, label.box) })).sort((a, b) => a.d - b.d)[0];
          expect(nearest.d, `${id} label is nearer ${nearest.id}`).toBeGreaterThan(dOwn);
          const b = label.box;
          expect(b.x >= bounds.x && b.y >= bounds.y && b.x + b.width <= bounds.x + bounds.width && b.y + b.height <= bounds.y + bounds.height, `${id} label off screen`).toBe(true);
        }
      });
    }
  }
  it('the selected unit always keeps its label', () => {
    for (const id of ['leak', 'records', 'landlord', 'files']) expect(phoneLabels(390, 664, 'commander', id).labels.has(id)).toBe(true);
  });
});
