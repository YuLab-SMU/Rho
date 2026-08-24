import { URL, fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { currentBuildIdentity } from "../../scripts/rsr-build-identity.mjs";

const uiRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: uiRoot,
  base: "./",
  define: {
    __RHO_FRONTEND_BUILD_ID__: JSON.stringify(currentBuildIdentity.id),
  },
  plugins: [
    react(),
    {
      name: "rho-build-identity",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build-identity.json",
          source: `${JSON.stringify({ build_id: currentBuildIdentity.id })}\n`,
        });
      },
    },
  ],
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
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    manifest: "asset-manifest.json",
    target: "es2022",
  },
  publicDir: fileURLToPath(new URL("../legal", import.meta.url)),
});
