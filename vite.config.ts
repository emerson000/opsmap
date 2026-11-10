import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist/client' },
  // `npm run dev` serves the client with hot reload and forwards the API, sign-in and WebSocket to the
  // server started by `npm run dev:server` (OPSMAP_API overrides its address).
  server: {
    proxy: Object.fromEntries(['/api', '/auth', '/mcp', '/healthz', '/ws'].map(path => [path, {
      target: process.env.OPSMAP_API ?? 'http://127.0.0.1:8080', ws: path === '/ws',
    }])),
  },
  // Tests run in UTC on every machine; tests that need a DST zone set one explicitly.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', env: { TZ: 'UTC' } },
});
