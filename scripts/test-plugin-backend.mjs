import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rho-external-backend-"));
try {
  // Both public crates are copied, with no private workspace manifests, core
  // source, Studio singleton, or scientific implementation available to them.
  for (const name of ["plugin-protocol", "plugin-sdk"]) {
    fs.cpSync(path.join(root, "crates", name), path.join(temp, name), { recursive: true });
  }
  fs.writeFileSync(path.join(temp, "Cargo.toml"), '[workspace]\nresolver = "3"\nmembers = ["plugin-protocol", "plugin-sdk"]\n');
  // Retain the existing dependency lock, without network resolution/upgrades.
  fs.copyFileSync(path.join(root, "Cargo.lock"), path.join(temp, "Cargo.lock"));
  execFileSync("cargo", ["check", "--manifest-path", path.join(temp, "Cargo.toml"),
    "-p", "rho-plugin-sdk", "--example", "echo-backend", "--offline",
    "--target-dir", path.join(root, "target")], { stdio: "inherit" });
  console.log("External Rust backend compiles with only the public protocol and SDK.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
