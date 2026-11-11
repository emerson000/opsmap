import { test, expect, type Page } from '@playwright/test';
import { command, errors, openMap, sameAsBar, userPage } from './helpers';

// The order composer in a unit's Orders section: a verb, a target from the ranked list or the map, the verb's
// options, and the command it builds slot by slot. Run gives the same log line as the same text in the bar.

async function openComposer(page: Page, designation: string) {
  await command(page, `/find ${designation}`);
  await page.getByTestId('inspector').getByTestId('unit-order').click();
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  return composer;
}

test('attack: target from the list, role and planned, slot by slot, then Run', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const composer = await openComposer(page, 'RECORDS');
  const preview = composer.getByTestId('composer-preview');

  // A friendly starts on Attack; Advancing does not apply, stays focusable, and says why.
  await expect(composer.locator('[data-verb="attack"]')).toHaveAttribute('aria-checked', 'true');
  const advancing = composer.locator('[data-verb="advancing"]');
  await expect(advancing).toHaveAttribute('aria-disabled', 'true');
  await advancing.click({ force: true });   // aria-disabled: Playwright treats it as disabled, a user can still press it
  await expect(composer).toContainText('Only a hostile or suspect advances');
  await expect(advancing).toHaveAttribute('aria-checked', 'false');

  // Unfilled slots show the syntax; the target slot is underlined while it is empty.
  await expect(preview).toContainText('/attack RECORDS ‹target› [main|support] [planned]');
  await expect(preview.locator('.slot.active')).toHaveText('‹target›');

  // The list is ranked like the bar: threats first. Type to filter, Enter chooses.
  const target = composer.getByTestId('composer-target');
  await target.click();
  await expect(composer.getByRole('listbox', { name: 'Target' }).getByRole('option').first()).toContainText('IRS');
  await target.fill('LEA');
  await expect(target).toHaveAttribute('aria-activedescendant', /-0$/);
  await target.press('Enter');
  await expect(target).toHaveValue('LEAK');
  await composer.getByTestId('composer-role').getByRole('radio', { name: 'Support' }).click();
  await composer.getByTestId('composer-planned').check();
  await expect(preview).toContainText('/attack RECORDS LEAK support planned');
  await expect(preview).toContainText(/✓ RECORDS .*ATTACKS LEAK/);

  const line = await sameAsBar(page, () => composer.getByTestId('composer-run').click(), '/attack RECORDS LEAK support planned');
  expect(line).toMatch(/RECORDS .*ATTACKS LEAK .*SUPPORT/);
  await expect(composer).toHaveCount(0);

  // Esc closes the open target list, then the composer; N (single-letter key, focus in the sidebar) opens it again.
  await page.getByTestId('inspector').getByTestId('unit-order').click();
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.getByTestId('composer').getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer').getByRole('listbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await page.getByTestId('inspector').getByTestId('cmd-toggle').focus();
  await page.keyboard.press('n');
  await expect(page.getByTestId('composer')).toBeVisible();
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('moving: pick the target on the map; Tab and Enter pick too; Esc cancels', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const composer = await openComposer(page, 'IRSRSP');
  await composer.locator('[data-verb="moving"]').click();
  await expect(composer.locator('[data-verb="moving"]')).toHaveAttribute('aria-checked', 'true');

  // Map: the banner shows the command so far; what the verb accepts is ringed, the rest dims.
  await composer.getByTestId('composer-pick-map').click();
  const banner = page.getByTestId('pick-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Pick target');
  await expect(banner).toContainText('/moving IRSRSP');
  await expect(page.locator('g.unit[data-unit-id="records"]')).toHaveClass(/pick-ok/);
  await expect(page.locator('g.unit[data-unit-id="irsrsp"]')).toHaveClass(/pick-dim/);
  await page.keyboard.press('Escape');
  await expect(banner).toHaveCount(0);
  await expect(composer).toBeVisible();

  // Click an area on the map: the objective fills the target slot.
  await composer.getByTestId('composer-pick-map').click();
  await expect(banner).toBeVisible();
  await page.locator('text.m-type[data-measure-id="obj-settled"]').click();
  await expect(banner).toHaveCount(0);
  await expect(composer.getByTestId('composer-target')).toHaveValue('OBJ SETTLED IN');
  await expect(composer.getByTestId('composer-preview')).toContainText('/moving IRSRSP to OBJ "SETTLED IN"');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-kind', 'unit');   // picking does not change the selection
  await sameAsBar(page, () => composer.getByTestId('composer-run').click(), '/moving IRSRSP to OBJ "SETTLED IN"');

  // Keyboard: Tab cycles the ringed targets, Enter picks the one reached.
  const again = await openComposer(page, 'IRSRSP');
  await again.locator('[data-verb="moving"]').click();
  await again.getByTestId('composer-pick-map').click();
  await page.keyboard.press('Tab');
  await expect(banner).toContainText('Enter picks');
  const name = (await banner.locator('b').innerText()).trim();
  await page.keyboard.press('Enter');
  await expect(banner).toHaveCount(0);
  await expect(again.getByTestId('composer-target')).toHaveValue(name);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('axis via phase lines, link as handoff, and To bar', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const composer = await openComposer(page, 'RECORDS');
  const preview = composer.getByTestId('composer-preview');
  await composer.locator('[data-verb="axis"]').click();
  const target = composer.getByTestId('composer-target');
  await target.click();
  await composer.getByRole('option', { name: /SETTLED IN/ }).click();
  await composer.getByTestId('composer-via-add').selectOption('pl-launch');
  await expect(composer.getByTestId('composer-via')).toContainText('PL LAUNCH');
  await expect(preview).toContainText('/axis RECORDS to OBJ "SETTLED IN" via PL LAUNCH');
  await sameAsBar(page, () => composer.getByTestId('composer-run').click(), '/axis RECORDS to OBJ "SETTLED IN" via PL LAUNCH');

  // Link, as handoff: To bar puts the text in the command bar instead of running it.
  const link = await openComposer(page, 'RECORDS');
  await link.locator('[data-verb="link"]').click();
  await link.getByTestId('composer-target').fill('IRSRSP');
  await link.getByTestId('composer-target').press('Enter');
  await link.getByRole('radio', { name: 'Handoff' }).click();
  await expect(link.getByTestId('composer-preview')).toContainText('/link RECORDS IRSRSP as handoff');
  await link.getByTestId('composer-to-bar').click();
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await expect(page.getByTestId('command-input')).toHaveValue('/link RECORDS IRSRSP as handoff');
  await page.getByTestId('command-input').press('Enter');
  await expect(page.getByTestId('command-preview')).toContainText('✓');

  // A threat's composer starts on Advancing, and HQ is the first target it offers.
  const adv = await openComposer(page, 'LEAK');
  await expect(adv.locator('[data-verb="advancing"]')).toHaveAttribute('aria-checked', 'true');
  await expect(adv.locator('[data-verb="attack"]')).toHaveAttribute('aria-disabled', 'true');
  await adv.getByTestId('composer-target').click();
  await expect(adv.getByRole('option').first()).toContainText('HQ');
  await adv.getByRole('option', { name: 'HQ Household HQ Sector HQ', exact: true }).click();
  await sameAsBar(page, () => adv.getByTestId('composer-target').press('Enter'), '/advancing LEAK on Household hq');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
