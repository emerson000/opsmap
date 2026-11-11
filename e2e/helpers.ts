import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { seedDoc } from '../src/core/model/seed';

/** Sign in through the dev-mode route; the session cookie lands in the context. */
export async function signIn(context: BrowserContext, user: 'alice' | 'bob'): Promise<void> {
  const res = await context.request.get(`/auth/dev-login?user=${user}`);
  expect(res.ok()).toBe(true);
}

/** Replace the shared map with the demo seed (admin import, as Alice). */
export async function resetShared(context: BrowserContext, baseURL: string): Promise<void> {
  const res = await context.request.post('/api/import', { data: JSON.stringify(seedDoc(new Date())), headers: { origin: baseURL, 'content-type': 'application/json' } });
  expect(res.ok(), await res.text()).toBe(true);
}

export async function openMap(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await expect(page.locator('g.unit[data-unit-id]').first()).toBeVisible();
}

export async function userPage(browser: Browser, user: 'alice' | 'bob', baseURL: string, reset = false): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  await signIn(context, user);
  if (reset) await resetShared(context, baseURL);
  const page = await context.newPage();
  watchErrors(page);
  return page;
}

const errorsOf = new WeakMap<Page, string[]>();
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  errorsOf.set(page, errors);
  return errors;
}
export const errors = (page: Page) => errorsOf.get(page) ?? [];

export async function command(page: Page, text: string) {
  const input = page.getByTestId('command-input');
  await input.click();
  await input.fill(text);
  await expect(page.getByTestId('command-preview')).toContainText('▸');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('command-preview')).toContainText('✓');
}

/** A screen point on a sector's rim name (its hit arc) that nothing else covers, for clicks and taps. */
export function rimPoint(page: Page, sectorId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(id => {
    const path = document.querySelector(`g.rim[data-sector-id="${id}"] path.rim-hit`) as SVGPathElement;
    const len = path.getTotalLength(), m = path.getScreenCTM()!;
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const p = path.getPointAtLength(len * f).matrixTransform(m);
      if (document.elementFromPoint(p.x, p.y)?.closest('[data-sector-id]')?.getAttribute('data-sector-id') === id) return { x: p.x, y: p.y };
    }
    throw new Error(`No clickable point on the ${id} rim name`);
  }, sectorId);
}

/**
 * Use a sidebar control, then check it ran exactly `text` (the echo line shows the command it ran), undo it, run `text`
 * in the command bar, and check the bar gives the same log line. Returns that line.
 */
export async function sameAsBar(page: Page, use: () => Promise<void>, text: string): Promise<string> {
  const preview = page.getByTestId('command-preview');
  const before = (await preview.innerText()).trim();
  await use();
  await expect(preview).not.toHaveText(before);
  await expect(preview).toContainText('✓');
  // Pointer and focus off the sidebar: the echo line shows the command that ran, not the one under the pointer.
  await page.mouse.move(0, 400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.getByTestId('echo-line')).toContainText(text);
  const line = (await preview.innerText()).trim();
  await command(page, '/undo');
  await command(page, text);
  await expect(preview).toHaveText(line);
  return line;
}

export async function openLog(page: Page) {
  await page.getByRole('button', { name: 'Open order log', exact: true }).click();
}
