import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The filename is retained for compatibility with existing workflow and
// evidence links. This contract now enforces one rolling, pinned toolchain.
export const EXPECTED_TOOLCHAIN = "1.97.0";
export const EXPECTED_RUST_VERSION = "1.97";

const REQUIRED_MATRIX = new Set([
  "macos-26|1.97.0|1.97.0-aarch64-apple-darwin|aarch64-apple-darwin|source",
  "windows-latest|1.97.0|1.97.0-x86_64-pc-windows-gnu|x86_64-pc-windows-gnu|source",
  "ubuntu-22.04|1.97.0|1.97.0-x86_64-unknown-linux-gnu|x86_64-unknown-linux-gnu|source",
]);

const REQUIRED_CACHE_PATHS = [
  "~/.cargo/registry/index/",
  "~/.cargo/registry/cache/",
  "~/.cargo/git/db/",
  "target/",
];

const normalizeLineEndings = (text) => text.replace(/\r\n/g, "\n");

function fail(message) {
  throw new Error(message);
}

function section(text, heading) {
  const lines = normalizeLineEndings(text).split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${heading}]`);
  if (start < 0) fail(`Missing [${heading}] section`);
  const next = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  return lines.slice(start + 1, next < 0 ? lines.length : next).join("\n");
}

function stringField(sectionText, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sectionText.match(new RegExp(`^${escaped}\\s*=\\s*"([^"]+)"(?:\\s*#.*)?$`, "m"))?.[1] ?? null;
}

export function validateRootManifest(text) {
  const workspace = section(text, "workspace");
  const workspacePackage = section(text, "workspace.package");
  if (stringField(workspace, "resolver") !== "3") {
    fail('Rust toolchain contract requires [workspace] resolver = "3"');
  }
  if (stringField(workspacePackage, "rust-version") !== EXPECTED_RUST_VERSION) {
    fail(`Rust toolchain contract requires [workspace.package] rust-version = "${EXPECTED_RUST_VERSION}"`);
  }
}

export function validateToolchain(text) {
  const toolchain = section(text, "toolchain");
  if (stringField(toolchain, "channel") !== EXPECTED_TOOLCHAIN) {
    fail(`Rust toolchain contract requires channel = "${EXPECTED_TOOLCHAIN}"`);
  }
}

