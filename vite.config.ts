import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist/client' },
  // Tests run in UTC on every machine; tests that need a DST zone set one explicitly.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', env: { TZ: 'UTC' } },
});
