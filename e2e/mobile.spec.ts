import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { resetShared, signIn, watchErrors, errors as allErrors } from './helpers';

// WebKit warns about the viewport key interactive-widget (Chrome's keyboard mode); Safari ignores it.
const errors = (page: Page) => allErrors(page).filter(e => !/interactive-widget/.test(e));

// Portrait phones (iPhone 13 in WebKit, Pixel 7 in Chromium). Touch input:
// - Chromium: real touch through CDP Input.dispatchTouchEvent (the browser makes the pointer events).
// - WebKit: Playwright has no touch-move API, so the gestures are dispatched as touch PointerEvents
//   on the element under the finger. The browser-gesture checks then assert touch-action and that
//   visualViewport.scale stays 1.

type Pt = { x: number; y: number };
interface Touch { down(points: Pt[]): Promise<void>; move(points: Pt[]): Promise<void>; up(): Promise<void> }

async function touchFor(page: Page, browserName: string): Promise<Touch> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const pts = (points: Pt[]) => points.map((p, id) => ({ x: p.x, y: p.y, id }));
    return {
      down: async points => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(points) }); },
      move: async points => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(points) }); },
      up: async () => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); },
    };
  }
  let last: Pt[] = [];
  const fire = (type: string, points: Pt[]) => page.evaluate(({ type, points }) => {
    const svg = document.querySelector('svg.map-svg')!;
    points.forEach((p, i) => {
      const target = type === 'pointerdown' ? (document.elementFromPoint(p.x, p.y) ?? svg) : svg;
      target.dispatchEvent(new PointerEvent(type, { pointerId: 100 + i, pointerType: 'touch', isPrimary: i === 0, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
    });
  }, { type, points });
  return {
    down: async points => { last = points; await fire('pointerdown', points); },
    move: async points => { last = points; await fire('pointermove', points); },
    up: async () => { await fire('pointerup', last); },
  };
}

async function open(page: Page, context: BrowserContext, baseURL: string) {
  await signIn(context, 'alice');
  await resetShared(context, baseURL);
  // Skip the first-run orientation strip so it does not cover the dock.
  await context.addInitScript(() => { try { localStorage.setItem('opsmap.ui.oriented', 'yes'); } catch { /* storage blocked */ } });
  watchErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.locator('g.unit[data-unit-id]').first()).toBeVisible();
  await page.waitForTimeout(300);
}

const center = async (page: Page, selector: string): Promise<Pt> => {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** A screen point where a touch lands on the measure itself (label or outline), not a unit on top. */
const measurePoint = (page: Page, id: string): Promise<Pt> => page.evaluate(id => {
  // A finger is not a point: Chrome's touch adjustment snaps to a nearby button, so also require
  // that no unit sits within 14 px.
  const at = (x: number, y: number) => document.elementFromPoint(x, y);
  const clear = (x: number, y: number) => [[-14, 0], [14, 0], [0, -14], [0, 14], [-10, -10], [10, 10], [-10, 10], [10, -10]].every(([dx, dy]) => !at(x + dx, y + dy)?.closest('[data-unit-id]'));
  let strict = true;
  const hits = (x: number, y: number) => at(x, y)?.closest('[data-measure-id]')?.getAttribute('data-measure-id') === id && (!strict || clear(x, y));
  const g = document.querySelector(`g.measure[data-measure="${id}"]`)!;
  for (const t of g.querySelectorAll('text')) {
    const b = t.getBoundingClientRect();
    for (let fx = 0.5; fx > 0; fx -= 0.15) for (const x of [b.x + b.width * fx, b.x + b.width * (1 - fx)]) if (hits(x, b.y + b.height / 2)) return { x, y: b.y + b.height / 2 };
  }
  const path = g.querySelector('path.hit') as SVGPathElement, len = path.getTotalLength(), m = path.getScreenCTM()!;
  for (const pass of [true, false]) {
    strict = pass;
    for (let i = 0; i < 40; i++) { const p = path.getPointAtLength(len * i / 40).matrixTransform(m); if (hits(p.x, p.y)) return { x: p.x, y: p.y }; }
  }
  throw new Error(`No touchable point on ${id}`);
}, id);
const unitAt = (page: Page, id: string) => center(page, `g.unit[data-unit-id="${id}"] image`);
const zoom = async (page: Page) => Number(await page.locator('svg.map-svg').getAttribute('data-zoom'));
const transformOf = (page: Page, id: string) => page.locator(`g.unit[data-unit-id="${id}"]`).getAttribute('transform');

async function tap(t: Touch, p: Pt) { await t.down([p]); await t.up(); }
async function longPress(page: Page, t: Touch, p: Pt) { await t.down([p]); await page.waitForTimeout(650); }

test.beforeEach(async ({ page, context, baseURL }) => { await open(page, context, baseURL!); });
// No console errors or page errors in any mobile flow.
test.afterEach(async ({ page }) => { expect(errors(page)).toEqual([]); });

test('no horizontal overflow, and the chrome stays inside the viewport', async ({ page }) => {
  const m = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: innerWidth, scale: visualViewport?.scale ?? 1 }));
  expect(m.sw).toBeLessThanOrEqual(m.iw);
  expect(m.scale).toBe(1);
  // body clips overflow, so also check every piece of chrome: nothing ends past the right edge.
  const outside = await page.evaluate(() => [...document.querySelectorAll('.topbar *, .bottom *, [data-testid="sheet"] *')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && r.right > innerWidth + 0.5; })
    .map(el => el.className || el.tagName));
  expect(outside).toEqual([]);
  // Tap targets in the dock, top bar and sheet tabs are at least 44 px.
  for (const id of ['app-menu-button', 'command-send', 'sheet-tab-info', 'sheet-tab-log']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(Math.min(b.width, b.height), id).toBeGreaterThanOrEqual(44);
  }
  const input = page.getByTestId('command-input');
  for (const [attr, value] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['enterkeyhint', 'send']]) await expect(input).toHaveAttribute(attr, value);
  expect(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  expect(errors(page)).toEqual([]);
});

