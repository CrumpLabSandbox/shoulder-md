import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// GitHub Pages serves the site under /shoulder-md/. Local dev and other hosts use /.
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [svelte()],
  build: {
    target: 'es2022',
    sourcemap: true,
    // The Markdown mode bundles HTML, JS and CSS grammars for fenced code; ~270 kB gzipped is expected.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
