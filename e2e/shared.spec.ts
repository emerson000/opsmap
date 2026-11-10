import { test, expect } from '@playwright/test';
import { command, errors, openLog, openMap, userPage } from './helpers';

// Two browser contexts (Alice and Bob) on one shared map, against the real dev server.
test('two users: real-time ops, presence, attribution and undo conflict', async ({ browser, baseURL }) => {
  const al = await userPage(browser, 'alice', baseURL!, true);
  const bo = await userPage(browser, 'bob', baseURL!);
  await openMap(al);
  await openMap(bo);

  // Presence: both see two online chips.
  await expect(al.getByTestId('online-users').locator('.chip')).toHaveCount(2);
  await expect(bo.getByTestId('online-users').locator('.chip')).toHaveCount(2);
  await expect(bo.getByTestId('online-users')).toContainText('AL');

  // An op made by Alice appears for Bob in under one second.
  await openLog(bo);
  await openLog(al);
  const input = al.getByTestId('command-input');
  await input.fill('/new hostile coy fin "Tax notice" in Household near as TAX');
  await expect(al.getByTestId('command-preview')).toContainText('▸');
  const started = Date.now();
  await input.press('Enter');
  await expect(bo.locator('g.unit[aria-label^="TAX:"]')).toHaveCount(1, { timeout: 1000 });
  expect(Date.now() - started).toBeLessThan(1000);

  // Attribution: Bob's order log shows Alice's initials on the line.
  const line = bo.getByTestId('order-log').locator('li', { hasText: 'CAPTURE TAX' });
  await expect(line.locator('.by')).toHaveText('AL');

  // Presence: Alice selects TAX, Bob sees it outlined in Alice's color.
  await al.locator('g.unit[aria-label^="TAX:"]').click();
  await expect(bo.locator('g.unit[aria-label^="TAX:"] [data-testid="remote-selection"]')).toHaveAttribute('data-user-id', 'dev:alice');

  // Undo conflict: Alice notes TAX, Bob notes it after, Alice's undo is refused.
  await command(al, '/note TAX "first"');
  await expect(bo.getByTestId('order-log')).toContainText('TAX NOTE first');
  await command(bo, '/note TAX "bob was here"');
  await expect(al.getByTestId('order-log')).toContainText('TAX NOTE bob was here');
  await al.getByTestId('command-input').fill('/undo');
  await al.getByTestId('command-input').press('Enter');
  await expect(al.getByTestId('toasts')).toContainText('Changed since by Bob');
  await expect(al.getByTestId('command-preview')).toContainText('Changed since by Bob');

  // Bob's own undo works and reaches Alice.
  await command(bo, '/undo');
  await expect(al.getByTestId('order-log')).toContainText('UNDONE: TAX NOTE bob was here');
  await expect(al.getByTestId('order-log').locator('li.undone')).toContainText('TAX NOTE bob was here');

  // A reload gets a full document without the historical op metadata.
  await openMap(bo);
  await expect(bo.getByTestId('order-log').locator('li', { hasText: 'CAPTURE TAX' }).locator('.by')).toHaveText('AL');

  // Bob leaves: Alice's presence drops to one chip.
  await bo.context().close();
  await expect(al.getByTestId('online-users').locator('.chip')).toHaveCount(1);

  expect(errors(al)).toEqual([]);
});

test('signed out: the login screen lists dev users', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(page.getByTestId('dev-login-bob')).toBeVisible();
  await page.getByTestId('dev-login-bob').click();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.getByTestId('user-menu')).toContainText('Bob');
  // Bob is not an admin: no import.
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
});
