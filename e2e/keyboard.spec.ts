import { test, expect, type Page } from '@playwright/test';
import { errors, openMap, userPage } from './helpers';

// Keyboard map control: arrows and WASD pan, + and - zoom; typing in the command bar is left alone.
const view = async (page: Page) => {
  const t = await page.locator('svg.map-svg > g').first().getAttribute('transform');
  const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(t!)!;
  return { x: +m[1], y: +m[2], k: +m[3] };
};

test('arrows and WASD pan, + and - zoom, and typing is not hijacked', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  await page.locator('body').click({ position: { x: 640, y: 300 } });
  const v0 = await view(page);
  await page.keyboard.press('ArrowRight');
  expect((await view(page)).x).toBeCloseTo(v0.x - 80, 0);
  await page.keyboard.press('KeyS');
  expect((await view(page)).y).toBeCloseTo(v0.y - 80, 0);
  await page.keyboard.press('Shift+KeyA');
  expect((await view(page)).x).toBeCloseTo(v0.x - 80 + 240, 0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('KeyW');
  expect((await view(page)).y).toBeCloseTo(v0.y - 80 + 160, 0);
  const k = (await view(page)).k;
  await page.keyboard.press('+');
  await expect.poll(async () => (await view(page)).k).toBeCloseTo(k * 1.25, 3);
  await page.keyboard.press('-');
  await expect.poll(async () => (await view(page)).k).toBeCloseTo(k, 3);
  // In the command bar, letters and arrows are text.
  const input = page.getByTestId('command-input');
  const before = await view(page);
  await input.click(); await input.fill(''); await page.keyboard.type('/note wasd');
  await page.keyboard.press('ArrowLeft');
  await expect(input).toHaveValue('/note wasd');
  expect(await view(page)).toEqual(before);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('Alt+arrows select the next unit that way on the map, from the sidebar too', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const center = (id: string) => page.locator(`g.unit[data-unit-id="${id}"] > g > image:not(.stack-frame)`).first().boundingBox().then(b => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
  const selected = () => page.locator('g.unit.selected').getAttribute('data-unit-id');
  await page.locator('body').click({ position: { x: 640, y: 300 } });
  // Nothing selected: from the middle of the map.
  await page.keyboard.press('Alt+ArrowRight');
  const first = await selected();
  expect(first).toBeTruthy();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-kind', 'unit');
  const a = await center(first!);
  await page.keyboard.press('Alt+ArrowLeft');
  const second = await selected();
  expect(second).not.toBe(first);
  expect((await center(second!)).x).toBeLessThan(a.x);
  // The new unit has focus, so Enter and the menu key act on it; Alt+arrows keep working with focus in the sidebar.
  await expect(page.locator(`g.unit[data-unit-id="${second}"]`)).toBeFocused();
  await page.getByTestId('inspector').focus();
  const b = await center(second!);
  await page.keyboard.press('Alt+ArrowDown');
  const third = await selected();
  expect(third).not.toBe(second);
  expect((await center(third!)).y).toBeGreaterThan(b.y);
  // Typing is left alone.
  const input = page.getByTestId('command-input');
  await input.click(); await input.fill('/note x');
  await page.keyboard.press('Alt+ArrowUp');
  expect(await selected()).toBe(third);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
