import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2022',
    lib: { entry: fileURLToPath(new URL('src/app.ts', import.meta.url)), name: 'RhoStudio', formats: ['iife'], fileName: () => 'app.js', cssFileName: 'style' },
    cssCodeSplit: false,
    emptyOutDir: true,
  },
});