test('the menu holds views, SITREP, legend, theme, export and logout', async ({ page }) => {
  await page.getByTestId('app-menu-button').click();
  const menu = page.getByTestId('app-menu');
  await expect(menu).toBeVisible();
  for (const text of ['Commander', 'SITREP', 'Legend', 'Export JSON', 'Log out']) await expect(menu).toContainText(text);
  await expect(menu.getByTestId('theme-choice')).toBeVisible();
  await menu.getByRole('button', { name: 'Staff' }).click();
  await expect(menu.getByRole('button', { name: 'Staff' })).toHaveAttribute('aria-pressed', 'true');
  await menu.getByRole('button', { name: 'Gestures and help' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('gestures')).toContainText('Long-press a symbol, drag');
});

test('the menu lists maps, creates one and switches back', async ({ page }, info) => {
  const name = `Phone ${info.project.name}`;
  await page.getByTestId('app-menu-button').click();
  const menu = page.getByTestId('app-menu');
  await expect(menu.getByTestId('map-panel')).toBeVisible();
  await expect(menu.locator('[data-testid="map-option"][aria-current="true"] .label')).toHaveText('Main');
  await menu.getByTestId('map-new').click();
  await menu.getByTestId('map-name-input').fill(name);
  await menu.getByTestId('map-save').click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.locator('g.unit[data-unit-id]')).toHaveCount(0);
  await page.getByTestId('app-menu-button').click();
  await expect(menu.locator('[data-testid="map-option"][aria-current="true"] .label')).toHaveText(name);
  await menu.getByTestId('map-option').filter({ hasText: /^.?Main$/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('g.unit[data-unit-id]').first()).toBeVisible();
  const box = await page.getByTestId('app-menu-button').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(errors(page)).toEqual([]);
});

test('sends a /new order from the docked bar', async ({ page }) => {
  const input = page.getByTestId('command-input');
  await input.click();
  await expect(page.getByTestId('sheet')).toBeHidden();
  await input.fill('/new hostile coy fin "Tax notice" in Household near as TAX');
  await expect(page.getByTestId('command-preview')).toContainText('▸');
  // The suggestion list fits above the bar.
  await page.getByTestId('command-send').click();
  await expect(input).toHaveValue('');
  await expect(page.locator('g.unit[aria-label^="TAX:"]')).toHaveCount(1);
  await expect(page.getByTestId('command-preview')).toContainText('✓');
});

test('one tap opens and closes the sheet, from its tab or its grab bar', async ({ page, browserName }) => {
  const sheet = page.getByTestId('sheet');
  const tab = page.getByTestId('sheet-tab-info'), grab = page.getByTestId('sheet-grab');
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await tab.click();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  await tab.click();
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await grab.click();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  await expect(grab).toHaveAttribute('aria-expanded', 'true');
  await grab.click();
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  // Opened at full (a double-tap on a unit), it reopens at full next time.
  const t = await touchFor(page, browserName);
  const p = await unitAt(page, 'knee');
  await tap(t, p); await page.waitForTimeout(60); await tap(t, p);
  await expect(sheet).toHaveAttribute('data-size', 'full');
  await tab.click();
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await tab.click();
  await expect(sheet).toHaveAttribute('data-size', 'full');
  // The other tab switches without closing.
  await page.getByTestId('sheet-tab-log').click();
  await expect(sheet).toHaveAttribute('data-size', 'full');
  await expect(sheet).toHaveAttribute('data-tab', 'log');
});

test('tap opens the inspector at peek; double-tap and long-press-release open it full', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet');
  await tap(t, await unitAt(page, 'knee'));
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await expect(sheet).toHaveAttribute('data-tab', 'info');
  await expect(page.getByTestId('inspector')).toContainText('Knee pain after running');

  // Collapse, then double-tap: full.
  await page.getByRole('button', { name: 'Close inspector' }).click();
  const p = await unitAt(page, 'knee');
  await tap(t, p); await page.waitForTimeout(60); await tap(t, p);
  await expect(sheet).toHaveAttribute('data-size', 'full');
  await expect(page.getByTestId('inspector')).toContainText('Rating (Admiralty)');

  // Back to peek, then long-press and let go without moving: full again, unit not moved.
  await page.getByTestId('sheet-tab-info').click();
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await page.waitForTimeout(400);
  const before = await transformOf(page, 'run');
  await longPress(page, t, await unitAt(page, 'run'));
  await expect(page.locator('g.unit.lifted[data-unit-id="run"]')).toHaveCount(1);
  await t.up();
  await expect(sheet).toHaveAttribute('data-size', 'full');
  await expect(page.getByTestId('inspector')).toContainText('RUN');
  expect(await transformOf(page, 'run')).toBe(before);
});

