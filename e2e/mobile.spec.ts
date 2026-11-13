import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { command, resetShared, signIn, watchErrors, errors as allErrors } from './helpers';

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

test('the menu opens access tokens, which fit the phone and create a token', async ({ page }, info) => {
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('app-menu').getByTestId('menu-tokens').click();
  const panel = page.getByTestId('access-tokens');
  await expect(panel).toBeVisible();
  await panel.getByTestId('tk-name').fill(`phone ${info.project.name}`);
  await panel.getByTestId('tk-create').click();
  await expect(panel.getByTestId('tk-secret')).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  const box = (await panel.boundingBox())!, width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const revoke = panel.locator(`[data-testid="tk-row"][data-name="phone ${info.project.name}"]`).getByTestId('tk-revoke');
  await revoke.click(); await revoke.click();
  await expect(panel.getByTestId('tk-created')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close access tokens' }).click();
  await expect(panel).toHaveCount(0);
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
  // Opened at full (a double-tap on a unit), it reopens at full next time. (Once the sheet has finished closing: half covers KNEE.)
  await page.waitForTimeout(300);
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
  const card = page.getByTestId('measure-card');
  await expect(card).toContainText('BENEFITS ENROLLMENT');
  // The card stays above the sheet: Remove and Close are in reach, not under it.
  for (const name of ['Remove', 'Close']) {
    const button = card.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    await expect.poll(async () => {
      const b = (await button.boundingBox())!, sheet = (await page.getByTestId('sheet').boundingBox())!;
      return b.y + b.height <= sheet.y;
    }).toBe(true);
  }
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

test('the composer opens the sheet at full; a map pick drops it to peek and back; Run matches the bar', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet');
  await tap(t, await unitAt(page, 'records'));
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await page.getByTestId('unit-order').click();
  await expect(sheet).toHaveAttribute('data-size', 'full');
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  // The preview and Run / To bar / Cancel stay pinned in view, 44 px tall.
  await expect(composer.getByTestId('composer-preview')).toBeInViewport();
  const run = composer.getByTestId('composer-run');
  await expect(run).toBeInViewport();
  expect((await run.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Long-press a control: its command in a bubble, nothing runs.
  const moving = composer.locator('[data-verb="moving"]');
  await moving.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, isPrimary: true });
  await expect(page.getByTestId('cmd-bubble')).toContainText('/moving');
  await moving.dispatchEvent('pointerup', { pointerType: 'touch', button: 0, isPrimary: true });
  await expect(composer.locator('[data-verb="attack"]')).toHaveAttribute('aria-checked', 'true');

  // A control low in the sheet scrolls the sheet body, never the app shell (the top bar stays in place).
  const appScroll = () => page.locator('.app').evaluate(el => el.scrollTop);
  const planned = composer.getByTestId('composer-planned');
  await planned.focus();
  await page.keyboard.press('Space');
  await expect(planned).toBeChecked();
  expect(await appScroll()).toBe(0);
  await page.keyboard.press('Space');
  await expect(planned).not.toBeChecked();

  // Map: the sheet drops to the pick banner at peek; a tap on a ringed threat picks it; the sheet returns to full.
  await composer.getByTestId('composer-pick-map').click();
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  const banner = page.getByTestId('pick-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('/attack RECORDS');
  await page.waitForTimeout(250);
  await tap(t, await unitAt(page, 'leak'));
  await expect(banner).toHaveCount(0);
  await expect(sheet).toHaveAttribute('data-size', 'full');
  await expect(composer.getByTestId('composer-target')).toHaveValue('LEAK');
  await expect(composer.getByTestId('composer-preview')).toContainText('/attack RECORDS LEAK');
  await run.click();
  await expect(composer).toHaveCount(0);
  expect(await appScroll()).toBe(0);
  const preview = page.getByTestId('command-preview');
  await expect(preview).toContainText('✓');
  const line = (await preview.innerText()).trim();
  const input = page.getByTestId('command-input');
  for (const text of ['/undo', '/attack RECORDS LEAK']) {
    await input.click();
    await input.fill(text);
    await page.getByTestId('command-send').click();
    await expect(input).toHaveValue('');
  }
  await expect(preview).toHaveText(line);
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

/** Run text in the docked bar, then leave the bar so the sheet shows again. */
async function bar(page: Page, text: string) {
  const input = page.getByTestId('command-input');
  await input.click();
  await input.fill(text);
  await expect(page.getByTestId('command-preview')).toContainText('▸');
  await page.getByTestId('command-send').click();
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('command-preview')).toContainText('✓');
  await input.blur();
}
/** The control's log line equals the one the same text gives in the bar. */
async function sameAsBar(page: Page, text: string) {
  const preview = page.getByTestId('command-preview');
  const fromControl = (await preview.innerText()).trim();
  await bar(page, '/undo');
  await bar(page, text);
  await expect(preview).toHaveText(fromControl);
}

test('peek is 176 px for a unit, an area, a phase line and a sector (284 with triage), with one filled verb and More', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet'), tab = page.getByTestId('sheet-tab-info'), inspector = page.getByTestId('inspector');
  const height = async () => Math.round((await sheet.boundingBox())!.height);
  await tap(t, await unitAt(page, 'knee'));
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  await expect.poll(height).toBe(176);
  // A unit: + Order filled, one outlined action, then More; Block and Drop wait under More.
  const actions = inspector.getByTestId('unit-actions');
  await expect(actions.getByTestId('unit-order')).toHaveClass(/primary/);
  await expect(actions.getByTestId('unit-order')).toBeInViewport();
  await expect(actions.locator('button.btn')).toHaveCount(2);
  await expect(actions.getByTestId('peek-more')).toBeInViewport();

  // An area: a tap selects it and opens its peek (no card); the tab names it.
  await tap(t, await measurePoint(page, 'obj-settled'));
  await expect(inspector).toHaveAttribute('data-kind', 'area');
  await expect(page.getByTestId('measure-card')).toHaveCount(0);
  await expect(tab).toContainText('OBJ');
  await expect(tab).toContainText('SETTLED IN');
  await expect.poll(height).toBe(176);
  await expect(inspector.getByTestId('view-status')).toBeInViewport();
  await expect(inspector.getByTestId('measure-order')).toBeInViewport();
  await expect(inspector.getByTestId('measure-order')).toHaveClass(/primary/);
  const more = inspector.getByTestId('peek-more');
  await expect(more).toBeInViewport();
  await expect(more).toHaveCSS('border-top-style', 'none');
  await expect(more).toHaveCSS('text-decoration-line', 'underline');

  await bar(page, '/find pl LAUNCH');
  await expect(inspector).toHaveAttribute('data-kind', 'pl');
  await expect(tab).toContainText('PL');
  await expect.poll(height).toBe(176);
  await expect(inspector.getByTestId('pl-redate')).toBeInViewport();

  await bar(page, '/find sector Work');
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  await expect(tab).toContainText('SEC');
  await expect.poll(height).toBe(176);
  await expect(inspector.getByTestId('new-unit-open')).toBeInViewport();

  // A pending unit adds its triage chips.
  await tap(t, await unitAt(page, 'tools'));
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  await expect.poll(height).toBe(284);
  // More opens half, where Block and Drop are back.
  await actions.getByTestId('peek-more').click();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  await expect(actions.getByTestId('unit-drop')).toBeVisible();
  await expect(actions.getByTestId('peek-more')).toHaveCount(0);
});

test('phone area view: More opens half with section chips; join two units at once; size it', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet'), inspector = page.getByTestId('inspector');
  await tap(t, await measurePoint(page, 'obj-settled'));
  await inspector.getByTestId('peek-more').click();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  const chips = inspector.getByTestId('section-index');
  await expect(chips).toContainText('Place');
  await expect(chips).toContainText('Manage');
  await chips.getByRole('button', { name: /Members/ }).click();
  await expect(inspector.getByTestId('section-members')).toBeInViewport();
  await inspector.getByTestId('measure-join-open').click();
  const list = inspector.getByTestId('measure-join-list');
  await list.getByRole('checkbox', { name: /PACKING/ }).check();
  await list.getByRole('checkbox', { name: /RECORDS/ }).check();
  await inspector.getByTestId('measure-join').click();
  await expect(page.getByTestId('command-preview')).toContainText('JOINED OBJ SETTLED IN');
  await expect(inspector.getByTestId('area-members')).toContainText('PACKING');
  await sameAsBar(page, '/obj join "SETTLED IN" PACKING RECORDS');
  await inspector.getByTestId('measure-size').getByRole('radio', { name: 'XL' }).click();
  await expect(page.getByTestId('command-preview')).toContainText('OBJ SETTLED IN SIZE XL');
  await sameAsBar(page, '/obj size "SETTLED IN" xl');
});

test('phone phase line and sector views: re-date with the ring note, set a width', async ({ page }) => {
  const sheet = page.getByTestId('sheet'), inspector = page.getByTestId('inspector');
  const day = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  await bar(page, '/find pl LAUNCH');
  await inspector.getByTestId('peek-more').click();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  const date = inspector.getByTestId('pl-date');
  await date.fill(day(5));
  await expect(inspector.getByTestId('pl-ring')).toHaveText('Lands in the Close ring.');
  await date.blur();
  await expect(page.getByTestId('command-preview')).toContainText(`PL LAUNCH DATED ${day(5)}`);
  await sameAsBar(page, `/pl date LAUNCH ${day(5)}`);

  await bar(page, '/find sector Work');
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  await inspector.getByTestId('sector-width').fill('100');
  await expect(inspector.getByTestId('sector-width-note')).toContainText('Others scale to share 260°');
  await inspector.getByTestId('sector-width-set').click();
  await expect(page.getByTestId('command-preview')).toContainText('SECTOR WIDTH');
  await sameAsBar(page, '/sector width Work 100');
});

test('tapping a collapsed task force\'s count expands it without opening the sheet', async ({ page }) => {
  await command(page, '/collapse MOVE');
  const badge = page.locator('g.unit[data-unit-id="move"] [data-testid="tf-stack"]');
  await expect(badge).toHaveAttribute('data-count', '2');
  await expect(page.locator('g.unit[data-unit-id="packing"]')).toHaveCount(0);
  const size = await page.getByTestId('sheet').getAttribute('data-size');
  await badge.tap();
  await expect(page.locator('g.unit[data-unit-id="packing"]')).toHaveCount(1);
  await expect(badge).toHaveCount(0);
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-size', size ?? '');
});

/** The element is the topmost one at its own center: nothing covers it (a checkbox counts through its label). */
const onTop = (l: ReturnType<Page['locator']>) => l.evaluate(el => {
  const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit) || !!hit.closest('label')?.contains(el));
});

