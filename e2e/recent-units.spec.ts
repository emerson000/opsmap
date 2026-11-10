import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// Chains of commands: the unit just captured or commanded, or just selected, is the first unit suggestion.
test('autocomplete offers the last-used unit first', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const input = page.getByTestId('command-input');
  const first = page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option').first();

  await command(page, '/new hostile "Late invoice" in Work near as INVOICE');
  await input.click(); await input.fill('/due ');
  await expect(first).toContainText('INVOICE');

  await command(page, '/note TOOLS "Compare two options"');
  await input.click(); await input.fill('/block ');
  await expect(first).toContainText('TOOLS');

  // Selecting a unit on the map counts too.
  await input.fill(''); await input.press('Escape');
  await page.locator('g.unit[data-unit-id="passport"]').click();
  await expect(page.getByTestId('inspector')).toContainText('Renew passport');
  await input.click(); await input.fill('/note ');
  await expect(first).toContainText('PASSPORT');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
