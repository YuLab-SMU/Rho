import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function assertAgentEngineBoundary(pkg) {
  for (const dep of pkg.dependencies) {
    assert.ok(!(dep.name === "rig" || dep.name.startsWith("rig-")) || pkg.name === "rho-agent-engine",
      `${pkg.name} imports the component Agent engine outside rho-agent-engine`);
  }
}
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--manifest-path", path.join(root, "Cargo.toml"),
  "--format-version", "1", "--no-deps", "--offline",
], { encoding: "utf8" }));
assert.equal(path.resolve(metadata.workspace_root), root,
  "The repository root must be the single production workspace");
const cli = metadata.packages.find(pkg => pkg.name === "rho-cli");
assert.ok(cli, "production CLI is missing");
assert.deepEqual(metadata.workspace_default_members, [cli.id]);
assert.deepEqual(cli.targets.filter(target => target.kind.includes("bin")).map(target => target.name), ["rho"]);
const sqlite = metadata.packages.find(pkg => pkg.name === "rho-sqlite");
assert.deepEqual(sqlite.features["application-store"], [],
  "Generic SQLite state must not pull in a fixed Application owner");
const journalFixture = metadata.packages.find(pkg => pkg.name === "rho-plugins")
  .dependencies.find(dep => dep.name === "rho-sqlite");
assert.equal(journalFixture.uses_default_features, false,
  "Plugin journal fixtures must not compile the generic application state");
