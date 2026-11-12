import { test, expect } from '@playwright/test';
import { userPage, errors } from './helpers';

test('creates an access token from the user menu, uses it on MCP and revokes it', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'bob', baseURL!);
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
  await page.getByTestId('user-menu').click();
  await page.getByTestId('menu-tokens').click();
  const panel = page.getByTestId('access-tokens');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('tk-endpoint')).toHaveText(`${baseURL}/mcp`);
  const name = `e2e agent ${Date.now()}`;
  await panel.getByTestId('tk-name').fill(name);
  await panel.getByTestId('tk-create').click();
  const secret = await panel.getByTestId('tk-secret').inputValue();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(panel.getByTestId('tk-claude')).toContainText(`claude mcp add --transport http opsmap ${baseURL}/mcp --header "Authorization: Bearer ${secret}"`);
  await expect(panel.getByTestId('tk-codex')).toContainText(`url = "${baseURL}/mcp"`);
  const call = () => page.request.post('/mcp', { headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'opsmap_maps', arguments: {} } }) });
  expect((await call()).status()).toBe(200);
  await panel.getByTestId('tk-done').click();
  await expect(panel.getByTestId('tk-created')).toHaveCount(0);
  const row = panel.locator(`[data-testid="tk-row"][data-name="${name}"]`);
  await expect(row).toContainText('last used');
  await row.getByTestId('tk-revoke').click();
  await expect(row.getByTestId('tk-revoke')).toHaveText('Confirm revoke');
  await row.getByTestId('tk-revoke').click();
  await expect(row).toHaveCount(0);
  expect((await call()).status()).toBe(401);
  await panel.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
