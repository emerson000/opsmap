import { test, expect, type Page } from '@playwright/test';
import { command, errors, openMap, rimPoint, sameAsBar as runsAsBar, userPage } from './helpers';

// The phase line view: a click on the line's label opens it; Re-date says which ring the date lands in;
// each control's command gives the same log line as the same text in the command bar.

const result = (page: Page) => page.getByTestId('command-preview');
async function sameAsBar(page: Page, text: string) {
  const fromControl = (await result(page).innerText()).trim();
  await command(page, '/undo');
  await command(page, text);
  await expect(result(page)).toHaveText(fromControl);
}
const day = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test('click a phase line to open it; re-date with the ring note; rename; halt the orders through it', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const echo = page.getByTestId('echo-line');

  // The stock rings stay open ground; a custom line's label opens its view and draws it selected.
  await expect(page.locator('circle.pl-hit[data-measure-id="pl-launch"]')).toHaveCount(1);
  await page.locator('text.pl-label.custom[data-measure-id="pl-launch"]').first().click({ force: true });
  await expect(inspector).toHaveAttribute('data-kind', 'pl');
  await expect(inspector.getByTestId('view-name')).toHaveText('LAUNCH');
  await expect(page.locator('g.cpl.selected[data-pl="pl-launch"] circle.pl-halo')).toHaveCount(1);
  // The axis that passes it shows in Commander while the line is open.
  await expect(page.locator('g.order.related[data-order-id="o-move-axis"]')).toHaveCount(1);
  await expect(inspector.getByTestId('pl-ring')).toContainText('Area of interest');

  // Re-date focuses the date; the note follows what is typed, before it runs.
  await inspector.getByTestId('pl-redate').click();
  const date = inspector.getByTestId('pl-date');
  await expect(date).toBeFocused();
  await date.fill(day(200));
  await expect(inspector.getByTestId('pl-ring')).toHaveText('Beyond the map edge: not drawn.');
  await date.fill(day(20));
  await expect(inspector.getByTestId('pl-ring')).toHaveText('Lands in the Deep ring.');
  await date.blur();
  await expect(result(page)).toContainText(`PL LAUNCH DATED ${day(20)}`);
  await expect(echo).toContainText(`/pl date LAUNCH ${day(20)}`);
  await sameAsBar(page, `/pl date LAUNCH ${day(20)}`);

  // Rename.
  const name = inspector.getByTestId('measure-name');
  await name.fill('go live');
  await name.press('Enter');
  await name.blur();
  await expect(result(page)).toContainText('PL LAUNCH RENAMED → GO LIVE');
  await expect(echo).toContainText('/pl rename LAUNCH "go live"');
  await sameAsBar(page, '/pl rename LAUNCH "go live"');

  // A unit moving to the line shows under Moving to it; ✕ halts it.
  await command(page, '/moving RECORDS to PL "GO LIVE"');
  const movingTo = inspector.getByTestId('pl-moving');
  await expect(movingTo).toContainText('RECORDS');
  await movingTo.getByTestId('cancel-order').click();
  await expect(echo).toContainText('/halt RECORDS move');
  await expect(movingTo).toContainText('No /moving orders');
  await sameAsBar(page, '/halt RECORDS move');

  // The axis through it: ✕ halts it.
  const axes = inspector.getByTestId('pl-axes');
  await expect(axes).toContainText('MOVE');
  await axes.getByTestId('cancel-order').click();
  await expect(echo).toContainText('/halt MOVE axis');
  await sameAsBar(page, '/halt MOVE axis');

  // Remove: with nothing through it now, it runs at once with an Undo toast.
  await inspector.getByTestId('manage-remove').click();
  await expect(result(page)).toContainText('PL GO LIVE REMOVED');
  await expect(inspector).toHaveAttribute('data-kind', 'map');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('+ Axis via…: pick the friendly, then its composer on Axis with the line in via runs what the bar runs', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await command(page, '/find pl LAUNCH');
  await inspector.getByTestId('pl-axis').click();
  const from = inspector.getByTestId('order-from');
  await expect(from).toContainText('/axis ‹unit› to OBJ ‹name› via PL LAUNCH');
  // Only friendlies get an axis.
  await expect(from.getByRole('listbox').getByRole('option', { name: /LEAK/ })).toHaveCount(0);
  await from.getByTestId('order-from-map').click();
  await expect(page.getByTestId('pick-banner')).toContainText('/axis ‹unit› to OBJ ‹name› via PL LAUNCH');
  await expect(page.locator('g.unit[data-unit-id="leak"]')).toHaveClass(/pick-dim/);
  await page.getByTestId('pick-banner').getByRole('button', { name: 'List' }).click();
  await inspector.getByTestId('order-from-unit').fill('RECORDS');
  await inspector.getByTestId('order-from-unit').press('Enter');

  const composer = page.getByTestId('composer');
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  await expect(composer.locator('[data-verb="axis"]')).toHaveAttribute('aria-checked', 'true');
  await expect(composer.getByTestId('composer-via')).toContainText('PL LAUNCH');
  await composer.getByTestId('composer-target').click();
  await composer.getByRole('option', { name: /SETTLED IN/ }).click();
  await expect(composer.getByTestId('composer-preview')).toContainText('/axis RECORDS to OBJ "SETTLED IN" via PL LAUNCH');
  await runsAsBar(page, () => composer.getByTestId('composer-run').click(), '/axis RECORDS to OBJ "SETTLED IN" via PL LAUNCH');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('right-click on a sector name opens the sector; the capture menu opens the phase line form', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const rim = await rimPoint(page, 'work');
  await page.mouse.click(rim.x, rim.y, { button: 'right' });
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  await expect(inspector.getByTestId('view-name')).toHaveText('Work');
  await expect(page.getByTestId('capture-menu')).toHaveCount(0);
  await expect(page.locator('g.rim[data-sector-id="work"] text.rim-label.selected')).toHaveCount(1);
  await inspector.getByRole('button', { name: 'Close inspector' }).click();
  // Capture on open ground: New phase line… opens the form in the Situation view.
  const svg = (await page.locator('svg.map-svg').boundingBox())!;
  const ground = await page.evaluate(({ x0, y0, w, h }) => {
    for (let y = y0 + h * 0.3; y < y0 + h * 0.9; y += 9) for (let x = x0 + w * 0.3; x < x0 + w * 0.8; x += 9) {
      const el = document.elementFromPoint(x, y);
      if (el?.closest('svg.map-svg') && !el.closest('[data-interactive], [data-unit-id], [data-measure-id], [data-beyond], [data-sector-id]')) return { x, y };
    }
    return null;
  }, { x0: svg.x, y0: svg.y, w: svg.width, h: svg.height });
  expect(ground).not.toBeNull();
  await page.mouse.click(ground!.x, ground!.y, { button: 'right' });
  await page.getByTestId('capture-menu').locator('[data-action="new-pl"]').click();
  const form = inspector.getByTestId('new-pl');
  await expect(form).toBeVisible();
  await form.getByLabel('Name').fill('Handover');
  await form.getByLabel('Phase line date').fill(day(10));
  await expect(form.getByTestId('new-pl-ring')).toHaveText('Lands in the Deep ring.');
  await expect(form).toContainText(`/pl add Handover ${day(10)}`);
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(result(page)).toContainText('PL HANDOVER');
  await expect(form).toHaveCount(0);
  await sameAsBar(page, `/pl add Handover ${day(10)}`);
  await expect(page.locator('circle.pl-hit')).toHaveCount(2);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
