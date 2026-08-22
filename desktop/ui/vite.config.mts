import { URL, fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: uiRoot,
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: false,
  },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: false,
  },
  build: {
    outDir: fileURLToPath(new URL("../rsr-dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    manifest: "asset-manifest.json",
    target: "es2022",
  },
});
