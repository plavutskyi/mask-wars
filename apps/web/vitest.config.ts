import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `@/…` as in tsconfig, so tests can import the routes the way the app does.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