assert.deepEqual(journalFixture.features, []);
const allowed = {
  "rho-plugin-protocol": [],
  "rho-plugin-sdk": ["rho-plugin-protocol"],
  "rho-plugins": ["rho-process-engine", "rho-plugin-protocol", "rho-plugin-sdk", "rho-contract", "rho-operation"],
  "rho-r-backend": ["rho-plugin-sdk", "rho-r-api", "rho-r-engine", "rho-environment-api"],
  "rho-r-api": ["rho-plugin-protocol"],
  "rho-r-engine": ["rho-r-api", "rho-plugin-protocol"],
  "rho-files-api": [],
  "rho-files-backend": ["rho-plugin-sdk", "rho-files-api", "rho-files-engine", "rho-files-owner"],
  "rho-editor-backend": ["rho-plugin-sdk"],
  "rho-files-owner": ["rho-files-api"],
  "rho-files-engine": ["rho-files-api", "rho-process-engine"],
  "rho-process-api": ["rho-plugin-protocol"],
  "rho-process-engine": ["rho-plugin-protocol"],
  "rho-process-owner": ["rho-process-api", "rho-process-engine", "rho-plugin-protocol"],
  "rho-process-backend": ["rho-process-api", "rho-process-owner", "rho-plugin-sdk"],
  "rho-remote-backend": ["rho-remote-api", "rho-remote-owner", "rho-process-api", "rho-plugin-sdk"],
  "rho-remote-api": ["rho-plugin-protocol", "rho-process-api"],
  "rho-remote-owner": ["rho-remote-api", "rho-process-api", "rho-process-engine", "rho-plugin-protocol"],
  "rho-environment-api": ["rho-process-api", "rho-plugin-protocol"],
  "rho-environment-backend": ["rho-environment-api", "rho-environment-owner", "rho-process-api", "rho-plugin-sdk", "rho-r-api"],
  "rho-environment-owner": ["rho-environment-api", "rho-process-engine", "rho-process-owner"],
  "rho-contract": ["rho-plugin-protocol"],
  "rho-operation": ["rho-contract", "rho-plugin-protocol"],
  "rho-sqlite": ["rho-contract", "rho-operation"],
  "rho-host": ["rho-plugin-protocol", "rho-plugins", "rho-contract", "rho-operation", "rho-sqlite"],
  "rho-mcp": ["rho-contract", "rho-host"],
  "rho-agent-api": ["rho-plugin-protocol", "rho-r-api"],
  "rho-agent-backend": ["rho-plugin-sdk", "rho-agent-api", "rho-agent-owner", "rho-agent-store", "rho-agent-engine", "rho-agent-client", "rho-agent-native"],
  "rho-agent-owner": ["rho-agent-api"],
  "rho-agent-store": ["rho-agent-api", "rho-agent-owner"],
  "rho-agent-engine": ["rho-agent-api", "rho-agent-owner"],
  "rho-agent-client": ["rho-agent-api"],
  "rho-agent-native": ["rho-agent-api", "rho-agent-owner", "rho-agent-client"],
  "rho-annotation-api": [],
  "rho-annotation-owner": ["rho-annotation-api"],
  "rho-annotation-store": ["rho-annotation-api", "rho-annotation-owner"],
  "rho-annotation-backend": ["rho-annotation-api", "rho-annotation-owner", "rho-annotation-store", "rho-plugin-sdk"],
  "rho-workbench": ["rho-plugin-protocol", "rho-contract", "rho-host", "rho-mcp"],
  "rho-cli": ["rho-contract", "rho-host", "rho-mcp", "rho-workbench", "rho-plugin-protocol", "rho-plugins"],
};
const pluginLibraries = {
  "rho-annotation-api": "plugins/annotations/api",
  "rho-annotation-owner": "plugins/annotations/backend/owner",
  "rho-annotation-store": "plugins/annotations/backend/store",
  "rho-agent-native": "plugins/agent/backend/native",
  "rho-agent-owner": "plugins/agent/backend/owner",
  "rho-agent-store": "plugins/agent/backend/store",
  "rho-agent-engine": "plugins/agent/backend/engine",
  "rho-agent-api": "plugins/agent/api", "rho-agent-client": "plugins/agent/backend/client",
  "rho-environment-api": "plugins/environment/api", "rho-environment-owner": "plugins/environment/backend/owner",
  "rho-remote-api": "plugins/remote/api", "rho-remote-owner": "plugins/remote/backend/owner",
  "rho-r-api": "plugins/r/api", "rho-r-engine": "plugins/r/backend/engine",
  "rho-files-owner": "plugins/files/backend/owner",
  "rho-files-api": "plugins/files/api", "rho-files-engine": "plugins/files/backend/engine",
  "rho-process-api": "plugins/process/api", "rho-process-owner": "plugins/process/backend/owner",
};
for (const pkg of metadata.packages) {
  assertAgentEngineBoundary(pkg);
  assert.ok(Object.hasOwn(allowed, pkg.name), `Unclassified production owner: ${pkg.name}`);
  for (const dep of pkg.dependencies) {
    if (dep.path) {
      if (pkg.name === "rho-r-engine" && dep.name === "jet_core") {
        assert.equal(path.resolve(dep.path), path.resolve(root, "vendor/jet-core"));
        continue;
      }
      if (Object.hasOwn(pluginLibraries, dep.name)) {
        assert.equal(path.resolve(dep.path), path.resolve(root, pluginLibraries[dep.name]));
      } else {
        const relative = path.relative(path.join(root, "crates"), dep.path);
        assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
          `${pkg.name} depends on code outside Next: ${dep.name}`);
      }
    }
    if (dep.name.startsWith("rho-")) {
      if (["rho-host", "rho-mcp", "rho-workbench"].includes(pkg.name) && ["rho-plugin-protocol", "rho-plugins"].includes(dep.name) && dep.kind === "dev") continue;
      if (pkg.name === "rho-plugins" && dep.name === "rho-sqlite" && dep.kind === "dev") continue;
      if (pkg.name === "rho-agent-native" && dep.name === "rho-agent-store" && dep.kind === "dev") continue;
      assert.ok(allowed[pkg.name].includes(dep.name),
        `${pkg.name} -> ${dep.name} bypasses the declared ownership boundary`);
    }
  }
}
assert.equal(metadata.packages.length, Object.keys(allowed).length);
console.log("Root defaults to rho; production dependencies are directional and contain no legacy owner, handler bypass or runtime adapter in an edge.");
