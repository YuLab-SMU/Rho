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
  fs.writeFileSync(path.join(temp, "consumer.mts"), `
import type { PluginManifest, RpcFrame, VisualDocument, PluginRevisionPage } from "./protocol/index.js";
const frame: RpcFrame = { protocol_version: 1, connection: "channel", instance: "instance",
  sequence: 1, request: "request", body: { type: "release" } };
export function inspect(manifest: PluginManifest, visual: VisualDocument, page: PluginRevisionPage) {
  return [frame, manifest.views[0]?.entrypoint, visual.nodes[visual.root], page.next];
}
`);
  execFileSync(process.execPath, [path.join(root, "ui/node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--target", "ES2022", path.join(temp, "consumer.mts")], { stdio: "inherit" });
  for (const name of ["manifest", "archive", "rpc", "scenario", "visual-document"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(temp, "protocol/schema", `${name}.json`), "utf8"));
    assert.ok(schema.$schema && schema.$defs, `missing standalone schema: ${name}`);
  }
  console.log("Public plugin protocol compiles in an external strict NodeNext project; standalone schemas are present.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
