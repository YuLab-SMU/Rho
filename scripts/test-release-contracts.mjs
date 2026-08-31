#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = [
  "test-conditional-prerelease-policy.mjs",
  "test-desktop-platform-config.mjs",
  "test-license-contract.mjs",
  "test-mac4-release-contract.mjs",
  "test-macos-notary.mjs",
  "test-release-notes-workflow.mjs",
  "test-rust-msrv-contract.mjs",
  "test-signpath-candidate-workflow.mjs",
  "test-tauri-bundle-type.mjs",
  "test-tauri-native-updater-contract.mjs",
  "test-three-platform-auto-updater.mjs",
  "test-validate-macos-entitlements.mjs",
  "test-validate-notary-receipt.mjs",
];

const started = Date.now();
for (const contract of contracts) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", contract)], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  `Release contracts passed: ${contracts.length} focused checks in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
