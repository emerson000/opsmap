import { test, expect } from '@playwright/test';
import { command, errors, openMap, sameAsBar, userPage } from './helpers';

// The unit view's controls for what used to need the command bar: each one runs the same text the bar would
// (the echo line shows it) and gives the same log line.
test('unit view: near, attach and detach, reinforce with, scope cut, halt by kind, due none', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await command(page, '/find RECORDS');

  // Near: a unit picker, ranked like the bar; Enter chooses and runs.
  const near = inspector.getByTestId('unit-near');
  await sameAsBar(page, async () => { await near.fill('SLEEP'); await near.press('Enter'); }, '/move RECORDS near SLEEP');

  // Attach to a task force (task forces lead the list), then detach from the TF's member list.
  const attach = inspector.getByTestId('unit-attach');
  await attach.click();
  await expect(inspector.getByRole('listbox', { name: 'Attach to a task force' }).getByRole('option').first()).toContainText('MOVE');
  await sameAsBar(page, () => inspector.getByRole('option', { name: /^FR MOVE / }).click(), '/attach RECORDS to MOVE');
  await expect(inspector.getByRole('button', { name: 'TF MOVE' })).toBeVisible();
  await command(page, '/find MOVE');
  const members = inspector.getByTestId('tf-members');
  await expect(members).toContainText('RECORDS');
  await sameAsBar(page, () => members.getByRole('button', { name: 'Detach: RECORDS' }).click(), '/detach RECORDS');

  // Reinforce with another unit (it attaches), and reduce with a scope cut.
  await command(page, '/find IRSRSP');
  const withUnit = inspector.getByTestId('reinforce-with');
  await sameAsBar(page, async () => { await withUnit.fill('TOOLS'); await withUnit.press('Enter'); }, '/reinforce IRSRSP with TOOLS');
  const scope = inspector.getByTestId('reduce-note');
  await sameAsBar(page, async () => { await scope.fill('Only 2025'); await scope.press('Enter'); }, '/reduce IRSRSP "Only 2025"');

  // Halt by kind: All plus each kind of its own orders.
  await expect(inspector.locator('[data-testid="halt-kind"][data-kind="all"]')).toBeVisible();
  await sameAsBar(page, () => inspector.locator('[data-testid="halt-kind"][data-kind="attack"]').click(), '/halt IRSRSP attack');

  // Due: None clears it.
  await command(page, '/find KNEE');
  await sameAsBar(page, () => inspector.getByTestId('due-none').click(), '/due KNEE none');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('unit view: function confirm inline, a map pick for Near, and the Vikunja-free view', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');

  // A hostile made a person asks first, inline; the confirm runs /fn … confirm.
  await command(page, '/find LEAK');
  await inspector.getByLabel('Function').selectOption('person');
  const confirm = inspector.getByRole('alertdialog', { name: 'Make a hostile a person' });
  await expect(confirm).toBeVisible();
  await sameAsBar(page, () => confirm.getByTestId('fn-confirm').click(), '/fn LEAK person confirm');

  // Near, picked on the map: the banner shows the command; other units are ringed, the unit itself is dimmed.
  await command(page, '/find RECORDS');
  await inspector.getByTestId('unit-near-map').click();
  const banner = page.getByTestId('pick-banner');
  await expect(banner).toContainText('/move RECORDS near');
  await expect(page.locator('g.unit[data-unit-id="records"]')).toHaveClass(/pick-dim/);
  await sameAsBar(page, () => page.locator('g.unit[data-unit-id="sleep"] image').first().click(), '/move RECORDS near SLEEP');
  await expect(banner).toHaveCount(0);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('long-press shows a control’s command without running it; single-letter keys and their switch; F6', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await command(page, '/find RECORDS');

  // Hold Done: the bubble shows /done RECORDS and the unit stays open.
  const done = inspector.getByTestId('unit-done');
  const box = (await done.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(inspector.getByTestId('cmd-bubble')).toHaveText('/done RECORDS');
  await page.mouse.up();
  await expect(done).toBeVisible();
  await expect(inspector.getByTestId('unit-reopen')).toHaveCount(0);

  // ] and [ expand and collapse every section, while focus is in the sidebar.
  await inspector.getByTestId('cmd-toggle').focus();
  await page.keyboard.press('[');
  await expect(inspector.getByTestId('section-identity').getByRole('button', { name: /Identity/ })).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press(']');
  await expect(inspector.getByTestId('section-identity').getByRole('button', { name: /Identity/ })).toHaveAttribute('aria-expanded', 'true');

  // Legend → Keys turns them off: N no longer opens the composer.
  await page.getByRole('button', { name: 'Legend', exact: true }).click();
  await page.getByTestId('legend').getByRole('tab', { name: 'Keys' }).click();
  const keys = page.getByTestId('single-keys');
  await expect(keys).toHaveAttribute('aria-checked', 'true');
  await keys.click();
  await expect(keys).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Close legend' }).click();
  await inspector.getByTestId('cmd-toggle').focus();
  await page.keyboard.press('n');
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await page.reload();
  await openMap(page);
  await page.getByRole('button', { name: 'Legend', exact: true }).click();
  await page.getByTestId('legend').getByRole('tab', { name: 'Keys' }).click();
  await expect(page.getByTestId('single-keys')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('single-keys').click();
  await page.getByRole('button', { name: 'Close legend' }).click();

  // F6: map → sidebar → command bar → map.
  await page.locator('svg.map-svg').focus();
  await page.keyboard.press('F6');
  await expect(inspector).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.getByTestId('command-input')).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.locator('svg.map-svg')).toBeFocused();
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
