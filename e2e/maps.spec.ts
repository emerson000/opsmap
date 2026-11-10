import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// Multiple maps: create, switch, rename, duplicate and delete, with a second user following along live.
test('multiple maps: create, switch, rename, duplicate, delete', async ({ browser, baseURL }) => {
  const al = await userPage(browser, 'alice', baseURL!, true);
  const bo = await userPage(browser, 'bob', baseURL!);
  await openMap(al);
  await openMap(bo);
  const units = (page: typeof al) => page.locator('g.unit[data-unit-id]');
  const seeded = await units(al).count();
  expect(seeded).toBeGreaterThan(0);
  await expect(al.getByTestId('map-name')).toHaveText('Main');

  // Alice creates a map: it opens empty and its id goes into the address bar.
  await al.getByTestId('map-switcher').click();
  await al.getByTestId('map-new').click();
  await al.getByTestId('map-name-input').fill('Garden');
  await al.getByTestId('map-save').click();
  await expect(al.getByTestId('map-name')).toHaveText('Garden');
  await expect(al.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(units(al)).toHaveCount(0);
  await expect(al).toHaveURL(/\?map=/);
  const gardenUrl = al.url();

  // Bob, still on Main, sees the new map in their list and their map is untouched.
  await bo.getByTestId('map-switcher').click();
  await expect(bo.getByTestId('map-option').locator('.label')).toHaveText(['Main', 'Garden']);
  await bo.keyboard.press('Escape');
  await expect(units(bo)).toHaveCount(seeded);
  // Presence is per map: Alice is no longer counted on Main.
  await expect(bo.getByTestId('online-users').locator('.chip')).toHaveCount(1);

  // Work on Garden stays on Garden.
  await command(al, '/new hostile "Weeds in the beds" in Household near as WEEDS');
  await expect(units(al)).toHaveCount(1);
  await expect(units(bo)).toHaveCount(seeded);

  // Bob follows to Garden and sees the unit, and Alice's chip.
  await bo.getByTestId('map-switcher').click();
  await bo.getByTestId('map-option').filter({ hasText: 'Garden' }).click();
  await expect(bo.locator('g.unit[aria-label^="WEEDS:"]')).toHaveCount(1);
  await expect(bo.getByTestId('online-users').locator('.chip')).toHaveCount(2);

  // Rename reaches the other user live.
  await al.getByTestId('map-switcher').click();
  await al.getByTestId('map-rename').click();
  await al.getByTestId('map-name-input').fill('Garden 2027');
  await al.getByTestId('map-name-input').press('Enter');
  await expect(al.getByTestId('map-name')).toHaveText('Garden 2027');
  await expect(bo.getByTestId('map-name')).toHaveText('Garden 2027');

  // Duplicate opens a copy with the same units.
  await al.getByTestId('map-switcher').click();
  await al.getByTestId('map-duplicate').click();
  await expect(al.getByTestId('map-name')).toHaveText('Garden 2027 copy');
  await expect(al.locator('g.unit[aria-label^="WEEDS:"]')).toHaveCount(1);

  // A reload of a map link opens that map.
  await al.goto(gardenUrl);
  await expect(al.getByTestId('map-name')).toHaveText('Garden 2027');
  await expect(al.getByTestId('connection')).toHaveAttribute('data-status', 'live');

  // Bob is not an admin: no delete. Alice deletes Garden while Bob is on it; Bob lands on Main.
  await bo.getByTestId('map-switcher').click();
  await expect(bo.getByTestId('map-delete')).toHaveCount(0);
  await bo.keyboard.press('Escape');
  await al.getByTestId('map-switcher').click();
  await al.getByTestId('map-delete').click();
  await al.getByTestId('toasts').getByRole('button', { name: 'Delete map' }).click();
  await expect(al.getByTestId('map-name')).not.toHaveText('Garden 2027');
  await expect(bo.getByTestId('map-name')).toHaveText('Main');
  await expect(units(bo)).toHaveCount(seeded);
  await expect(bo.getByTestId('toasts')).toContainText('That map was deleted');
  await bo.getByTestId('map-switcher').click();
  await expect(bo.getByTestId('map-option').locator('.label')).toHaveText(['Main', 'Garden 2027 copy']);

  expect(errors(al)).toEqual([]);
  expect(errors(bo)).toEqual([]);
  // Leave nobody online for the specs that count presence chips.
  await al.context().close();
  await bo.context().close();
});
