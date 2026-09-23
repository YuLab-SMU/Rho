import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Select executables already installed for this repository before changing cwd.
// A disposable checkout must not silently select the machine's older default,
// and this check never asks rustup to install a toolchain.
const installed = name => fs.realpathSync(execFileSync("rustup", ["which", name], {
  cwd: root, encoding: "utf8"
}).trim());
const cargo = installed("cargo");
const env = { ...process.env, RUSTC: installed("rustc"), RUSTDOC: installed("rustdoc") };
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rho-independent-r-engine-")));
try {
  // Materialize a standalone developer tree. Only public contracts, the R owner
  // and its pinned third-party transport are available; there is no core source.
  for (const [from, to] of [["crates/plugin-protocol", "plugin-protocol"],
    ["plugins/r/api", "api"], ["plugins/r/backend/engine", "engine"],
    ["vendor/jet-core", "vendor/jet-core"]]) {
    fs.cpSync(path.join(root, from), path.join(temp, to), { recursive: true });
  }
  const rewrite = (name, changes) => {
    const file = path.join(temp, name, "Cargo.toml");
    let text = fs.readFileSync(file, "utf8");
    for (const [from, to] of changes) {
      assert.ok(text.includes(from), `${name} dependency layout changed: ${from}`);
      text = text.replace(from, to);
    }
    fs.writeFileSync(file, text);
  };
  rewrite("api", [["../../../crates/plugin-protocol", "../plugin-protocol"]]);
  rewrite("engine", [["../../../../crates/plugin-protocol", "../plugin-protocol"],
    ["../../api", "../api"], ["../../../../vendor/jet-core", "../vendor/jet-core"]]);
  fs.writeFileSync(path.join(temp, "Cargo.toml"), '[workspace]\nresolver = "3"\nmembers = ["plugin-protocol", "api", "engine"]\nexclude = ["vendor/jet-core"]\n');
  fs.copyFileSync(path.join(root, "Cargo.lock"), path.join(temp, "Cargo.lock"));
  const metadata = JSON.parse(execFileSync(cargo, ["metadata", "--no-deps", "--offline",
    "--format-version", "1"], { cwd: temp, env, encoding: "utf8" }));
  assert.deepEqual(metadata.packages.map(p => p.name).sort(), ["rho-plugin-protocol", "rho-r-api", "rho-r-engine"]);
  for (const pkg of metadata.packages) for (const dep of pkg.dependencies) if (dep.path) {
    assert.ok(dep.path.startsWith(temp + path.sep), `${pkg.name} has an external source dependency`);
  }
  execFileSync(cargo, ["test", "-p", "rho-r-engine", "--lib", "--offline",
    "--target-dir", path.join(root, "target")], { cwd: temp, env, stdio: "inherit" });
  if (process.argv.includes("--real-r")) {
    assert.ok(process.env.RHO_ARK && process.env.RHO_R_HOME, "Set RHO_ARK and RHO_R_HOME for the explicit real-R check");
    execFileSync(cargo, ["test", "-p", "rho-r-engine", "--test", "real_r", "--offline",
      "--target-dir", path.join(root, "target"), "--", "--ignored", "--nocapture"], { cwd: temp, env, stdio: "inherit" });
  }
  console.log("Independent R engine tests passed using public contracts and pinned Jet, without core source.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
