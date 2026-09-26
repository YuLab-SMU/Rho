import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function assertAgentEngineBoundary(pkg) {
  for (const dep of pkg.dependencies) {
    assert.ok(!(dep.name === "rig" || dep.name.startsWith("rig-")) || pkg.name === "rho-agents",
      `${pkg.name} imports the component Agent engine outside rho-agents`);
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
const allowed = {
  "rho-plugin-protocol": [],
  "rho-plugin-sdk": ["rho-plugin-protocol"],
  "rho-plugins": ["rho-plugin-protocol", "rho-plugin-sdk", "rho-contract", "rho-operation"],
  "rho-r-backend": ["rho-plugin-sdk", "rho-r-api", "rho-r-engine"],
  "rho-r-api": ["rho-plugin-protocol"],
  "rho-r-engine": ["rho-r-api", "rho-plugin-protocol"],
  "rho-files-api": [],
  "rho-files-backend": ["rho-plugin-sdk", "rho-files-api", "rho-files-engine", "rho-files-owner"],
  "rho-editor-backend": ["rho-plugin-sdk"],
  "rho-files-owner": ["rho-files-api"],
  "rho-files-engine": ["rho-files-api", "rho-process-engine"],
  "rho-process-api": [],
  "rho-process-engine": ["rho-process-api"],
  "rho-process-owner": ["rho-process-api", "rho-process-engine", "rho-plugin-protocol"],
  "rho-contract": ["rho-plugin-protocol", "rho-r-api", "rho-files-api", "rho-process-api"],
  "rho-operation": ["rho-contract", "rho-plugin-protocol"],
  "rho-application": ["rho-contract"],
  "rho-agents": ["rho-application", "rho-contract"],
  "rho-skills": ["rho-contract", "rho-operation"],
  "rho-adapter-skills": ["rho-contract", "rho-operation", "rho-skills"],
  "rho-workspace": ["rho-contract", "rho-operation", "rho-r-api"],
  "rho-project": ["rho-contract", "rho-operation", "rho-files-api", "rho-files-owner"],
  "rho-environment": ["rho-contract", "rho-operation"],
  "rho-execution": ["rho-contract", "rho-operation"],
  "rho-process": ["rho-contract", "rho-operation", "rho-execution", "rho-process-engine", "rho-process-owner"],
  "rho-ssh": ["rho-contract", "rho-operation", "rho-execution", "rho-process"],
  "rho-r-environment": ["rho-environment", "rho-operation", "rho-process"],
  "rho-git": ["rho-files-engine"],
  "rho-sqlite": ["rho-contract", "rho-operation", "rho-application"],
  "rho-r-runtime": ["rho-contract", "rho-workspace", "rho-r-api", "rho-r-engine", "rho-plugin-protocol"],
  "rho-host": ["rho-plugin-protocol", "rho-plugins", "rho-agents", "rho-agent-client", "rho-contract", "rho-operation", "rho-application", "rho-skills", "rho-adapter-skills", "rho-sqlite", "rho-workspace", "rho-r-runtime", "rho-project", "rho-git", "rho-environment", "rho-r-environment", "rho-execution", "rho-process", "rho-ssh"],
  "rho-mcp": ["rho-contract", "rho-host"],
  "rho-agent-client": ["rho-contract"],
  "rho-workbench": ["rho-plugin-protocol", "rho-contract", "rho-host", "rho-mcp"],
  "rho-cli": ["rho-contract", "rho-host", "rho-mcp", "rho-workbench", "rho-plugin-protocol", "rho-plugins"],
};
const pluginLibraries = {
  "rho-r-api": "plugins/r/api", "rho-r-engine": "plugins/r/backend/engine",
  "rho-files-owner": "plugins/files/backend/owner",
  "rho-files-api": "plugins/files/api", "rho-files-engine": "plugins/files/backend/engine",
  "rho-process-api": "plugins/process/api", "rho-process-engine": "plugins/process/backend/engine", "rho-process-owner": "plugins/process/backend/owner",
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
      if (["rho-host", "rho-mcp"].includes(pkg.name) && ["rho-plugin-protocol", "rho-plugins"].includes(dep.name) && dep.kind === "dev") continue;
      if (pkg.name === "rho-plugins" && dep.name === "rho-sqlite" && dep.kind === "dev") continue;
      assert.ok(allowed[pkg.name].includes(dep.name),
        `${pkg.name} -> ${dep.name} bypasses the declared ownership boundary`);
    }
  }
}
assert.equal(metadata.packages.length, Object.keys(allowed).length);
console.log("Root defaults to rho; production dependencies are directional and contain no legacy owner, handler bypass or runtime adapter in an edge.");
