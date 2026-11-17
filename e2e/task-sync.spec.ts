import { test, expect, type Page } from '@playwright/test';
import { command, errors, resetShared, signIn, watchErrors } from './helpers';

// Task sync from the sidebar against the server's in-memory test service (label Fake, section containers):
// connect a token, bind with a field already off, switch a field, the sector and unit links, Sync, Status and
// Unbind. Every name, noun and link comes from the service's descriptor. Runs only when the server has the test
// service: OPSMAP_FAKE_PROVIDER=1 E2E_PORT=4174 npx playwright test e2e/task-sync.spec.ts
test.skip(process.env.OPSMAP_FAKE_PROVIDER !== '1', 'needs OPSMAP_FAKE_PROVIDER=1');

const phoneProject = (name: string) => name === 'iphone13' || name === 'pixel7';
const result = (page: Page) => page.getByTestId('command-preview');

async function start(page: Page, baseURL: string) {
  const context = page.context();
  await signIn(context, 'alice');
  await resetShared(context, baseURL);
  await context.addInitScript(() => { try { localStorage.setItem('opsmap.ui.oriented', 'yes'); } catch { /* storage blocked */ } });
  watchErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.locator('g.unit[data-unit-id]').first()).toBeVisible();
}

/** The phone shows the sidebar in its sheet (hidden while the command bar has focus): open it to half height. */
async function showSheet(page: Page) {
  await page.getByTestId('command-input').blur();
  const sheet = page.getByTestId('sheet');
  if (!(await sheet.isVisible())) return;
  if ((await sheet.getAttribute('data-size')) === 'peek') await page.getByTestId('sheet-tab-info').click();
  await expect(sheet).not.toHaveAttribute('data-size', 'peek');
}

async function openSection(page: Page) {
  const section = page.getByTestId('inspector').getByTestId('section-tasks');
  const head = section.getByRole('button').first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  return section;
}

async function connect(page: Page) {
  if (await page.getByTestId('user-menu').isVisible()) {
    await page.getByTestId('user-menu').click();
    await page.getByTestId('menu-tasks-fake').click();
  } else {
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('app-menu').getByTestId('menu-tasks-fake').click();
  }
  const panel = page.getByTestId('task-account');
  await expect(panel).toContainText('Fake');
  await panel.getByTestId('tasks-token').fill('fake-alice');
  await panel.getByTestId('tasks-token-save').click();
  await expect(panel.getByTestId('tasks-account-state')).toContainText('Connected as alice');
  await panel.getByRole('button', { name: 'Close Fake' }).click();
  await expect(panel).toHaveCount(0);
}

