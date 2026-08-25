import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(
  repositoryRoot,
  "scripts/generate-workbench-projection-bindings.mjs",
);
const generatedPath = path.join(
  repositoryRoot,
  "desktop/ui/src/transport/generated/workbench-projection.ts",
);

function count(text, needle) {
  return text.split(needle).length - 1;
}

function generate(outputPath, check = false) {
  const args = [generator, "--output", outputPath];
  if (check) args.push("--check");
  execFileSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "rho-workbench-projection-bindings-test-"),
);
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const facet = fs.readFileSync(
    path.join(repositoryRoot, "desktop/ui/src/transport/workbench-projection.ts"),
    "utf8",
  );
  const tauri = fs.readFileSync(
    path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"),
    "utf8",
  );
  const mock = fs.readFileSync(
    path.join(repositoryRoot, "desktop/ui/src/transport/mock.ts"),
    "utf8",
  );

  assert.equal(count(generated, '"workbench_projection_snapshot"'), 1);
  assert.equal(count(tauri, '"workbench_projection_snapshot"'), 0);
  assert.match(generated, /export type WorkbenchProjectionV1 = WorkbenchProjectionV1_Serialize/);
  assert.match(generated, /export type WorkbenchProjectionV1_Serialize = \{/);
  assert.match(generated, /export type WorkbenchRevisionVectorV1 = \{/);
  assert.match(generated, /projection_generation: number/);
  for (const nested of [
    "UiKernelSnapshotV1",
    "ProjectUiProfileSnapshotV1",
    "ResourceRegistrySnapshotV1",
    "RuntimeRegistrySnapshotV1",
    "StudioRuntimeSnapshotV1",
    "SurfaceRuntimeSnapshotV1",
    "SurfaceRuntimeSnapshotV1_Deserialize",
    "SurfaceRuntimeSnapshotV1_Serialize",
  ]) {
    assert.doesNotMatch(generated, new RegExp(`export type ${nested}\\b`));
  }
  assert.match(facet, /readonly contract: "rho\.ui\.workbench-projection\.v1"/);
  assert.match(facet, /export interface WorkbenchProjectionTransport/);
  assert.match(tauri, /\.\.\.createTauriWorkbenchProjectionTransport\(invoke\)/);
  for (const method of ["loadWorkbenchProjection", "subscribeWorkbenchInvalidated"]) {
    assert.match(facet, new RegExp(`\\b${method}\\b`));
    assert.match(mock, new RegExp(`\\b${method}\\b`));
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Workbench projection generated binding contract passed");
