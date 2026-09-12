#!/usr/bin/env node
// Explicit operator acquisition of the native recovery component for one R.
//
// The Host only ever loads a component that is already installed: opening a recovery
// catalog or capturing a copy never invokes a compiler. This script is how an operator
// puts one where a launched Workbench looks for it —
// <ark directory>/recovery-components/<r_version>-<platform>/ — which is the path
// prepared_checkpoint_helper() discovers, and the layout verify_checkpoint_helper()
// validates (matching r_home, matching library path, matching sha256, bounded size).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
const USAGE = `Usage: node scripts/bootstrap-recovery-component.mjs --ark /absolute/path/to/ark [--r /absolute/path/to/R]

Builds the private native recovery component for one explicitly selected R and
installs it beside Ark, where a launched Workbench discovers it. R is selected with
--r or RHO_CHECKPOINT_R and defaults to the R on PATH. Nothing is installed for an R
you did not name, and no R package is installed at all.`;

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const FLAGS = ["--ark", "--r", "--help", "-h"];
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!FLAGS.includes(argument)) fail(`Unknown argument: ${argument}\n\n${USAGE}`);
  if (argument === "--ark" || argument === "--r") {
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) fail(`${argument} requires a path.\n\n${USAGE}`);
    index += 1;
  }
}
const ark = flag("--ark") ?? process.env.RHO_ARK;
if (!ark) fail(`--ark is required.\n\n${USAGE}`);
const arkPath = resolve(ark);
if (!statSync(arkPath, { throwIfNoEntry: false })?.isFile()) {
  fail(`Ark is not a file: ${arkPath}`);
}
const selectedR = flag("--r") ?? process.env.RHO_CHECKPOINT_R;

// Reuse the reviewed build path rather than duplicating R CMD SHLIB here.
const built = spawnSync("node", ["scripts/test-r-checkpoints.mjs", "--print-library"], {
  cwd: root,
  encoding: "utf8",
  env: selectedR ? { ...process.env, RHO_CHECKPOINT_R: selectedR } : process.env,
});
if (built.status !== 0) {
  process.stderr.write(built.stderr ?? "");
  fail(`Building the recovery component failed for ${selectedR ?? "the R on PATH"}`);
}
const builtLibrary = built.stdout.trim();
const source = JSON.parse(readFileSync(join(dirname(builtLibrary), "manifest.json"), "utf8"));

const destination = join(dirname(arkPath), "recovery-components", `${source.r_version}-${source.platform}`);
mkdirSync(destination, { recursive: true });
const library = join(destination, `rho_checkpoint${source.extension}`);
// Publish last-to-first: the Host acts on manifest.json, so a partially copied
// component is never loadable, and a failed copy leaves the previous one intact.
const stagingLibrary = `${library}.partial-${process.pid}`;
const stagingManifest = join(destination, `manifest.json.partial-${process.pid}`);
try {
  copyFileSync(builtLibrary, stagingLibrary);
  const sha256 = `sha256:${createHash("sha256").update(readFileSync(stagingLibrary)).digest("hex")}`;
  if (sha256 !== source.sha256) fail(`Installed bytes do not match the built component: ${sha256}`);
  // The manifest must name the installed location; the verifier compares it to the
  // path it was handed and rejects a component belonging to another installation.
  writeFileSync(stagingManifest, `${JSON.stringify({ ...source, library, sha256 }, null, 2)}\n`);
  renameSync(stagingLibrary, library);
  renameSync(stagingManifest, join(destination, "manifest.json"));
} finally {
  rmSync(stagingLibrary, { force: true });
  rmSync(stagingManifest, { force: true });
}
process.stdout.write(`Installed native recovery component: ${library}\n`);
process.stdout.write(`R ${source.r_version} (${source.platform}) at ${source.r_home}\n`);
process.stdout.write("A Workbench started with this Ark can now write recovery copies for that R.\n");
