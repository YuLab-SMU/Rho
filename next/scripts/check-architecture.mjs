import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--manifest-path", path.join(root, "..", "Cargo.toml"),
  "--format-version", "1", "--no-deps", "--offline",
], { encoding: "utf8" }));
assert.equal(path.resolve(metadata.workspace_root), path.resolve(root, ".."),
  "The repository root must be the single production workspace");
const cli = metadata.packages.find(pkg => pkg.name === "rho-next-cli");
assert.ok(cli, "production CLI is missing");
assert.deepEqual(metadata.workspace_default_members, [cli.id]);
assert.deepEqual(cli.targets.filter(target => target.kind.includes("bin")).map(target => target.name), ["rho"]);
const allowed = {
  "rho-next-contract": [],
  "rho-next-operation": ["rho-next-contract"],
  "rho-next-workspace": ["rho-next-contract", "rho-next-operation"],
  "rho-next-project": ["rho-next-contract", "rho-next-operation"],
  "rho-next-environment": ["rho-next-contract", "rho-next-operation"],
  "rho-next-execution": ["rho-next-contract", "rho-next-operation"],
  "rho-next-process": ["rho-next-contract", "rho-next-operation", "rho-next-execution"],
  "rho-next-ssh": ["rho-next-contract", "rho-next-operation", "rho-next-execution", "rho-next-process"],
  "rho-next-r-environment": ["rho-next-environment", "rho-next-operation", "rho-next-process"],
  "rho-next-git": ["rho-next-project", "rho-next-process"],
  "rho-next-sqlite": ["rho-next-contract", "rho-next-operation"],
  "rho-next-r-runtime": ["rho-next-contract", "rho-next-workspace"],
  "rho-next-host": ["rho-next-contract", "rho-next-operation", "rho-next-sqlite", "rho-next-workspace", "rho-next-r-runtime", "rho-next-project", "rho-next-git", "rho-next-environment", "rho-next-r-environment", "rho-next-execution", "rho-next-process", "rho-next-ssh"],
  "rho-next-mcp": ["rho-next-contract", "rho-next-host"],
  "rho-next-workbench": ["rho-next-contract", "rho-next-host", "rho-next-mcp"],
  "rho-next-cli": ["rho-next-contract", "rho-next-host", "rho-next-mcp", "rho-next-workbench"],
};
for (const pkg of metadata.packages) {
  assert.ok(Object.hasOwn(allowed, pkg.name), `Unclassified production owner: ${pkg.name}`);
  for (const dep of pkg.dependencies) {
    if (dep.path) {
      if (pkg.name === "rho-next-r-runtime" && dep.name === "jet_core") {
        assert.equal(path.resolve(dep.path), path.resolve(root, "../vendor/jet/crates/core"));
        continue;
      }
      const relative = path.relative(root, dep.path);
      assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `${pkg.name} depends on code outside Next: ${dep.name}`);
    }
    if (dep.name.startsWith("rho-")) {
      assert.ok(allowed[pkg.name].includes(dep.name),
        `${pkg.name} -> ${dep.name} bypasses the declared ownership boundary`);
    }
  }
}
assert.equal(metadata.packages.length, Object.keys(allowed).length);
console.log("Root defaults to rho; production dependencies are directional and contain no legacy owner, handler bypass or runtime adapter in an edge.");
