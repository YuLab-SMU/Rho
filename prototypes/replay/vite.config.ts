import { defineConfig } from 'vite';
import path from 'node:path';

// The replay prototype is not part of the shipped WebUI: it has its own root and
// output, and the application build never reads this directory.
const here = path.dirname(new URL(import.meta.url).pathname);
export default defineConfig({
  root: here,
  base: './',
  oxc: { jsx: { runtime: 'automatic' } },
  server: { fs: { allow: [path.resolve(here, '../..')] } },
  build: { outDir: path.resolve(here, 'dist'), emptyOutDir: true, sourcemap: false },
});
