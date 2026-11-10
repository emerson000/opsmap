import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// /ao size: the Situation panel control and the command both change the shared map; symbols shrink against the rings.
const SHOTS = process.env.OPSMAP_SHOTS;

test('AO size from the Situation panel and the command bar', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  for (let i = 0; i < 7; i++) await command(page, `/new hostile "Item ${i}" in Work near as CR${i}`);
  const symbolWidth = async () => (await page.locator('g.unit[data-unit-id] image, g.unit[data-unit-id] svg').first().boundingBox())?.width ?? 0;
  const medium = await symbolWidth();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/medium.png` });

  const ao = page.getByTestId('ao-size');
  await expect(ao.locator('[data-size="medium"]')).toHaveAttribute('aria-checked', 'true');
  await ao.locator('[data-size="xl"]').click();
  await expect(ao.locator('[data-size="xl"]')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(symbolWidth).toBeLessThan(medium * 0.75);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/xl.png` });

  await command(page, '/ao size small');
  await expect(ao.locator('[data-size="small"]')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(symbolWidth).toBeGreaterThan(medium);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/small.png` });

  // Survives a reload: it is shared map state, not a browser preference.
  await page.reload();
  await openMap(page);
  await expect(page.getByTestId('ao-size').locator('[data-size="small"]')).toHaveAttribute('aria-checked', 'true');
  expect(errors(page)).toEqual([]);
  // Leave no one online for the specs that count presence.
  await page.context().close();
});
