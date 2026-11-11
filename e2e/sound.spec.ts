import { test, expect, type Page } from '@playwright/test';
import { command, errors, openMap, userPage } from './helpers';

// Console cues: a stand-in AudioContext records each tone's frequency instead of playing it.
const record = () => {
  const tones: number[] = [];
  (window as unknown as { __tones: number[] }).__tones = tones;
  class FakeContext {
    state = 'running'; currentTime = 0; destination = {};
    resume() { return Promise.resolve(); }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (x: unknown) => x }; }
    createOscillator() {
      const osc = { type: 'sine', frequency: { value: 0 }, connect: (x: unknown) => x, start() { tones.push(osc.frequency.value); }, stop() {} };
      return osc;
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
};
const tones = (page: Page) => page.evaluate(() => (window as unknown as { __tones: number[] }).__tones.slice());
const clear = (page: Page) => page.evaluate(() => { (window as unknown as { __tones: number[] }).__tones.length = 0; });

test('new tracks and new hostiles give a cue; mute holds across reloads; loading is quiet', async ({ browser, baseURL }) => {
  const page = await userPage(browser, 'alice', baseURL!, true);
  await page.addInitScript(record);
  await openMap(page);
  expect(await tones(page)).toEqual([]);
  await command(page, '/new "Fix the gate"');
  await expect.poll(() => tones(page)).toEqual([1400, 1900]);
  await page.waitForTimeout(1300);
  await clear(page);
  await command(page, '/new hostile "Parking ticket" as TICKET');
  await expect.poll(() => tones(page)).toEqual([2400, 2400, 2400, 2400, 2400]);
  await page.waitForTimeout(1300);
  await clear(page);
  await page.getByTestId('sound-toggle').click();
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  await command(page, '/new "Quiet one"');
  await page.waitForTimeout(400);
  expect(await tones(page)).toEqual([]);
  await page.reload();
  await openMap(page);
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await tones(page)).toEqual([]);
  expect(errors(page)).toEqual([]);
  await page.context().close();
});