export function validateWorkspaceMetadata(metadata) {
  if (!Array.isArray(metadata?.workspace_members) || metadata.workspace_members.length === 0) {
    fail("Cargo metadata did not report any workspace members");
  }
  const packagesById = new Map((metadata.packages ?? []).map((pkg) => [pkg.id, pkg]));
  for (const memberId of metadata.workspace_members) {
    const pkg = packagesById.get(memberId);
    if (!pkg) fail(`Cargo metadata omitted workspace member ${memberId}`);
    if (pkg.rust_version !== EXPECTED_RUST_VERSION) {
      fail(`${pkg.name} must report rust-version ${EXPECTED_RUST_VERSION}, received ${pkg.rust_version ?? "undeclared"}`);
    }
  }
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function matrixIdentities(workflow) {
  const pattern = /^\s{10}- os:\s*(.+)\n\s{12}toolchain:\s*(.+)\n\s{12}rustup_toolchain:\s*(.+)\n\s{12}host:\s*(.+)\n\s{12}lane:\s*(.+)$/gm;
  return new Set(
    [...normalizeLineEndings(workflow).matchAll(pattern)]
      .map((match) => match.slice(1).map(unquote).join("|")),
  );
}

function validateCargoCache(workflow) {
  if (!workflow.includes("uses: actions/cache@v4")) {
    fail("Rust CI must use the reviewed official actions/cache major");
  }
  for (const cachePath of REQUIRED_CACHE_PATHS) {
    if (!workflow.includes(cachePath)) fail(`Rust CI cache is missing ${cachePath}`);
  }
  const cacheKey = "rho-rust-v1-${{ runner.os }}-${{ env.RUSTUP_TOOLCHAIN }}-${{ hashFiles('Cargo.lock') }}";
  if (!workflow.includes(cacheKey)) {
    fail("Rust CI cache key must isolate schema, OS, explicit toolchain, and Cargo.lock");
  }
  const restoreKey = "rho-rust-v1-${{ runner.os }}-${{ env.RUSTUP_TOOLCHAIN }}-";
  if (!workflow.includes(restoreKey)) {
    fail("Rust CI restore key must remain inside the same OS and toolchain");
  }
  if (!/^\s{6}CARGO_INCREMENTAL: "0"$/m.test(workflow)) {
    fail("Rust CI must disable incremental compilation for the shared build cache");
  }
}

function validateCompatibilityCargoCaches(workflow) {
  validateCargoCache(workflow);
  for (const marker of [
    "Restore non-Windows Cargo dependency and build cache",
    "if: runner.os != 'Windows'",
    "Restore Windows source build cache",
    "if: runner.os == 'Windows'",
    "target/debug/",
    "rho-rust-v3-${{ runner.os }}-${{ env.RUSTUP_TOOLCHAIN }}-source-${{ hashFiles('Cargo.lock') }}",
  ]) {
    if (!workflow.includes(marker)) fail(`Rust compatibility cache topology lost ${marker}`);
  }
  if (/Restore Windows installed build cache|target\/release\/|rho-rust-v\d+-.*-installed-/.test(workflow)) {
    fail("Ordinary Rust compatibility must not cache or build an installed-package lane");
  }
}

function requireCommonWorkflowContract(workflow, kind) {
  if (!/^permissions:\n  contents: read$/m.test(workflow)) {
    fail(`${kind} workflow must remain read-only`);
  }
  if (/contents:\s*write|secrets\.|upload-artifact|createRelease|notarytool|codesign|continue-on-error:/.test(workflow)) {
    fail(`${kind} workflow must not receive release, credential, upload, or allowed-failure authority`);
  }
  for (const command of [
    "node scripts/test-rust-msrv-contract.mjs",
    "node scripts/test-tauri-command-inventory.mjs --test",
    "node scripts/test-tauri-command-inventory.mjs",
    "npm --prefix desktop run rsr:check",
    "cargo fmt --all -- --check",
    "cargo check --workspace --all-targets --locked",
    "cargo test --workspace --locked --no-fail-fast",
  ]) {
    if (!workflow.includes(command)) fail(`${kind} workflow is missing: ${command}`);
  }
  if (/cargo (?:check|test)[^\n]*--ignore-rust-version/.test(workflow)) {
    fail(`${kind} workflow must not ignore rust-version metadata`);
  }
}

export function validateCompatibilityWorkflow(text) {
  const workflow = normalizeLineEndings(text);
  if (!/^name: Rust Compatibility$/m.test(workflow)) fail("Missing Rust Compatibility workflow name");
  if (!/^on:\n  push:\n    branches: \[main\]/m.test(workflow)) fail("Rust compatibility push trigger must target main");
  if (!/^  pull_request:\n    branches: \[main\]/m.test(workflow)) fail("Rust compatibility pull_request trigger must target main");
  if (!/^  workflow_dispatch:$/m.test(workflow)) fail("Rust compatibility must support exact-head manual dispatch");
  if (!/^    types: \[opened, reopened, synchronize, ready_for_review\]$/m.test(workflow)) {
    fail("Rust compatibility must run at the Ready transition and later non-Draft updates");
  }
  if (!/group: rust-compatibility-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/.test(workflow)
      || !/cancel-in-progress: true/.test(workflow)) {
    fail("Rust compatibility must cancel obsolete runs for the same ref");
  }
  if (!/fail-fast: false/.test(workflow)) fail("Pinned source platform failures must remain independently visible");
  assert.deepEqual(matrixIdentities(workflow), REQUIRED_MATRIX, "Rust compatibility matrix identities changed");
  if (/\b1\.88(?:\.0)?\b|toolchain:\s*["']?stable|rustup_toolchain:\s*stable-|lane:\s*installed/.test(workflow)) {
    fail("Rust compatibility reintroduced a legacy, floating, or installed-package leg");
  }
  if (!/^\s{6}RUSTUP_TOOLCHAIN: \$\{\{ matrix\.rustup_toolchain \}\}$/m.test(workflow)) {
    fail("Every matrix leg must explicitly select its exact toolchain");
  }
  if ((workflow.match(/1\.97\.0/g) ?? []).length < 10) {
    fail("Rust compatibility must declare and verify exact Rust 1.97.0 across all source legs");
  }
  if (!/- name: Enforce pinned-toolchain formatting\n        if: runner\.os == 'Linux'/.test(workflow)
      || !/- name: Verify source, generated frontend, licenses and release contracts\n        if: runner\.os == 'Linux'/.test(workflow)) {
    fail("Platform-independent source contracts must run once on Linux");
  }
  if (/Build, install, smoke|Build, mount and smoke|Build, extract and smoke|tauri-apps\/cli@[^\n]+ build/.test(workflow)) {
    fail("Ordinary Rust compatibility must not construct or install application packages");
  }
  requireCommonWorkflowContract(workflow, "Rust compatibility");
  validateCompatibilityCargoCaches(workflow);
}

export function validateFastWorkflow(text) {
  const workflow = normalizeLineEndings(text);
  if (!/^name: Rust Fast$/m.test(workflow)) fail("Missing Rust Fast workflow name");
  if (!/^on:\n  pull_request:\n    branches: \[main\]/m.test(workflow)) fail("Rust Fast must target pull requests to main");
  if (!/^    types: \[opened, reopened, synchronize\]$/m.test(workflow)) {
    fail("Rust Fast must cover Draft open, reopen, and synchronize feedback");
  }
  if (!/^    if: github\.event\.pull_request\.draft == true$/m.test(workflow)) {
    fail("Rust Fast must admit Draft PRs only");
  }
  if (!/^    runs-on: ubuntu-22\.04$/m.test(workflow)
      || !/^\s{6}RUSTUP_TOOLCHAIN: 1\.97\.0-x86_64-unknown-linux-gnu$/m.test(workflow)
      || !/test "\$\(rustc -V \| awk '\{print \$2\}'\)" = "1\.97\.0"/.test(workflow)) {
    fail("Rust Fast must select and verify the exact pinned Ubuntu toolchain");
  }
  if (/\b1\.88(?:\.0)?\b|stable-x86_64-unknown-linux-gnu/.test(workflow)) {
    fail("Rust Fast reintroduced a legacy or floating compiler");
  }
  if (/strategy:\s*\n\s*matrix:/.test(workflow)) fail("Rust Fast must remain one bounded job");
  requireCommonWorkflowContract(workflow, "Rust Fast");
  validateCargoCache(workflow);
}

function fixtureMetadata(rustVersions = [EXPECTED_RUST_VERSION, EXPECTED_RUST_VERSION]) {
  return {
    workspace_members: ["rho-a", "rho-b"],
    packages: [
      { id: "rho-a", name: "rho-a", rust_version: rustVersions[0] },
      { id: "rho-b", name: "rho-b", rust_version: rustVersions[1] },
    ],
  };
}

function runSelfTests() {
  const root = `[workspace]\nresolver = "3"\n\n[workspace.package]\nrust-version = "1.97"\n`;
  validateRootManifest(root);
  assert.throws(() => validateRootManifest(root.replace('resolver = "3"', 'resolver = "2"')), /resolver/);
  assert.throws(() => validateRootManifest(root.replace('rust-version = "1.97"', 'rust-version = "1.88"')), /rust-version/);

  const toolchain = `[toolchain]\nchannel = "1.97.0"\nprofile = "default"\n`;
  validateToolchain(toolchain);
  assert.throws(() => validateToolchain(toolchain.replace("1.97.0", "stable")), /channel/);
  assert.throws(() => validateToolchain(toolchain.replace("1.97.0", "1.98.0")), /channel/);

  validateWorkspaceMetadata(fixtureMetadata());
  assert.throws(() => validateWorkspaceMetadata(fixtureMetadata([null, EXPECTED_RUST_VERSION])), /undeclared/);
  assert.throws(() => validateWorkspaceMetadata(fixtureMetadata(["1.88", EXPECTED_RUST_VERSION])), /1\.88/);
  const missingPackage = fixtureMetadata();
  missingPackage.packages.pop();
  assert.throws(() => validateWorkspaceMetadata(missingPackage), /omitted workspace member/);

  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const compatibility = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/rust-compatibility.yml"), "utf8");
  validateCompatibilityWorkflow(compatibility);
  assert.throws(
    () => validateCompatibilityWorkflow(compatibility.replace("1.97.0-aarch64-apple-darwin", "1.88.0-aarch64-apple-darwin")),
    /matrix identities|legacy/,
  );
  assert.throws(
    () => validateCompatibilityWorkflow(compatibility.replace("cargo check --workspace --all-targets --locked", "cargo check --workspace --all-targets")),
    /missing/,
  );

  const fast = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/rust-fast.yml"), "utf8");
  validateFastWorkflow(fast);
  assert.throws(() => validateFastWorkflow(fast.replace("1.97.0-x86_64-unknown-linux-gnu", "stable-x86_64-unknown-linux-gnu")), /exact pinned|floating/);
  assert.throws(() => validateFastWorkflow(fast.replace("contents: read", "contents: write")), /read-only/);
}

function validateRepository(repositoryRoot) {
  const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  validateRootManifest(read("Cargo.toml"));
  validateToolchain(read("rust-toolchain.toml"));
  const metadata = JSON.parse(execFileSync(
    "cargo",
    ["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  validateWorkspaceMetadata(metadata);
  validateCompatibilityWorkflow(read(".github/workflows/rust-compatibility.yml"));
  validateFastWorkflow(read(".github/workflows/rust-fast.yml"));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--test")) runSelfTests();
  else validateRepository(process.cwd());
  console.log("Rust pinned-toolchain contract tests passed");
}
