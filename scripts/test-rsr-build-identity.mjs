import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeBuildIdentity } from "./rsr-build-identity.mjs";

const fixture = mkdtempSync(join(tmpdir(), "rho-build-identity-"));

function writeFixtureSource(source) {
  mkdirSync(join(fixture, "desktop", "ui", "src"), { recursive: true });
  writeFileSync(join(fixture, "desktop", "package.json"), "{}\n");
  writeFileSync(join(fixture, "desktop", "package-lock.json"), "{}\n");
  writeFileSync(join(fixture, "desktop", "ui", "index.html"), "<main></main>\n");
  writeFileSync(join(fixture, "desktop", "ui", "tsconfig.json"), "{\"files\": []}\n");
  writeFileSync(join(fixture, "desktop", "ui", "tsconfig.app.json"), "{\"compilerOptions\": {\"strict\": true}}\n");
  writeFileSync(join(fixture, "desktop", "ui", "tsconfig.node.json"), "{\"compilerOptions\": {\"module\": \"ESNext\"}}\n");
  writeFileSync(join(fixture, "desktop", "ui", "vite.config.mts"), "export default {};\n");
  writeFileSync(join(fixture, "desktop", "ui", "src", "main.tsx"), source);
}

try {
  writeFixtureSource("export const value = 1;\n");
  const first = computeBuildIdentity(fixture);
  const repeated = computeBuildIdentity(fixture);
  if (first.id !== repeated.id || JSON.stringify(first.inputs) !== JSON.stringify(repeated.inputs)) {
    throw new Error("identical frontend inputs did not produce an identical build identity");
  }
  for (const config of ["tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
    if (!first.inputs.includes(`desktop/ui/${config}`)) {
      throw new Error(`${config} was omitted from the frontend build identity`);
    }
  }
  writeFileSync(
    join(fixture, "desktop", "ui", "tsconfig.app.json"),
    "{\"compilerOptions\": {\"strict\": false}}\n",
  );
  const configChanged = computeBuildIdentity(fixture);
  if (configChanged.id === first.id) {
    throw new Error("a frontend TypeScript configuration change did not change the build identity");
  }
  writeFixtureSource("export const value = 2;\n");
  const changed = computeBuildIdentity(fixture);
  if (changed.id === first.id) {
    throw new Error("a shipped frontend source change did not change the build identity");
  }
  process.stdout.write(`RSR build identity passed: ${first.id} -> ${changed.id}\n`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
