import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateCrates = /\brho[-_](?:host|application|contract|operation|workbench|sqlite|workspace|r[-_]runtime|agents|agent[-_]client)\b/;

export function checkPluginSource(name, content) {
  if (/\.(?:[cm]?[jt]sx?|rs)$|Cargo\.toml$/.test(name)) {
    assert.ok(!privateCrates.test(content), `${name}: plugin imports a private core/scientific crate`);
    assert.ok(!/(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:ui\/src|crates\/)/.test(content),
      `${name}: plugin imports repository-private source`);
  }
  if (name.endsWith("plugin.json")) {
    const manifest = JSON.parse(content);
    for (const field of ["bundled", "trusted", "builtin", "privileged", "skip_validation"])
      assert.ok(!Object.hasOwn(manifest, field), `${name}: delivery origin cannot bypass validation`);
  }
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `${location}: plugin package source contains a symlink`);
    if (["node_modules", "target", "dist"].includes(entry.name)) return [];
    return entry.isDirectory() ? walk(location) : [location];
  });
}

if (process.argv.includes("--self-test")) {
  for (const [name, content] of [
    ["src/view.ts", "import { Studio } from '../../../ui/src/studio'"],
    ["backend/src/main.rs", "use rho_host::NextHost;"],
    ["backend/Cargo.toml", 'rho-contract = { path = "../../../crates/contract" }'],
    ["plugin.json", '{"bundled":true}'],
  ]) assert.throws(() => checkPluginSource(name, content));
  checkPluginSource("src/view.ts", 'import type { PluginManifest } from "@rho/plugin-protocol";');
  checkPluginSource("backend/src/main.rs", "use rho_plugin_sdk::Backend;");
  console.log("Plugin private-import and delivery-bypass fixtures passed.");
} else {
  for (const file of walk(path.join(root, "plugins")))
    checkPluginSource(path.relative(root, file), fs.readFileSync(file, "utf8"));
  console.log("Plugin packages use public contracts without private core imports or delivery exceptions.");
}
