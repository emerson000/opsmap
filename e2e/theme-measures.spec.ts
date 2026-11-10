import { test, expect, type Page } from '@playwright/test';
import { errors, openMap, resetShared, signIn, watchErrors } from './helpers';

const html = (page: Page) => page.locator('html');
const themeColor = (page: Page) => page.locator('meta[name="theme-color"]').getAttribute('content');

test('theme follows the system live until overridden; the override survives reload; System clears it', async ({ page, context, baseURL }) => {
  await signIn(context, 'alice');
  await resetShared(context, baseURL!);
  watchErrors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await openMap(page);
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  expect(await themeColor(page)).toBe('#111814');
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveAttribute('aria-label', /^Theme: System \(night\)/);

  // Live: no reload.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-label', /^Theme: System \(day\)/);
  expect(await themeColor(page)).toBe('#f6f1e3');

  // System → Day: an override, stored in this browser only.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', /^Theme: Day/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('opsmap.ui.theme'))).toBe('light');

  // Day → Night → System: the stored value goes away and the OS wins again.
  await page.getByTestId('theme-toggle').click();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-toggle').click();
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('opsmap.ui.theme'))).toBeNull();
  expect(errors(page)).toEqual([]);
});

test('first paint uses the stored theme before the app loads', async ({ page, context }) => {
  await signIn(context, 'alice');
  await context.addInitScript(() => localStorage.setItem('opsmap.ui.theme', 'dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  // Block the app bundle: only index.html and theme-init.js run.
  await page.route(/\/assets\/.*\.js$/, route => route.abort());
  await page.goto('/');
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  expect(await themeColor(page)).toBe('#111814');
});

test('desktop: drag an NAI by its label; the move persists after reload', async ({ page, context, baseURL }) => {
  await signIn(context, 'alice');
  await resetShared(context, baseURL!);
  watchErrors(page);
  await openMap(page);
  const label = 'g.measure[data-measure="nai-benefits"] text.m-type';
  const x0 = await page.locator(label).getAttribute('x');
  const b = (await page.locator(label).boundingBox())!;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + 6 * i, cy + 8 * i);
  await page.mouse.up();
  await expect.poll(() => page.locator(label).getAttribute('x')).not.toBe(x0);
  const moved = await page.locator(label).getAttribute('x');
  await page.getByRole('button', { name: 'Open order log', exact: true }).click();
  await expect(page.getByTestId('order-log')).toContainText('NAI BENEFITS ENROLLMENT MOVED');
  await expect(page.getByTestId('pending-count')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.locator(label)).toHaveAttribute('x', moved!);

  // Double-click the label: the measure card; Remove deletes it (undoable). Dispatched on the label, since
  // after the move a unit label may sit on top of it.
  await page.locator(label).dispatchEvent('dblclick');
  await expect(page.getByTestId('measure-card')).toContainText('Named area of interest');
  await page.getByTestId('measure-card').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator(label)).toHaveCount(0);
  expect(errors(page)).toEqual([]);
});

test('desktop: attack by handle gives a toast with undo and the new arrow animates in', async ({ page, context, baseURL }) => {
  await signIn(context, 'alice');
  await resetShared(context, baseURL!);
  watchErrors(page);
  await openMap(page);
  // RECORDS and LEAK share the Household sector (cross-sector attacks need a task force).
  await page.locator('g.unit[data-unit-id="records"]').click();
  const h = (await page.getByTestId('attack-handle').boundingBox())!;
  const target = (await page.locator('g.unit[data-unit-id="leak"] image').boundingBox())!;
  const before = await page.locator('g.order[data-order-id]').count();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  const tx = target.x + target.width / 2, ty = target.y + target.height / 2;
  for (let i = 1; i <= 10; i++) await page.mouse.move(h.x + (tx - h.x) * i / 10, h.y + (ty - h.y) * i / 10);
  await expect(page.locator('text.link-name')).toContainText('LEAK');
  await page.mouse.up();
  await expect(page.getByTestId('toasts')).toContainText('RECORDS ATTACKS LEAK');
  await expect(page.locator('g.order.fresh')).toHaveCount(1);
  await expect(page.locator('g.order[data-order-id]')).toHaveCount(before + 1);
  await page.getByTestId('toasts').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('g.order[data-order-id]')).toHaveCount(before);
  expect(errors(page)).toEqual([]);
});
