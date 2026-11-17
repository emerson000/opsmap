import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// A blocked unit reads as blocked on the map: the no-entry mark and a BLOCKED label line; unblock clears both.
test('blocked units carry a no-entry mark and a BLOCKED label', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const unit = (id: string) => page.locator(`g.unit[data-unit-id="${id}"]`);
  const records = await page.locator('g.unit[aria-label^="RECORDS:"]').getAttribute('data-unit-id');
  expect(records).toBeTruthy();
  await expect(unit(records!).getByTestId('blocked-mark')).toHaveCount(0);

  // An assessed (fully capable) friendly still shows it.
  await command(page, '/bda RECORDS fc');
  await command(page, '/block RECORDS by "Waiting on the bank"');
  await expect(unit(records!)).toHaveClass(/blocked/);
  await expect(unit(records!).getByTestId('blocked-mark')).toBeVisible();
  await expect(unit(records!).getByTestId('blocked-mark').locator('title')).toHaveText('Blocked: Waiting on the bank (/unblock RECORDS)');
  await expect(page.locator('g.unit-labels')).toContainText('BLOCKED');

  await command(page, '/unblock RECORDS');
  await expect(unit(records!).getByTestId('blocked-mark')).toHaveCount(0);
  await expect(unit(records!)).not.toHaveClass(/blocked/);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
