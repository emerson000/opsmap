import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// Desktop right-click: a unit's menu (actions and command-bar prompts), the capture menu on open ground.
test('right-click menus on desktop', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const input = page.getByTestId('command-input');
  const menu = page.getByTestId('unit-menu');
  const symbol = (id: string) => page.locator(`g.unit[data-unit-id="${id}"] image`).first();

  // A friendly: attack is offered, the first item has focus, arrows move, Escape closes.
  await symbol('irsrsp').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('IRSRSP');
  await expect(menu.locator('[data-action="attack"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('[data-action="move"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('inspector')).toContainText('IRSRSP');   // right-click also selects

  // Each item shows its command; Attack… opens the order composer with Attack chosen, Shift+click fills the bar.
  await symbol('irsrsp').click({ button: 'right' });
  await expect(menu.locator('[data-action="attack"]')).toContainText('/attack');
  await expect(menu.locator('[data-action="inspect"]')).toBeVisible();
  await menu.locator('[data-action="attack"]').click();
  await expect(page.getByTestId('composer-preview')).toContainText('/attack IRSRSP');
  await expect(page.getByTestId('composer').locator('[data-verb="attack"]')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('composer').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await symbol('irsrsp').click({ button: 'right' });
  await menu.locator('[data-action="attack"]').click({ modifiers: ['Shift'] });
  await expect(input).toHaveValue('/attack IRSRSP ');
  await input.fill('');
  await input.blur();

  // A prompt item fills the command bar with the caret inside the quotes.
  await symbol('passport').click({ button: 'right' });
  await menu.locator('[data-action="note"]').click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('/note PASSPORT ""');
  await page.keyboard.type('Photo booked');
  await input.press('Enter');
  await expect(page.getByTestId('command-preview')).toContainText('✓');

  // A direct action runs at once. Threats read Destroyed and Bypassed, and have no Attack.
  await symbol('leak').click({ button: 'right' });
  await expect(menu.locator('[data-action="attack"]')).toHaveCount(0);
  await expect(menu.locator('[data-action="done"] .cm-label')).toHaveText('Destroyed');
  await expect(menu.locator('[data-action="reopen"]')).toHaveCount(0);
  await menu.locator('[data-action="done"]').click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('toasts')).toContainText('LEAK');
  await page.getByTestId('toasts').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('g.unit[data-unit-id="leak"]')).toBeVisible();

  // Open ground: the capture menu, compact; a press elsewhere closes it.
  // A point inside the rings with no unit, label or area under it.
  const ground = await page.evaluate(() => {
    const svg = document.querySelector('svg.map-svg')!.getBoundingClientRect();
    const cx = svg.left + svg.width / 2, cy = svg.top + svg.height / 2;
    for (let r = 60; r < 260; r += 20) for (let a = 0; a < 360; a += 15) {
      const x = cx + r * Math.cos(a * Math.PI / 180), y = cy + r * Math.sin(a * Math.PI / 180);
      const el = document.elementFromPoint(x, y);
      if (el?.closest('svg.map-svg') && !el.closest('[data-interactive], [data-unit-id], [data-measure-id], [data-beyond], [data-sector-id]')) return { x, y };
    }
    return null;
  });
  expect(ground).not.toBeNull();
  await page.mouse.click(ground!.x, ground!.y, { button: 'right' });
  await expect(page.getByTestId('capture-menu')).toBeVisible();
  await page.getByTestId('inspector').click({ position: { x: 20, y: 300 } });
  await expect(page.getByTestId('capture-menu')).toHaveCount(0);

  // Clicking a unit that is already selected still puts it first in the suggestions.
  await symbol('records').click();
  await command(page, '/note TOOLS "x"');
  await symbol('records').click();
  await input.click(); await input.fill('/note ');
  await expect(page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option').first()).toContainText('RECORDS');

  expect(errors(page)).toEqual([]);
  await page.context().close();
});
