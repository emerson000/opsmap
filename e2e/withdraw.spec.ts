import { test, expect } from '@playwright/test';
import { command, errors, openMap, sameAsBar, userPage } from './helpers';

// Withdrawal: a threat being mitigated moves away from HQ. The composer, the unit menu and the order's ✕
// run the same commands as the bar, and the map draws a W arrow outward.

test('withdraw from the composer, the unit menu and the bar; halt it from the order list', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');

  // Composer: Withdraw, an outer ring from the list, Run.
  await command(page, '/find LEAK');
  await inspector.getByTestId('unit-order').click();
  const composer = page.getByTestId('composer');
  await composer.locator('[data-verb="withdraw"]').click();
  await expect(composer.locator('[data-verb="withdraw"]')).toHaveAttribute('aria-checked', 'true');
  // The target is optional: with none, the next ring out.
  await expect(composer.getByTestId('composer-preview')).toContainText('LEAK (ENG PLT) WITHDRAWS TO MID RING');
  const target = composer.getByTestId('composer-target');
  await target.click();
  const list = composer.getByRole('listbox', { name: 'Target' });
  await expect(list.getByRole('option')).toHaveText([/MID RING/, /FAR RING/, /MAP EDGE/]);
  await list.getByRole('option', { name: /FAR RING/ }).click();
  await sameAsBar(page, () => composer.getByTestId('composer-run').click(), '/withdraw LEAK to far');

  // The map draws one withdrawal arrow, with its W, in the hostile color.
  const arrow = page.locator('g.order.withdraw.threat');
  await expect(arrow).toHaveCount(1);
  await expect(arrow.locator('text.tag')).toHaveText('W');

  // The order list shows it, and its ✕ halts it.
  await command(page, '/find LEAK');
  await expect(inspector).toContainText('Withdrawing');
  await expect(inspector).toContainText('FAR RING');
  await sameAsBar(page, () => inspector.getByTestId('cancel-order').first().click(), '/halt LEAK withdraw');
  await expect(arrow).toHaveCount(0);

  // The unit menu: Withdraw runs at once (next ring out), with Undo.
  const menu = page.getByTestId('unit-menu');
  await page.locator('g.unit[data-unit-id="irs"] image').first().click({ button: 'right' });
  await expect(menu.locator('[data-action="withdraw"]')).toContainText('/withdraw');
  await menu.locator('[data-action="withdraw"]').click();
  await expect(page.getByTestId('toasts')).toContainText('IRS');
  await expect(page.locator('g.order.withdraw')).toHaveCount(1);
  await page.getByTestId('toasts').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('g.order.withdraw')).toHaveCount(0);

  // The command bar offers /retreat while you type it; Tab completes it, and it runs as /withdraw.
  const input = page.getByTestId('command-input');
  await input.click();
  await input.fill('/ret');
  const suggestions = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(suggestions.getByRole('option').first()).toContainText('/retreat');
  await expect(suggestions.getByRole('option').first()).toContainText('/withdraw');
  await input.press('Tab');
  await expect(input).toHaveValue('/retreat ');
  await input.pressSequentially('LEAK');
  await input.press('Enter');
  await expect(page.getByTestId('command-preview')).toContainText('LEAK (ENG PLT) WITHDRAWS TO MID RING');

  expect(errors(page)).toEqual([]);
});