test('the attack composer on a phone: Run, Role and Planned are on top before and after a target is picked', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet');
  await tap(t, await unitAt(page, 'records'));
  await page.getByTestId('unit-order').click();
  await expect(sheet).toHaveAttribute('data-size', 'full');
  const composer = page.getByTestId('composer'), target = composer.getByTestId('composer-target');
  await expect(composer.locator('[data-verb="attack"]')).toHaveAttribute('aria-checked', 'true');
  // No autofocus on a phone: the keyboard and the target list would cover the options and Run.
  await expect(target).not.toBeFocused();
  await expect(composer.getByRole('listbox')).toHaveCount(0);
  await page.waitForTimeout(300);
  const controls = [composer.getByTestId('composer-run'), ...await composer.getByTestId('composer-role').getByRole('radio').all(), composer.getByTestId('composer-planned'), target];
  for (const c of controls) expect(await onTop(c), await c.evaluate(e => e.textContent || e.outerHTML.slice(0, 60))).toBe(true);
  // A tap opens the list in the flow: it pushes Role down instead of covering it.
  await target.click();
  const list = composer.getByRole('listbox');
  await expect(list).toBeVisible();
  const lb = (await list.boundingBox())!, rb = (await composer.getByTestId('composer-role').boundingBox())!;
  expect(rb.y).toBeGreaterThanOrEqual(lb.y + lb.height);
  await list.getByRole('option', { name: /LEAK/ }).click();
  await expect(target).toHaveValue('LEAK');
  await expect(list).toHaveCount(0);
  await page.waitForTimeout(400);
  for (const c of controls) expect(await onTop(c), await c.evaluate(e => e.textContent || e.outerHTML.slice(0, 60))).toBe(true);
  await composer.getByTestId('composer-role').getByRole('radio', { name: 'Main' }).click();
  await expect(composer.getByTestId('composer-preview')).toContainText('/attack RECORDS LEAK main');
});

