import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rho-public-protocol-"));
try {
  // A consumer outside this checkout must not need core types or Studio's
  // bundler-specific resolution. This also catches extensionless ESM imports.
  fs.cpSync(path.join(root, "sdk/plugin-protocol"), path.join(temp, "protocol"), { recursive: true });
  const consumer = path.join(temp, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "consumer.mts"), `
import type { PluginManifest, RpcFrame, VisualDocument, PluginRevisionPage, PendingCancellation, UpdatePluginWindowLayout } from "../protocol/index.js";
const layout: UpdatePluginWindowLayout = { window: "window", expected_version: 0, layout: { kind: "tabs", id: "group", selected: "view", views: ["view"] } };
const frame: RpcFrame = { protocol_version: 1, connection: "channel", instance: "instance",
  sequence: 1, request: "request", body: { type: "release" } };
const original: PendingCancellation = { operation_id: "original", binding: {
  capability: { id: "example.run", version: 1 }, project: "project", target: "native",
  provider: { instance: "instance", plugin: "example.plugin", revision: "sha256:" + "a".repeat(64), artifact: "sha256:" + "b".repeat(64) }
} };
const prepare: RpcFrame = { ...frame, body: { type: "prepare_pending_cancellation", data: original } };
const ready: RpcFrame = { ...frame, body: { type: "ready", data: { revision: original.binding.provider.revision, artifact: original.binding.provider.artifact } } };
const extended: RpcFrame = { ...frame, body: { type: "ready", data: { revision: original.binding.provider.revision, artifact: original.binding.provider.artifact, features: ["pending_cancellation_v1"] } } };
export function inspect(manifest: PluginManifest, visual: VisualDocument, page: PluginRevisionPage) {
  return [frame, prepare, ready, extended, layout, manifest.views[0]?.entrypoint, visual.nodes[visual.root], page.next];
}
`);
  execFileSync(process.execPath, [path.join(root, "ui/node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--target", "ES2022", "--rootDir", consumer, path.join(consumer, "consumer.mts")], { stdio: "inherit" });
  for (const name of ["manifest", "archive", "rpc", "resource-transfer-request", "resource-transfer-response", "view-message", "window-layout", "scenario", "visual-document"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema", `${name}.json`), "utf8"));
    assert.ok(schema.$schema && schema.$defs, `missing standalone schema: ${name}`);
  }
  console.log("Public plugin protocol compiles in an external strict NodeNext project; standalone schemas are present.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