test('long-press then drag moves a unit; a plain drag pans instead', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  // A drag that starts on a unit without the long-press pans the map.
  const start = await transformOf(page, 'passport');
  const viewBefore = await page.locator('svg.map-svg > g').first().getAttribute('transform');
  let p = await unitAt(page, 'passport');
  await t.down([p]);
  for (let i = 1; i <= 6; i++) await t.move([{ x: p.x - 6 * i, y: p.y - 4 * i }]);
  await t.up();
  await expect.poll(() => page.locator('svg.map-svg > g').first().getAttribute('transform')).not.toBe(viewBefore);
  expect(await transformOf(page, 'passport')).toBe(start);

  // Long-press, then drag: one move op.
  p = await unitAt(page, 'passport');
  await longPress(page, t, p);
  for (let i = 1; i <= 8; i++) await t.move([{ x: p.x - 5 * i, y: p.y - 7 * i }]);
  await t.up();
  await expect.poll(() => transformOf(page, 'passport')).not.toBe(start);
  await page.getByTestId('sheet-tab-log').click();
  await expect(page.getByTestId('order-log')).toContainText('MOVE PASSPORT');
  expect(errors(page)).toEqual([]);
});

test('a second finger during a drag cancels it and pinches the map, not the page', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const svg = page.locator('svg.map-svg');
  await expect(svg).toHaveCSS('touch-action', 'none');
  await expect(page.locator('.opsmap')).toHaveCSS('touch-action', 'none');
  const k0 = await zoom(page);
  const start = await transformOf(page, 'q4rpt');
  const p = await unitAt(page, 'q4rpt');
  await longPress(page, t, p);
  await t.move([{ x: p.x + 4, y: p.y + 4 }]);
  // Second finger lands: the lifted unit drops back, and the two fingers spread apart.
  const o = { x: p.x + 60, y: p.y + 60 };
  await t.down([{ x: p.x + 4, y: p.y + 4 }, o]);
  for (let i = 1; i <= 6; i++) await t.move([{ x: p.x + 4 - 10 * i, y: p.y + 4 - 10 * i }, { x: o.x + 10 * i, y: o.y + 10 * i }]);
  await t.up();
  await expect.poll(() => zoom(page)).toBeGreaterThan(k0 * 1.3);
  expect(await transformOf(page, 'q4rpt')).toBe(start);
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  await expect(page.locator('g.unit.lifted')).toHaveCount(0);
});

