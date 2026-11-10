import { test, expect, type Page } from '@playwright/test';
import { command, errors, openLog, openMap, userPage } from './helpers';

// Smoke test against the real server in dev mode: load → seeded symbols → /new → /attack → drag → reload →
// state persists on the server. No console errors.

async function closeSitrep(page: Page) {
  const close = page.getByRole('button', { name: 'Close SITREP' });
  if (await close.isVisible()) await close.click();
  await expect(page.getByTestId('sitrep')).toHaveCount(0);
}

const transformOf = (page: Page, selector: string) => page.locator(selector).first().getAttribute('transform');

test('demo flow: capture, attack, drag, reload', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const units = page.locator('g.unit[data-unit-id]');
  await expect(units.first()).toBeVisible();
  const seeded = await units.count();
  expect(seeded).toBeGreaterThanOrEqual(15);
  await expect(page.getByTestId('dtg')).toHaveText(/^\d{6}J[A-Z]{3}\d{2}$/);
  await closeSitrep(page);

  await openLog(page);

  // Capture a hostile through the command bar.
  await command(page, '/new hostile coy fin "Tax notice" in Household near as TAX');
  const tax = page.locator('g.unit[aria-label^="TAX:"]');
  await expect(tax).toHaveCount(1);
  await expect(units).toHaveCount(seeded + 1);
  const taxId = await tax.getAttribute('data-unit-id');
  expect(taxId).toBeTruthy();

  // Attack it: a new main-effort arrow appears.
  const before = new Set(await page.locator('g.order[data-order-id]').evaluateAll(els => els.map(e => e.getAttribute('data-order-id'))));
  await command(page, '/attack IRSRSP TAX main');
  const arrows = page.locator('g.order.main[data-order-id]');
  const newIds = (await arrows.evaluateAll(els => els.map(e => e.getAttribute('data-order-id')))).filter(id => !before.has(id));
  expect(newIds).toHaveLength(1);
  const orderId = newIds[0]!;
  await expect(page.locator(`g.order.main[data-order-id="${orderId}"] .shaft`)).toBeVisible();
  await expect(page.getByTestId('order-log')).toContainText('ATTACKS TAX');

  // Drag a unit to new ground: one move transaction.
  const passport = page.locator('g.unit[data-unit-id="passport"]');
  const start = await transformOf(page, 'g.unit[data-unit-id="passport"]');
  const box = (await passport.locator('image').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx - 5 * i, cy - 6 * i);
  await page.mouse.up();
  await expect.poll(() => transformOf(page, 'g.unit[data-unit-id="passport"]')).not.toBe(start);
  const moved = await transformOf(page, 'g.unit[data-unit-id="passport"]');
  await expect(page.getByTestId('order-log')).toContainText('MOVE PASSPORT');

  // Reload: the server holds the document; wait until nothing is pending.
  await expect(page.getByTestId('pending-count')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(units.first()).toBeVisible();
  await closeSitrep(page);
  await expect(page.locator(`g.unit[data-unit-id="${taxId}"]`)).toHaveCount(1);
  await expect(page.locator(`g.order.main[data-order-id="${orderId}"]`)).toHaveCount(1);
  expect(await transformOf(page, 'g.unit[data-unit-id="passport"]')).toBe(moved);
  await expect(units).toHaveCount(seeded + 1);

  expect(errors(page)).toEqual([]);
});

test('command bar: autocomplete, error underline, history and undo', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  await closeSitrep(page);
  await openLog(page);

  // "/" focuses the bar from anywhere; Tab accepts a suggestion.
  await page.locator('body').press('/');
  const input = page.getByTestId('command-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('blo');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('/block');
  await input.press('Tab');
  await expect(input).toHaveValue('/block ');

  // A bad token is refused with an underline and runs nothing.
  await input.fill('/note NOSUCHUNIT "x"');
  await expect(page.getByTestId('command-preview')).toContainText('No match');
  await expect(page.locator('.mirror .bad')).toHaveText('NOSUCHUNIT');
  await input.press('Enter');
  await expect(input).toHaveValue('/note NOSUCHUNIT "x"');

  // A good order runs; ↑ in an empty bar recalls it; /undo reverts it.
  await input.fill('/note KNEE "ice after runs"');
  await input.press('Enter');
  await expect(page.getByTestId('order-log')).toContainText('KNEE NOTE ice after runs');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('/note KNEE "ice after runs"');
  await input.fill('/undo');
  await input.press('Enter');
  // Undo goes through the server: the original line is struck through and a revert line follows.
  await expect(page.getByTestId('order-log').locator('.undone')).toContainText('KNEE NOTE ice after runs');
  await expect(page.getByTestId('order-log')).toContainText('UNDONE: KNEE NOTE ice after runs');
  await expect(page.getByTestId('command-preview')).toContainText('UNDONE: KNEE NOTE ice after runs');

  // Selecting a unit opens the inspector with plain words and field letters.
  await page.locator('g.unit[data-unit-id="knee"]').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toContainText('KNEE');
  await expect(inspector).toContainText('Rating (Admiralty)');
  await expect(inspector.getByLabel('Evaluation rating')).toHaveValue('C3');

  expect(errors(page)).toEqual([]);
});

test('autocomplete exposes all commands in a scrolling list and advances /new slots', async ({browser, baseURL})=>{
 const page = await userPage(browser, 'alice', baseURL!, true);
 await openMap(page);await closeSitrep(page);
 const input=page.getByTestId('command-input');await input.fill('/');
 const options=page.getByRole('option');await expect(options).toHaveCount(40);
 for(let i=0;i<12;i++)await input.press('ArrowDown');
 await expect(input).toHaveAttribute('aria-activedescendant','cmd-option-12');
 expect(await page.getByRole('listbox').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 await input.fill('/new hostile ');await expect(options.first()).toContainText('tm');
 await input.fill('/new hostile coy ');await expect(options.first()).toContainText('inf');
 await input.fill('/new hostile coy fin ');await expect(options.first()).toContainText('"title"');
 await input.fill('/new hostile coy fin "Tax" ');await expect(options.first()).toContainText('in');
 await input.fill('/new hostile coy fin "Tax" in ');await expect(options.first()).toContainText('Work');
 await input.fill('/new hostile coy fin "Tax" in Household ');await expect(options.first()).toContainText('hq');
 await input.fill('/new hostile coy fin "Tax" in Household near due ');await expect(options.first()).toContainText('today');
});
