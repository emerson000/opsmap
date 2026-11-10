import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The e2e suite runs against the real server in dev mode: no IdP, dev users alice and bob,
// a fresh SQLite database per run. PUBLIC_URL must equal the browser origin, or the socket upgrade is refused.
const PORT = Number(process.env.E2E_PORT ?? 4174);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// Playwright evaluates this file in every worker; only the main process starts the server, so create the
// data directory once and hand it to workers through the environment.
const dataDir = process.env.OPSMAP_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'opsmap-e2e-'));

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  // Server and browsers share one zone, independent of the machine running the suite.
  use: { baseURL: ORIGIN, timezoneId: 'UTC' },
  // Desktop specs run in Chromium at 1280x800; the mobile spec runs on an iPhone 13 (WebKit) and a
  // Pixel 7 (Chromium), portrait, with touch.
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'iphone13', testMatch: /mobile\.spec\.ts/, use: { ...devices['iPhone 13'] } },
    { name: 'pixel7', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run build && node dist/server/index.js',
    url: `${ORIGIN}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      OPSMAP_DEV_USERS: 'alice,bob',
      OPSMAP_ADMIN_EMAILS: 'alice@dev.local',
      PUBLIC_URL: ORIGIN,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: dataDir,
      OPSMAP_TZ: 'UTC',
      NODE_ENV: 'test',
    },
  },
});
