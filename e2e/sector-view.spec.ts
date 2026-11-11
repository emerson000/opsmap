import { test, expect, type Page } from '@playwright/test';
import { command, errors, openMap, rimPoint, userPage } from './helpers';

// The sector view and the Situation view's create forms: every control runs the command text the bar would,
// with the same log line.

const result = (page: Page) => page.getByTestId('command-preview');
async function sameAsBar(page: Page, text: string) {
  const fromControl = (await result(page).innerText()).trim();
  await command(page, '/undo');
  await command(page, text);
  await expect(result(page)).toHaveText(fromControl);
}

test('a sector name opens its view: new unit and area forms, width, sector HQ, reassign and remove', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const echo = page.getByTestId('echo-line');

  const rim = await rimPoint(page, 'household');
  await page.mouse.click(rim.x, rim.y);
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  await expect(inspector.getByTestId('view-name')).toHaveText('Household');
  await expect(page.locator('path.band.selected')).toHaveCount(1);
  // No Vikunja on this server: no Vikunja section.
  await expect(inspector.getByTestId('section-vikunja')).toHaveCount(0);

  // + Unit…: the form previews /new with the sector fixed and checks it with the parser.
  await inspector.getByTestId('new-unit-open').click();
  const unitForm = inspector.getByTestId('new-unit');
  await unitForm.getByLabel('Title').fill('Fix gutter');
  await unitForm.getByLabel('Identity').selectOption('hostile');
  await unitForm.getByLabel('Ring').selectOption('near');
  await expect(unitForm).toContainText('/new hostile "Fix gutter" in Household near');
  await expect(unitForm).toContainText('✓');
  await unitForm.getByRole('button', { name: 'Create' }).click();
  await expect(unitForm).toHaveCount(0);
  await expect(echo).toContainText('/new hostile "Fix gutter" in Household near');
  await sameAsBar(page, '/new hostile "Fix gutter" in Household near');

  // + Area…: type, name and ring.
  await inspector.getByTestId('new-area-open').click();
  const areaForm = inspector.getByTestId('new-area');
  await areaForm.getByRole('radio', { name: 'EA' }).click();
  await areaForm.getByLabel('Name').fill('Garage');
  await areaForm.getByLabel('Ring').selectOption('mid');
  await expect(areaForm).toContainText('/ea add Garage in Household mid');
  await areaForm.getByRole('button', { name: 'Create' }).click();
  await expect(result(page)).toContainText('GARAGE');
  await expect(inspector.getByTestId('section-areas')).toContainText('GARAGE');
  await sameAsBar(page, '/ea add Garage in Household mid');

  // Width: 1–359, with how the others scale; a bad width shows the parser's error and Set stays off.
  const width = inspector.getByTestId('sector-width');
  await width.fill('400');
  await expect(inspector.getByTestId('sector-width-note')).toContainText('Sector width');
  await expect(inspector.getByTestId('sector-width-set')).toBeDisabled();
  await width.fill('90');
  await expect(inspector.getByTestId('sector-width-note')).toContainText('Others scale to share 270°: Work 72° → 67.5°');
  await inspector.getByTestId('sector-width-set').click();
  await expect(result(page)).toContainText('SECTOR WIDTH');
  await expect(echo).toContainText('/sector width Household 90');
  await sameAsBar(page, '/sector width Household 90');

  // Sector HQ: an order on it shows here; ✕ halts it.
  await command(page, '/advancing LEAK on Household hq');
  const hq = inspector.getByTestId('sector-hq');
  await expect(hq).toContainText('LEAK');
  await hq.getByTestId('cancel-order').click();
  await expect(echo).toContainText('/halt LEAK advance');
  await expect(hq).toContainText('No order targets Household HQ');
  await sameAsBar(page, '/halt LEAK advance');

  // Remove needs Reassign to while it holds units; the confirm says where they go.
  await expect(inspector.getByTestId('manage-remove')).toBeDisabled();
  await inspector.getByTestId('sector-reassign').selectOption('family');
  await inspector.getByTestId('manage-remove').click();
  const confirm = inspector.getByRole('alertdialog');
  await expect(confirm).toContainText('Its units and areas move to Family');
  await expect(confirm.getByRole('button', { name: 'Keep' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(result(page)).toContainText('SECTOR REMOVE');
  await expect(echo).toContainText('/sector remove Household reassign Family');
  await sameAsBar(page, '/sector remove Household reassign Family');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('Situation: + Sector… and + Area… forms, the sectors table and the control measures list', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toHaveAttribute('data-kind', 'map');
  await expect(inspector.getByTestId('new-unit-open')).toHaveClass(/primary/);

  await inspector.getByTestId('new-sector-open').click();
  const form = inspector.getByTestId('new-sector');
  await form.getByLabel('Name').fill('Garden');
  await expect(form).toContainText('/sector add Garden');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(result(page)).toContainText('SECTOR ADD Garden');
  await sameAsBar(page, '/sector add Garden');
  await expect(inspector.getByTestId('situation-sectors')).toContainText('Garden');

  await inspector.getByTestId('new-area-open').click();
  const area = inspector.getByTestId('new-area');
  await area.getByRole('radio', { name: 'NAI' }).click();
  await area.getByLabel('Name').fill('Seeds');
  await area.getByLabel('Sector').selectOption({ label: 'Garden' });
  await expect(area).toContainText('/nai add Seeds in Garden');
  await area.getByRole('button', { name: 'Create' }).click();
  await expect(result(page)).toContainText('NAI SEEDS');
  await sameAsBar(page, '/nai add Seeds in Garden');

  // The lists open their views.
  await inspector.getByTestId('situation-measures').getByRole('button', { name: /SEEDS/ }).click();
  await expect(inspector).toHaveAttribute('data-kind', 'area');
  await inspector.getByRole('button', { name: 'Close inspector' }).click();
  await inspector.getByTestId('situation-sectors').getByRole('button', { name: 'Garden' }).click();
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  await expect(inspector.getByTestId('section-areas')).toContainText('SEEDS');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
