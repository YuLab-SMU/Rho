import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts/generate-kernel-bindings.mjs");
const generatedPath = path.join(repositoryRoot, "desktop/ui/src/transport/generated/kernel.ts");
const commands = ["ui_kernel_snapshot", "ui_set_selection"];

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

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-kernel-bindings-test-"));
try {
  const first = path.join(temporaryDirectory, "first.ts");
  const second = path.join(temporaryDirectory, "second.ts");
  generate(first);
  generate(second);
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(firstBytes, fs.readFileSync(second), "two clean Kernel generations differ");
  assert.deepEqual(firstBytes, fs.readFileSync(generatedPath), "checked-in Kernel bindings are stale");
  fs.appendFileSync(first, "// stale fixture\n");
  assert.throws(() => generate(first, true), /Command failed/);

  const generated = fs.readFileSync(generatedPath, "utf8");
  const tauri = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/tauri.ts"), "utf8");
  const types = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/types.ts"), "utf8");
  const facet = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/kernel-generated.ts"), "utf8");
  const mock = fs.readFileSync(path.join(repositoryRoot, "desktop/ui/src/transport/mock.ts"), "utf8");

  assert.match(generated, /import type \{ ResourceBindingV1 \} from "\.\/resource"/);
  assert.match(generated, /import type \{ SurfaceOriginV1 \} from "\.\/surface-studio"/);
  assert.match(generated, /uiKernelSnapshot: \(\)/);
  assert.match(generated, /uiSetSelection: \(request: SetUiSelectionRequest\)/);
  assert.match(generated, /command_registry: CommandRegistryV1/);
  assert.match(generated, /selection: UiSelectionV1 \| null/);
  assert.match(facet, /readonly contract: "rho\.ui\.kernel\.snapshot\.v1"/);
  assert.match(facet, /export interface KernelTransport/);
  assert.match(tauri, /const kernelTransport = createTauriKernelTransport\(invoke\)/);
  assert.match(tauri, /\.\.\.kernelTransport/);
  for (const command of commands) {
    assert.equal(count(generated, `"${command}"`), 1);
    assert.equal(count(tauri, `"${command}"`), 0);
  }
  for (const name of ["UiSelection", "UiContext", "CommandDefinition", "CommandRegistration", "UiKernelSnapshot", "SetUiSelectionRequest"]) {
    assert.doesNotMatch(types, new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  for (const method of ["loadSnapshot", "setSelection"]) {
    assert.match(facet, new RegExp(`\\b${method}\\b`));
    assert.match(mock, new RegExp(`\\b${method}\\b`));
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("UI Kernel generated binding contract passed");
