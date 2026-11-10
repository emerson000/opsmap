import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// A dated unit moved by hand is pinned; the inspector's Unpin returns it to its date's ring.
test('unpin from the inspector', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const due = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  await command(page, `/new hostile "Renewal" in Work due ${due} as RENEW`);
  await command(page, '/move RENEW to Work near');
  await command(page, '/find RENEW');
  const unpin = page.getByTestId('unpin');
  await expect(unpin).toBeVisible();
  await unpin.click();
  await expect(unpin).toHaveCount(0);
  await expect(page.getByText(/RENEW UNPINNED → MID/).first()).toBeVisible();
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
