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

export async function openLog(page: Page) {
  await page.getByRole('button', { name: 'Open order log', exact: true }).click();
}
