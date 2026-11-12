import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// A supporter becomes an attachment from the sidebar; a task force collapses into one stacked symbol and expands
// again from the badge, a double-click, the right-click menu, its sidebar and the Situation view.
test('support becomes an attachment, and a task force collapses and expands', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const shown = (id: string) => page.locator(`g.unit[data-unit-id="${id}"]`);
  const symbol = (id: string) => page.locator(`g.unit[data-unit-id="${id}"] image:not(.stack-frame)`).first();
  const badge = page.locator('g.unit[data-unit-id="move"] [data-testid="tf-stack"]');
  const section = (key: string) => inspector.getByTestId(`section-${key}`);
  const openSection = async (key: string) => {
    const head = section(key).getByRole('button').first();
    if (await head.getAttribute('aria-expanded') === 'false') await head.click();
  };

  // SLEEP supports MOVE; its support row offers Attach, which attaches it and ends the support.
  await command(page, '/support SLEEP MOVE');
  await command(page, '/find SLEEP');
  await openSection('orders');
  const attach = inspector.getByTestId('support-attach');
  await expect(attach).toHaveAttribute('title', /\/attach SLEEP to MOVE/);
  await attach.click();
  await expect(page.getByTestId('command-preview')).toContainText('SLEEP ATTACHED TO TF MOVE — SUPPORT ENDED');
  await expect(inspector.getByTestId('support-attach')).toHaveCount(0);
  await command(page, '/detach SLEEP');

  // The task force's sidebar: Expanded is on; Collapsed runs /collapse MOVE and the members leave the map.
  await command(page, '/find MOVE');
  await openSection('taskorg');
  await expect(inspector.getByTestId('tf-expand')).toHaveAttribute('aria-checked', 'true');
  await expect(inspector.getByTestId('tf-collapse')).toHaveAttribute('title', /\/collapse MOVE/);
  await inspector.getByTestId('tf-collapse').click();
  await expect(page.getByTestId('command-preview')).toContainText('TF MOVE COLLAPSED — 2 UNITS');
  await expect(shown('packing')).toHaveCount(0);
  await expect(shown('movers')).toHaveCount(0);
  await expect(badge).toHaveAttribute('data-count', '2');
  await expect(inspector.getByTestId('tf-collapse')).toHaveAttribute('aria-checked', 'true');

  // The badge expands it.
  await badge.click();
  await expect(shown('packing')).toHaveCount(1);
  await expect(badge).toHaveCount(0);

  // Desktop double-click on the task force toggles it.
  await symbol('move').dblclick();
  await expect(badge).toHaveCount(1);
  await expect(shown('movers')).toHaveCount(0);

  // A hidden unit's view says where it is and expands its task force.
  await command(page, '/find PACKING');
  await openSection('taskorg');
  await expect(inspector.getByTestId('unit-hidden')).toContainText('Hidden in collapsed task force MOVE');
  await inspector.getByTestId('holder-expand').click();
  await expect(shown('packing')).toHaveCount(1);

  // The right-click menu collapses it, with its command.
  await symbol('move').click({ button: 'right' });
  const item = page.getByTestId('unit-menu').locator('[data-action="collapse"]');
  await expect(item).toContainText('/collapse');
  await item.click();
  await expect(badge).toHaveCount(1);

  // The Situation view lists the task force and expands every one.
  await page.getByRole('button', { name: 'Close inspector' }).click();
  const tfs = inspector.getByTestId('situation-tfs');
  await expect(tfs).toContainText('MOVE');
  await expect(tfs).toContainText('Collapsed · 2');
  await expect(tfs.getByTestId('tf-collapse')).toBeDisabled();
  await tfs.getByTestId('tf-expand').click();
  await expect(page.getByTestId('command-preview')).toContainText('TF MOVE EXPANDED');
  await expect(shown('movers')).toHaveCount(1);
  await expect(tfs.getByTestId('tf-collapse')).toBeEnabled();

  // The state is stored in the map: another user sees the stack.
  await command(page, '/collapse all');
  const bob = await userPage(browser, 'bob', baseURL!);
  await openMap(bob);
  await expect(bob.locator('g.unit[data-unit-id="move"] [data-testid="tf-stack"]')).toHaveAttribute('data-count', '2');
  await expect(bob.locator('g.unit[data-unit-id="packing"]')).toHaveCount(0);

  expect(errors(page)).toEqual([]);
  expect(errors(bob)).toEqual([]);
});
