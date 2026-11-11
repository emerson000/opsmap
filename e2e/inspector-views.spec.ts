import { test, expect } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// The sidebar router: /find opens an area, phase line or sector view; its controls run the same command text the bar
// would (the echo line shows it), and the Beyond chevron opens the sector at its Beyond list.
test('area and phase line views rename and re-date through the command text', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const echo = page.getByTestId('echo-line');
  await expect(echo).toContainText('Hover a control to see its command');

  await command(page, '/find obj "SETTLED IN"');
  await expect(inspector).toHaveAttribute('data-kind', 'area');
  await expect(inspector.getByTestId('view-name')).toHaveText('SETTLED IN');
  await expect(inspector.getByTestId('area-members')).toBeVisible();
  const name = inspector.getByTestId('measure-name');
  await name.fill('moved in');
  await name.press('Enter');
  await name.blur();
  await expect(page.getByTestId('command-preview')).toContainText('OBJ SETTLED IN RENAMED → MOVED IN');
  await expect(inspector.getByTestId('view-name')).toHaveText('MOVED IN');
  await expect(echo).toContainText('/obj rename "SETTLED IN" "moved in"');
  // The same text in the bar gives the same log line.
  await command(page, '/obj rename "MOVED IN" "SETTLED IN"');
  await expect(page.getByTestId('command-preview')).toContainText('OBJ MOVED IN RENAMED → SETTLED IN');

  // The axis that targets it shows on the area's side, and its phase line opens the PL view.
  await expect(inspector.getByTestId('section-targeted')).toContainText('MOVE');
  await command(page, '/find pl LAUNCH');
  await expect(inspector).toHaveAttribute('data-kind', 'pl');
  await expect(inspector.getByTestId('pl-axes')).toContainText('MOVE');
  const date = inspector.getByTestId('pl-date');
  const next = new Date(Date.now() + 50 * 86400000).toISOString().slice(0, 10);
  await date.fill(next);
  await date.blur();
  await expect(page.getByTestId('command-preview')).toContainText(`PL LAUNCH DATED ${next}`);
  await expect(echo).toContainText(`/pl date LAUNCH ${next}`);
  await echo.getByRole('button', { name: 'To bar' }).click({ timeout: 8000 });
  await expect(page.getByTestId('command-input')).toHaveValue(`/pl date LAUNCH ${next}`);

  // Removing a phase line that an axis passes asks first, naming the axis; Keep has focus.
  await inspector.getByTestId('manage-remove').click();
  const confirm = inspector.getByRole('alertdialog');
  await expect(confirm).toContainText('comes off 1 axis');
  await expect(confirm.getByRole('button', { name: 'Keep' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep' }).click();
  await expect(confirm).toHaveCount(0);

  await inspector.getByRole('button', { name: 'Close inspector' }).click();
  await expect(inspector).toHaveAttribute('data-kind', 'map');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('the Beyond chevron opens the sector view at its Beyond list; Pull in moves the unit on map', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const due = new Date(Date.now() + 140 * 86400000).toISOString().slice(0, 10);
  await command(page, `/new hostile "Far problem" in Work due ${due} as FAR`);
  await page.locator('[data-beyond="work"]').click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  const beyond = inspector.getByTestId('section-beyond');
  await expect(beyond).toBeInViewport();
  await expect(beyond).toContainText('FAR');
  await beyond.getByRole('button', { name: 'Pull in' }).click();
  await expect(page.getByTestId('command-preview')).toContainText('MOVE FAR → WORK / FAR');
  await expect(beyond).toContainText('Nothing beyond the map edge');
  // The unit view's sector link opens the same view.
  await command(page, '/find FAR');
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  await inspector.getByRole('button', { name: 'Open sector Work' }).click();
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  await expect(inspector.getByTestId('view-name')).toHaveText('Work');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

test('unit view: Drop… asks Drop or Bypassed, Reopen brings it back; sections remember; /CMD shows every command', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await command(page, '/find RECORDS');
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  await expect(inspector.getByTestId('unit-order')).toHaveClass(/primary/);

  // Drop… opens the choice; Bypassed runs /drop RECORDS bypassed, as the bar would.
  await inspector.getByTestId('unit-drop').click();
  await inspector.getByRole('group', { name: 'Drop RECORDS' }).getByRole('button', { name: 'Bypassed' }).click();
  await expect(page.getByTestId('command-preview')).toContainText('RECORDS');
  await expect(inspector).toContainText('Dropped');
  const reopen = inspector.getByTestId('unit-reopen');
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(reopen).toHaveCount(0);
  await expect(inspector.getByTestId('unit-drop')).toBeVisible();

  // A closed section shows a one-line summary and stays closed after a reload.
  const identity = inspector.getByTestId('section-identity').getByRole('button', { name: /Identity/ });
  await expect(identity).toHaveAttribute('aria-expanded', 'true');
  await identity.click();
  await expect(identity).toHaveAttribute('aria-expanded', 'false');
  await expect(identity).toContainText('Friend');
  await page.reload();
  await openMap(page);
  await command(page, '/find RECORDS');
  await expect(inspector.getByTestId('section-identity').getByRole('button', { name: /Identity/ })).toHaveAttribute('aria-expanded', 'false');

  // /CMD shows each field's full command; hovering a field puts it in the echo line.
  await inspector.getByTestId('cmd-toggle').click();
  await expect(inspector.getByTestId('cmd-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(inspector).toContainText('/move RECORDS to Household');
  await inspector.getByTestId('cmd-toggle').click();
  await inspector.locator('[data-control="unit-note"]').hover();
  await expect(page.getByTestId('echo-line')).toContainText('/note RECORDS');
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

// Hovering a field shows its command in the echo line only; the fields below it keep their place, so the next one is easy to hit.
test('hovering a sidebar field does not move the fields below it', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  await command(page, '/find RECORDS');
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  const rows = inspector.locator('.field-row[data-control]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(3);
  let hovered = 0;
  for (let i = 0; i < count - 1 && hovered < 6; i++) {
    const row = rows.nth(i), next = rows.nth(i + 1);
    if (!(await row.isVisible()) || !(await next.isVisible())) continue;
    const before = (await next.boundingBox())!.y;
    await row.hover({ position: { x: 4, y: 4 } });
    await expect(page.getByTestId('echo-line')).not.toContainText('Hover a control');
    expect((await next.boundingBox())!.y).toBe(before);
    hovered++;
  }
  expect(hovered).toBeGreaterThan(2);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});

// Parity rule 4: every button in a sidebar view shows its command, in its tooltip or accessible description, in its
// label, or in the field row it sits in. Section headers only fold the view, so they are left out.
test('every button in each sidebar view shows its command', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await openMap(page);
  const inspector = page.getByTestId('inspector');
  const silent = () => page.locator('[data-testid="inspector"] > .body').evaluate(body => {
    const has = (t: string | null) => /(^|[\s(:])\/[a-z]/.test(t ?? '');
    return [...body.querySelectorAll('button')]
      .filter(b => b.checkVisibility() && !b.hasAttribute('aria-controls') && !b.closest('.field-row')?.querySelector('.code'))
      .filter(b => !has(b.title) && !has(b.getAttribute('aria-description')) && !has(b.textContent))
      .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
  });
  for (const text of ['', '/find RECORDS', '/find LEAK', '/find obj "SETTLED IN"', '/find pl LAUNCH', '/find sector Household']) {
    if (text) await command(page, text);
    // Open every section.
    await inspector.focus();
    await page.keyboard.press(']');
    expect(await silent(), text || 'Situation').toEqual([]);
  }
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