test('double-tap on open ground zooms the map; long-press offers capture', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const k0 = await zoom(page);
  const box = (await page.locator('svg.map-svg').boundingBox())!;
  const ground = { x: box.x + 30, y: box.y + box.height * 0.6 };
  await tap(t, ground); await page.waitForTimeout(60); await tap(t, ground);
  await expect.poll(() => zoom(page)).toBeGreaterThan(k0 * 1.5);
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await longPress(page, t, ground);
  await t.up();
  await expect(page.getByTestId('capture-menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'New problem (hostile)' }).click();
  await expect(page.getByTestId('command-input')).toHaveValue(/^\/new hostile "" in \w+ \w+$/);
  expect(errors(page)).toEqual([]);
});

test('long-press on open ground starts a hostile HQ', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const box = (await page.locator('svg.map-svg').boundingBox())!;
  const ground = { x: box.x + 30, y: box.y + box.height * 0.6 };
  await longPress(page, t, ground);
  await t.up();
  await page.getByRole('menuitem', { name: 'New hostile HQ' }).click();
  await expect(page.getByTestId('command-input')).toHaveValue(/^\/new hostile hq "" in \w+ \w+$/);
  expect(errors(page)).toEqual([]);
});

test('long-press drags an NAI to new ground, and it stays there after reload', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const label = 'g.measure[data-measure="nai-benefits"] text.m-type';
  const x0 = await page.locator(label).getAttribute('x');
  const p = await measurePoint(page, 'nai-benefits');
  await longPress(page, t, p);
  for (let i = 1; i <= 8; i++) await t.move([{ x: p.x - 8 * i, y: p.y + 6 * i }]);
  await t.up();
  await expect.poll(() => page.locator(label).getAttribute('x')).not.toBe(x0);
  const moved = await page.locator(label).getAttribute('x');
  await page.getByTestId('sheet-tab-log').click();
  await expect(page.getByTestId('order-log')).toContainText('NAI BENEFITS ENROLLMENT MOVED');
  await expect(page.getByTestId('pending-count')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.locator(label)).toHaveAttribute('x', moved!);

  // Long-press and let go on the NAI: its card.
  await page.waitForTimeout(300);
  await longPress(page, t, await measurePoint(page, 'nai-benefits'));
  await t.up();
  await expect(page.getByTestId('measure-card')).toContainText('BENEFITS ENROLLMENT');
});

