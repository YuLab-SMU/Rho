import { URL, fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { currentBuildIdentity } from "../../scripts/rsr-build-identity.mjs";

// Inner-loop tests deliberately exclude the two broad Workbench integration
// suites and scenario acceptance fixtures. Those remain in `rsr:test` and the
// pre-handoff/release tiers; focused invocations can still run either file.
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
    exclude: [
      "src/app/App.test.tsx",
      "src/app/agent/AgentSurface.test.tsx",
      "src/acceptance/**",
    ],
    restoreMocks: true,
  },
});
