import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  base: '/',
  oxc: { jsx: { runtime: 'automatic' } },
  build: { outDir: '../dist/web', emptyOutDir: true, manifest: true, sourcemap: false, license: { fileName: 'licenses.md' } },
});