test('a pinch on the top bar or the command bar never zooms the page (real touch)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real multi-touch needs CDP (Chromium)');
  const t = await touchFor(page, browserName);
  for (const testId of ['dtg', 'command-input', 'sheet-tab-log']) {
    const c = await center(page, `[data-testid="${testId}"]`);
    await t.down([{ x: c.x - 10, y: c.y }, { x: c.x + 10, y: c.y }]);
    for (let i = 1; i <= 8; i++) await t.move([{ x: c.x - 10 - 15 * i, y: c.y - 4 * i }, { x: c.x + 10 + 15 * i, y: c.y + 4 * i }]);
    await t.up();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => visualViewport?.scale ?? 1), testId).toBe(1);
  }
  await expect(page.locator('body')).toHaveCSS('touch-action', 'pan-x pan-y');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /user-scalable=no/);
});

test('every drawn unit label sits nearest its own symbol, inside the screen', async ({ page }) => {
  for (const view of ['Commander', 'Staff']) {
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('app-menu').getByRole('button', { name: view }).click();
    await page.getByTestId('app-menu-button').click();
    await page.waitForTimeout(300);
    const bad = await page.evaluate(() => {
      // The unit's anchor (frame center) is the center of its hit rect; the image also holds echelon marks.
      const centers = [...document.querySelectorAll('g.unit[data-unit-id]')].map(g => { const r = g.querySelector('rect[fill="transparent"]')!.getBoundingClientRect(); return { id: g.getAttribute('data-unit-id')!, x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const dist = (p: { x: number; y: number }, b: DOMRect) => Math.hypot(Math.max(b.x - p.x, 0, p.x - b.right), Math.max(b.y - p.y, 0, p.y - b.bottom));
      const out: string[] = [];
      for (const g of document.querySelectorAll('.unit-labels > g[data-unit-id]')) {
        const id = g.getAttribute('data-unit-id')!, b = g.querySelector('rect.label-ground')!.getBoundingClientRect();
        const own = dist(centers.find(c => c.id === id)!, b);
        const other = centers.filter(c => c.id !== id).map(c => ({ id: c.id, d: dist(c, b) })).sort((a, z) => a.d - z.d)[0];
        if (other.d <= own) out.push(`${id} nearer ${other.id}`);
        if (b.left < 0 || b.right > innerWidth) out.push(`${id} off screen`);
      }
      return { out, n: document.querySelectorAll('.unit-labels > g[data-unit-id]').length };
    });
    expect(bad.out, view).toEqual([]);
    expect(bad.n, view).toBeGreaterThanOrEqual(10);
  }
});

test('a pending unit gets identity and effort chips; the menu inbox opens the situation', async ({ page, browserName }) => {
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('menu-inbox').click();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-size', 'half');
  await expect(page.getByTestId('situation-inbox')).toBeInViewport();
  const t = await touchFor(page, browserName);
  await tap(t, await unitAt(page, 'tools'));
  const chips = page.getByTestId('triage-identity');
  await expect(chips).toBeVisible();
  await page.getByTestId('triage-effort').getByRole('button', { name: '3–8 h' }).click();
  await chips.getByRole('button', { name: 'Hostile' }).click();
  await expect(page.getByTestId('inspector')).toContainText('Hostile ·');
  await expect(page.getByTestId('triage-identity')).toHaveCount(0);
});

test('landscape phone: the sheet is a side column and the map keeps the full height', async ({ page }) => {
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.height, height: vp.width });
  await page.waitForTimeout(400);
  const sheet = (await page.getByTestId('sheet').boundingBox())!;
  const vw = vp.height, vh = vp.width;
  expect(sheet.x + sheet.width).toBeGreaterThan(vw - 2);
  expect(sheet.width).toBeLessThan(vw * 0.5);
  expect(sheet.height).toBeGreaterThan(vh * 0.4);
  const svg = (await page.locator('svg.map-svg').boundingBox())!;
  expect(svg.height).toBeGreaterThanOrEqual(vh - 1);
  const m = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: innerWidth }));
  expect(m.sw).toBeLessThanOrEqual(m.iw);
});