async function flow(page: Page, project: string) {
  const PROJECT = project.toUpperCase();
  await connect(page);
  await showSheet(page);
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toHaveAttribute('data-kind', 'map');

  // Unbound: no Sync rows, and Bind… shows its command and that it is open.
  let section = await openSection(page);
  await expect(section.getByRole('heading')).toContainText('Task sync');
  await expect(section.getByTestId('tasks-sync')).toHaveCount(0);
  const bind = section.getByTestId('tasks-bind');
  await expect(bind).toHaveAttribute('title', '/tasks bind fake "‹project›"');
  await bind.click();
  await expect(bind).toHaveClass(/\bon\b/);
  const form = section.getByTestId('tasks-bind-form');
  await form.getByLabel('Fake project').fill(project);
  await expect(bind).toHaveAttribute('title', `/tasks bind fake "${project}"`);
  // Fields to sync: only the ones the service syncs, all checked; an unchecked one is left out (without).
  await expect(form.getByRole('checkbox')).toHaveCount(5);
  for (const box of await form.getByRole('checkbox').all()) await expect(box).toBeChecked();
  await form.getByRole('checkbox', { name: 'State' }).uncheck();
  const submit = form.getByRole('button', { name: 'Bind' });
  await expect(submit).toHaveAttribute('title', `/tasks bind fake "${project}" without state`);
  await submit.click();
  // The bound op shows first; wait for the request's own answer (after its first cycle), so it cannot land later
  // and replace the next command's result.
  await expect(result(page)).toContainText(`FAKE BOUND TO ${PROJECT} — `);
  await expect(result(page)).toContainText('tasks created');

  // Bound: the project link and the service's label, the delivery mode in plain words, and the switches (state off).
  await expect(section.getByRole('heading')).toContainText('Task sync');
  await expect(section.getByTestId('tasks-root')).toHaveText(`${project} ↗`);
  await expect(section).toContainText('in Fake');
  const delivery = section.getByTestId('tasks-delivery');
  await expect(delivery).toHaveText('Checking every 1 min. Instant updates need an address Fake can reach.');
  await expect(delivery).toHaveAttribute('title', /PUBLIC_URL/);
  const fields = section.locator('[data-control="tasks-field"]');
  await expect(fields).toHaveCount(1);
  const identity = section.getByTestId('tasks-field-identity'), state = section.getByTestId('tasks-field-state');
  await expect(identity).toHaveAttribute('aria-checked', 'true');
  await expect(state).toHaveAttribute('aria-checked', 'false');
  await expect(identity).toHaveAttribute('title', '/tasks field identity off');
  await showSheet(page);
  await identity.click();
  await expect(result(page)).toContainText('FAKE IDENTITY SYNC OFF');
  await expect(identity).toHaveAttribute('aria-checked', 'false');
  await expect(identity).toHaveAttribute('title', '/tasks field identity on');
  await expect(section).toContainText('Not synced: Identity, State.');

  // Sync and Status write their log lines.
  await section.getByTestId('tasks-sync').click();
  await expect(result(page)).toContainText('FAKE SYNC');
  await section.getByTestId('tasks-status').click();
  await expect(result(page)).toContainText(`FAKE: bound to ${project}`);
  await expect(result(page)).toContainText('not synced: identity, state');

  // The sector's section link and the unit's task link, from the descriptor's URL templates.
  await command(page, '/find sector Household');
  await showSheet(page);
  await expect(inspector).toHaveAttribute('data-kind', 'sector');
  section = await openSection(page);
  const sectionLink = section.getByTestId('tasks-container');
  await expect(sectionLink).toHaveText('Household ↗');
  await expect(sectionLink).toHaveAttribute('href', /^http:\/\/fake\.invalid\/[^/]+\/[^/]+$/);
  await expect(section.getByTestId('tasks-field-identity')).toHaveAttribute('aria-checked', 'false');

  await command(page, '/find LEAK');
  await showSheet(page);
  await expect(inspector).toHaveAttribute('data-kind', 'unit');
  const task = /^http:\/\/fake\.invalid\/[^/]+\/task\/[^/]+$/;
  const headLink = inspector.getByTestId('tasks-link');
  await expect(headLink).toHaveText('Fake task ↗');
  await expect(headLink).toHaveAttribute('href', task);
  const unitSection = await openSection(page);
  await expect(unitSection.getByRole('heading')).toContainText('Task sync');
  await expect(unitSection.getByTestId('tasks-task')).toHaveText('Open LEAK in Fake ↗');
  await expect(unitSection.getByTestId('tasks-sync')).toHaveText('Sync now');
  await expect(unitSection.getByTestId('tasks-sync')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(unitSection.getByTestId('tasks-task')).toHaveAttribute('href', task);

  // Unbind… asks first; Keep leaves the map bound.
  await page.keyboard.press('Escape');
  await command(page, '/find sector Household');
  await showSheet(page);
  section = await openSection(page);
  await section.getByTestId('tasks-unbind').click();
  await expect(section.getByTestId('tasks-unbind')).toHaveClass(/\bon\b/);
  const confirm = section.getByRole('alertdialog', { name: 'Unbind the map' });
  await expect(confirm).toContainText(`Unbind the whole map from ${project}?`);
  await confirm.getByRole('button', { name: 'Keep' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(section.getByTestId('tasks-root')).toBeVisible();
  await section.getByTestId('tasks-unbind').click();
  await section.getByRole('alertdialog', { name: 'Unbind the map' }).getByRole('button', { name: 'Unbind' }).click();
  await expect(result(page)).toContainText(`FAKE UNBOUND FROM ${PROJECT}`);
  await expect(section.getByTestId('tasks-bind')).toBeVisible();
  await expect(section.getByTestId('tasks-root')).toHaveCount(0);
  // WebKit warns about the viewport key interactive-widget (Chrome's keyboard mode); Safari ignores it.
  expect(errors(page).filter(e => !/interactive-widget/.test(e))).toEqual([]);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('task sync from the sidebar at 1440 px', async ({ page, baseURL }, info) => {
    test.skip(phoneProject(info.project.name), 'desktop project only');
    await start(page, baseURL!);
    await flow(page, 'Ops');
  });
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('task sync from the sidebar at 1024 px', async ({ page, baseURL }, info) => {
    test.skip(phoneProject(info.project.name), 'desktop project only');
    await start(page, baseURL!);
    await flow(page, 'Ops tablet');
  });
});

test('task sync from the phone sheet', async ({ page, baseURL }, info) => {
  test.skip(!phoneProject(info.project.name), 'phone projects only');
  await start(page, baseURL!);
  // Each run binds its own project: the test service keeps every project's tasks until the server stops.
  await flow(page, `Ops ${info.project.name}`);
});
