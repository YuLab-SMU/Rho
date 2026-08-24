import { URL, fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { currentBuildIdentity } from "../../scripts/rsr-build-identity.mjs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __RHO_FRONTEND_BUILD_ID__: JSON.stringify(currentBuildIdentity.id),
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
