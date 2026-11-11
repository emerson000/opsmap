import { test, expect, type Page } from '@playwright/test';
import { command, errors, openMap, sameAsBar as runsAsBar, userPage } from './helpers';

// The area view (OBJ, EA, NAI) and the area card. Each control runs fully named command text: the echo line shows
// it, and the same text typed in the command bar gives the same log line.

/** The last result line under the command bar. */
const result = (page: Page) => page.getByTestId('command-preview');
/** Undo what the control did, run `text` in the bar, and check the bar gives the control's log line. */
async function sameAsBar(page: Page, text: string) {
  const fromControl = (await result(page).innerText()).trim();
  await command(page, '/undo');
  await command(page, text);
  await expect(result(page)).toHaveText(fromControl);
}

test('click an area to open its view; join and leave several units at once; place and size it', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const echo = page.getByTestId('echo-line');

  // Commander hides the axis onto the OBJ until the OBJ is open in the sidebar.
  await expect(page.locator('g.order[data-order-id="o-move-axis"]')).toHaveCount(0);
  await page.locator('g.measure[data-measure="obj-settled"] text.m-type').click();
  await expect(inspector).toHaveAttribute('data-kind', 'area');
  await expect(inspector.getByTestId('view-name')).toHaveText('SETTLED IN');
  await expect(page.locator('g.measure.selected[data-measure="obj-settled"]')).toHaveCount(1);
  await expect(page.locator('g.order[data-order-id="o-move-axis"]')).toHaveCount(1);
  await expect(page.getByTestId('measure-card')).toHaveCount(0);
  await expect(inspector.getByTestId('view-status')).toContainText('AXIS ← MOVE');

  // + Add units…: a list of units; pick two and Join runs one command for both.
  await inspector.getByTestId('measure-add-members').click();
  const list = inspector.getByTestId('measure-join-list');
  await expect(list).toBeVisible();
  await list.getByRole('checkbox', { name: /RECORDS/ }).check();
  // ⌖ Map adds one unit per pick to the same selection.
  await list.getByTestId('measure-join-map').click();
  await expect(page.getByTestId('pick-banner')).toContainText('/obj join "SETTLED IN" RECORDS ‹unit›…');
  await expect(page.locator('g.unit[data-unit-id="records"]')).toHaveClass(/pick-dim/);
  await page.locator('g.unit[data-unit-id="irsrsp"]').click();
  await expect(page.getByTestId('pick-banner')).toHaveCount(0);
  await expect(list.getByRole('checkbox', { name: /IRSRSP/ })).toBeChecked();
  await expect(list).toContainText('/obj join "SETTLED IN" RECORDS IRSRSP');
  await inspector.getByTestId('measure-join').click();
  await expect(result(page)).toContainText('RECORDS, IRSRSP JOINED OBJ SETTLED IN');
  await expect(echo).toContainText('/obj join "SETTLED IN" RECORDS IRSRSP');
  const members = inspector.getByTestId('area-members');
  await expect(members).toContainText('RECORDS');
  await expect(members).toContainText('IRSRSP');
  await sameAsBar(page, '/obj join "SETTLED IN" RECORDS IRSRSP');

  // Leave selected: both at once.
  await members.getByRole('checkbox', { name: 'Select RECORDS' }).check();
  await members.getByRole('checkbox', { name: 'Select IRSRSP' }).check();
  await inspector.getByTestId('measure-leave').click();
  await expect(result(page)).toContainText('LEFT OBJ SETTLED IN');
  await expect(echo).toContainText('/obj leave "SETTLED IN" RECORDS IRSRSP');
  await expect(members).toContainText('Empty');
  await sameAsBar(page, '/obj leave "SETTLED IN" RECORDS IRSRSP');

  // Size, ring and near: each runs its command.
  await inspector.getByTestId('measure-size').getByRole('radio', { name: 'Large' }).click();
  await expect(result(page)).toContainText('OBJ SETTLED IN SIZE LARGE');
  await sameAsBar(page, '/obj size "SETTLED IN" large');
  await inspector.getByTestId('measure-place').selectOption('far');
  await expect(result(page)).toContainText('OBJ SETTLED IN MOVED');
  await expect(echo).toContainText('/obj move "SETTLED IN" far');
  await sameAsBar(page, '/obj move "SETTLED IN" far');
  // Near: ⌖ Map picks the unit (the select shows it), then Move runs it.
  await inspector.getByTestId('measure-near-map').click();
  await expect(page.getByTestId('pick-banner')).toContainText('/obj move "SETTLED IN" near ‹unit›');
  await page.locator('g.unit[data-unit-id="packing"]').click();
  await expect(page.getByTestId('pick-banner')).toHaveCount(0);
  await expect(inspector.getByTestId('measure-near')).toHaveValue('packing');
  await inspector.locator('[data-control="measure-near"]').getByRole('button', { name: 'Move' }).click();
  await expect(echo).toContainText('/obj move "SETTLED IN" near PACKING');
  await sameAsBar(page, '/obj move "SETTLED IN" near PACKING');

  // Targeted by: ✕ halts the axis, as /halt MOVE axis does.
  await inspector.getByTestId('section-targeted').getByTestId('cancel-order').click();
  await expect(echo).toContainText('/halt MOVE axis');
  await expect(inspector.getByTestId('section-targeted')).toContainText('No order aims at OBJ SETTLED IN');
  await sameAsBar(page, '/halt MOVE axis');

  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('+ Order onto…: pick the unit from the list or the map, then its composer runs what the bar runs', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await command(page, '/find obj "SETTLED IN"');
  await inspector.getByTestId('measure-order').click();
  const from = inspector.getByTestId('order-from');
  await expect(from).toContainText('/attack ‹unit› OBJ "SETTLED IN"');
  // The friendlies, ranked like the bar; one in another sector is dimmed with the reason, last.
  const list = from.getByRole('listbox');
  await expect(list.getByRole('option').first()).toContainText('IRSRSP');
  await expect(list.getByRole('option', { name: /PASSPORT/ })).toContainText('Cross-sector orders require a task force');
  await expect(list.getByRole('option', { name: /LEAK/ })).toHaveCount(0);

  // ⌖ Map rings the friendlies that may attack it; Esc cancels, the list stays.
  await from.getByTestId('order-from-map').click();
  await expect(page.getByTestId('pick-banner')).toContainText('/attack ‹unit› OBJ "SETTLED IN"');
  await expect(page.locator('g.unit[data-unit-id="records"]')).toHaveClass(/pick-ok/);
  await expect(page.locator('g.unit[data-unit-id="passport"]')).toHaveClass(/pick-dim/);
  await page.locator('g.unit[data-unit-id="records"]').click();

  // The unit's composer opens on Attack with the objective as the target.
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  await expect(composer.locator('[data-verb="attack"]')).toHaveAttribute('aria-checked', 'true');
  await expect(composer.getByTestId('composer-target')).toHaveValue('OBJ SETTLED IN');
  await expect(composer.getByTestId('composer-preview')).toContainText('/attack RECORDS OBJ "SETTLED IN"');
  await runsAsBar(page, () => composer.getByTestId('composer-run').click(), '/attack RECORDS OBJ "SETTLED IN"');

  // An EA: the list leads to Moving, by keyboard.
  await command(page, '/find ea SATURDAY');
  await inspector.getByTestId('measure-order').click();
  await inspector.getByTestId('order-from-unit').fill('PACK');
  await inspector.getByTestId('order-from-unit').press('Enter');
  await expect(composer.locator('[data-verb="moving"]')).toHaveAttribute('aria-checked', 'true');
  await expect(composer.getByTestId('composer-preview')).toContainText('/moving PACKING to EA SATURDAY');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('double-click and right-click select the area and open its card; card items open its sidebar flows; Remove asks when orders target it', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const label = page.locator('g.measure[data-measure="obj-settled"] text.m-type');

  await label.dispatchEvent('dblclick');
  const card = page.getByTestId('measure-card');
  await expect(card).toContainText('Objective');
  await expect(inspector).toHaveAttribute('data-kind', 'area');
  // Join units… opens Members with the list of units to join.
  await card.locator('[data-action="join"]').click();
  await expect(card).toHaveCount(0);
  await expect(inspector.getByTestId('measure-join-list')).toBeVisible();

  // Near… opens Place at the Near picker.
  await label.click({ button: 'right' });
  await card.locator('[data-action="near"]').click();
  await expect(inspector.getByTestId('measure-near')).toBeFocused();

  // Attack it… starts + Order onto…: pick the unit, then its composer.
  await label.click({ button: 'right' });
  await expect(card).toBeVisible();
  await expect(card.locator('[data-action="attack"]')).toContainText('/attack');
  await card.locator('[data-action="attack"]').click();
  await expect(inspector.getByTestId('order-from')).toBeVisible();
  await expect(inspector.getByTestId('order-from-unit')).toBeFocused();
  await page.keyboard.press('Escape');   // the list
  await page.keyboard.press('Escape');   // the picker
  await expect(inspector.getByTestId('order-from')).toHaveCount(0);

  // An EA cannot be attacked: the item stays, disabled, with the reason.
  await page.locator('g.measure[data-measure="ea-saturday"] text.m-type').dispatchEvent('dblclick');
  await expect(card.locator('[data-action="attack"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(card.locator('[data-action="attack"]')).toHaveAttribute('title', 'Only an objective can be attacked');
  await card.locator('[data-action="inspect"]').click();
  await expect(card).toHaveCount(0);
  await expect(inspector.getByTestId('view-name')).toHaveText('SATURDAY');

  // The OBJ has an axis on it: Remove asks first, Keep keeps it.
  await label.click({ button: 'right' });
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card).toContainText('It drops 1 order on it');
  await card.getByRole('button', { name: 'Keep' }).click();
  await expect(card).toHaveCount(0);
  await expect(label).toHaveCount(1);

  // The sidebar's Manage names the order and runs /obj remove.
  await command(page, '/find obj "SETTLED IN"');
  await inspector.getByTestId('manage-remove').click();
  const confirm = inspector.getByRole('alertdialog');
  await expect(confirm).toContainText('MOVE');
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(result(page)).toContainText('OBJ SETTLED IN REMOVED');
  await expect(label).toHaveCount(0);
  await expect(page.getByTestId('echo-line')).toContainText('/obj remove "SETTLED IN"');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