test('with the keyboard up, a focused field in the sheet stays in view and uncovered', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const vp = page.viewportSize()!;
  await tap(t, await unitAt(page, 'records'));
  await page.getByTestId('unit-order').click();
  const composer = page.getByTestId('composer'), target = composer.getByTestId('composer-target');
  await target.click();
  await expect(target).toBeFocused();
  // The keyboard: the page gets 300 px shorter (Android resizes the layout viewport).
  await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
  try {
    await page.waitForTimeout(500);
    // The sheet takes the room: the command bar steps aside, the field and the first suggestions show.
    await expect(page.getByTestId('command-input')).toBeHidden();
    await expect(target).toBeInViewport({ ratio: 1 });
    expect(await onTop(target)).toBe(true);
    const first = composer.getByRole('listbox').getByRole('option').first();
    await expect(first).toBeInViewport({ ratio: 1 });
    expect(await onTop(first)).toBe(true);
    // Still a portrait phone: the keyboard does not turn the layout into the landscape column.
    const sheet = (await page.getByTestId('sheet').boundingBox())!;
    expect(sheet.width).toBeGreaterThan(vp.width - 2);
  } finally {
    await target.blur();
    await page.setViewportSize(vp);
  }
  await expect(page.getByTestId('command-input')).toBeVisible();
});

test('a swipe up on the peek card opens the sheet; nothing scrolls under the close button', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet');
  await tap(t, await unitAt(page, 'records'));
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  const close = page.locator('.peek-close');
  /** Text or a control in the card that shows under the ✕. */
  const overlap = () => close.evaluate(x => {
    const a = x.getBoundingClientRect(), box = x.closest('.inspector')!.querySelector('.scroll')!.getBoundingClientRect();
    return [...x.closest('.inspector')!.querySelectorAll('.scroll *')].filter(el => {
      if (el.children.length && !el.matches('button, img, input')) return false;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.bottom <= box.top || b.top >= box.bottom) return false;
      return b.left < a.right && a.left < b.right && b.top < a.bottom && a.top < b.bottom;
    }).map(el => el.textContent?.trim() || el.tagName);
  });
  expect(await overlap()).toEqual([]);
  // On the card's status line, between the header and the action row (once the sheet has risen to peek).
  await page.waitForTimeout(300);
  const status = (await page.getByTestId('inspector').locator('.scroll').boundingBox())!;
  const from = { x: status.x + status.width / 2, y: status.y + 56 };
  if (browserName === 'chromium') {
    await t.down([from]);
    for (let i = 1; i <= 5; i++) await t.move([{ x: from.x, y: from.y - i * 15 }]);
    await t.up();
  } else {
    // WebKit: touch PointerEvents on the element under the finger.
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)!;
      const fire = (type: string, cy: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
      fire('pointerdown', y);
      for (let i = 1; i <= 5; i++) fire('pointermove', y - i * 15);
      fire('pointerup', y - 75);
    }, from);
  }
  await expect(sheet).toHaveAttribute('data-size', 'half');
  await expect(close).toHaveCount(0);
  // At peek the card's body never scrolls.
  await page.getByTestId('sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-size', 'peek');
  const scroll = page.locator('[data-testid="sheet"] .scroll');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  expect(await scroll.evaluate(el => getComputedStyle(el).overflowY)).toBe('hidden');
  expect(await overlap()).toEqual([]);
});

test('the capture menu opens above the open sheet, clear of the top bar', async ({ page, browserName }) => {
  const t = await touchFor(page, browserName);
  const sheet = page.getByTestId('sheet');
  await page.getByTestId('sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  await page.waitForTimeout(300);
  const sb = (await sheet.boundingBox())!, top = (await page.locator('.topbar').boundingBox())!;
  // The half sheet covers the rings: a plain drag pans them up into the strip of map above it.
  const x0 = sb.width / 2;
  await t.down([{ x: x0, y: sb.y - 20 }]);
  for (let i = 1; i <= 8; i++) await t.move([{ x: x0, y: sb.y - 20 - i * 30 }]);
  await t.up();
  await page.waitForTimeout(300);
  // Open ground just above the sheet: a menu below the finger would land on the sheet.
  const ground = await page.evaluate(({ from, to }) => {
    // From the middle outward: ground off the map's rings belongs to no sector and offers no capture.
    const xs = Array.from({ length: Math.floor(innerWidth / 24) }, (_, i) => innerWidth / 2 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 12).filter(x => x > 30 && x < innerWidth - 30);
    for (let y = from; y > to; y -= 6) for (const x of xs) {
      const e = document.elementFromPoint(x, y);
      const busy = '[data-unit-id],[data-measure-id],[data-sector-id],[data-interactive],[role="button"],.map-controls';
      const clear = [[-14, 0], [14, 0], [0, -14], [0, 14]].every(([dx, dy]) => { const n = document.elementFromPoint(x + dx, y + dy); return n?.closest('svg.map-svg') && !n.closest(busy); });
      // Inside a sector's wedge (open ground on the map, not the terrain past its edge).
      if (e?.matches('path.wedge') && clear) return { x, y };
    }
    return null;
  }, { from: Math.round(sb.y - 24), to: Math.round(top.y + top.height + 60) });
  expect(ground).not.toBeNull();
  await longPress(page, t, ground!);
  await t.up();
  const menu = page.getByTestId('capture-menu');
  await expect(menu).toBeVisible();
  await expect(sheet).toHaveAttribute('data-size', 'half');
  const mb = (await menu.boundingBox())!;
  expect(mb.y + mb.height).toBeLessThanOrEqual(sb.y + 1);
  expect(mb.y).toBeGreaterThanOrEqual(top.y + top.height);
  for (const item of await menu.getByRole('menuitem').all()) expect(await onTop(item), await item.innerText()).toBe(true);
  await menu.getByRole('menuitem', { name: 'Cancel' }).click();
  await expect(menu).toHaveCount(0);
});
