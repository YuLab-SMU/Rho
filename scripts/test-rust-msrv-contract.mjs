import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_MSRV = "1.88";

const REQUIRED_MATRIX = new Set([
  "macos-26|stable|stable-aarch64-apple-darwin|aarch64-apple-darwin",
  "macos-26|1.88.0|1.88.0-aarch64-apple-darwin|aarch64-apple-darwin",
  "windows-latest|stable|stable-x86_64-pc-windows-gnu|x86_64-pc-windows-gnu",
  "windows-latest|1.88.0|1.88.0-x86_64-pc-windows-gnu|x86_64-pc-windows-gnu",
  "ubuntu-22.04|stable|stable-x86_64-unknown-linux-gnu|x86_64-unknown-linux-gnu",
  "ubuntu-22.04|1.88.0|1.88.0-x86_64-unknown-linux-gnu|x86_64-unknown-linux-gnu",
]);

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
    fail('Rust MSRV contract requires [workspace] resolver = "3"');
  }
  if (stringField(workspacePackage, "rust-version") !== EXPECTED_MSRV) {
    fail(`Rust MSRV contract requires [workspace.package] rust-version = "${EXPECTED_MSRV}"`);
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
    if (pkg.rust_version !== EXPECTED_MSRV) {
      fail(`${pkg.name} must report rust-version ${EXPECTED_MSRV}, received ${pkg.rust_version ?? "undeclared"}`);
    }
  }
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function matrixIdentities(workflow) {
  const normalized = normalizeLineEndings(workflow);
  const pattern = /^\s{10}- os:\s*(.+)\n\s{12}toolchain:\s*(.+)\n\s{12}rustup_toolchain:\s*(.+)\n\s{12}host:\s*(.+)$/gm;
  return new Set(
    [...normalized.matchAll(pattern)].map((match) => match.slice(1).map(unquote).join("|")),
  );
}

export function validateCompatibilityWorkflow(text) {
  const workflow = normalizeLineEndings(text);
  if (!/^name: Rust Compatibility$/m.test(workflow)) fail("Missing Rust Compatibility workflow name");
  if (!/^on:\n  push:\n    branches: \[main\]/m.test(workflow)) fail("Rust compatibility push trigger must target main");
  if (!/^  pull_request:\n    branches: \[main\]/m.test(workflow)) fail("Rust compatibility pull_request trigger must target main");
  if (!/^permissions:\n  contents: read$/m.test(workflow)) fail("Rust compatibility workflow must be read-only");
  for (const requiredPath of [
    '"**/Cargo.toml"',
    '"Cargo.lock"',
    '"rust-toolchain.toml"',
    '".cargo/**"',
    '"crates/**/*.rs"',
    '"desktop/src-tauri/**"',
    '"vendor/jet/**/*.rs"',
    '"runtime/ark.json"',
    '"scripts/bootstrap-ark-macos.sh"',
    '".github/workflows/rust-compatibility.yml"',
    '".github/workflows/candidate-build-draft.yml"',
    '"scripts/test-rust-msrv-contract.mjs"',
  ]) {
    const occurrences = workflow.split(requiredPath).length - 1;
    if (occurrences !== 2) fail(`Both Rust compatibility triggers must include ${requiredPath}`);
  }
  if (/contents:\s*write|secrets\.|upload-artifact|createRelease|tauri\s+build|notarytool|codesign/.test(workflow)) {
    fail("Rust compatibility workflow must not receive release, credential, packaging, or write authority");
  }
  if (!/fail-fast: false/.test(workflow) || /continue-on-error:/.test(workflow)) {
    fail("All Rust compatibility legs must remain required and independently visible");
  }
  const actualMatrix = matrixIdentities(workflow);
  assert.deepEqual(actualMatrix, REQUIRED_MATRIX, "Rust compatibility matrix identities changed");
  if (!/^      RUSTUP_TOOLCHAIN: \$\{\{ matrix\.rustup_toolchain \}\}$/m.test(workflow)) {
    fail("Every matrix leg must explicitly override rust-toolchain.toml through RUSTUP_TOOLCHAIN");
  }
  for (const command of [
    "node scripts/test-rust-msrv-contract.mjs",
    "cargo check --workspace --all-targets --locked",
    "cargo test --workspace --locked --no-fail-fast",
  ]) {
    if (!workflow.includes(command)) fail(`Rust compatibility workflow is missing: ${command}`);
  }
  if (!/if: matrix\.toolchain == 'stable'[\s\S]*cargo fmt --all -- --check/.test(workflow)) {
    fail("Only stable compatibility legs may enforce rustfmt");
  }
  if (!/RHO_RTOOLS_BIN=C:\\rtools45\\x86_64-w64-mingw32\.static\.posix\\bin/.test(workflow)) {
    fail("Windows compatibility legs must select the documented Rtools45 GNU path");
  }
  if (!/if: runner\.os == 'macOS'[\s\S]*run: \.\/scripts\/bootstrap-ark-macos\.sh/.test(workflow)) {
    fail("macOS compatibility legs must stage the checksum-pinned Ark sidecar required by Tauri");
  }
}

function workflowJob(workflow, jobName) {
  const lines = normalizeLineEndings(workflow).split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:\s*$/.test(line));
  return lines.slice(start, next < 0 ? lines.length : next).join("\n");
}

export function validateCandidateWorkflow(text) {
  const workflow = normalizeLineEndings(text);
  const lockedTests = workflow.match(/cargo test --workspace --locked --no-fail-fast/g) ?? [];
  if (lockedTests.length !== 3) {
    fail(`Windows, macOS, and Linux candidate validation must each use locked workspace tests; found ${lockedTests.length}`);
  }
  if (/cargo test --workspace --no-fail-fast/.test(workflow)) {
    fail("Candidate validation contains an unlocked workspace test command");
  }
  const macJob = workflowJob(workflow, "macos-submit");
  if (!macJob) fail("Candidate workflow is missing the macos-submit job");
  if (!/export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin/.test(macJob)
      || !/echo "RUSTUP_TOOLCHAIN=\$RUSTUP_TOOLCHAIN" >> "\$GITHUB_ENV"/.test(macJob)) {
    fail("macOS candidate validation must explicitly select stable above rust-toolchain.toml");
  }
  if (/rustup default stable-aarch64-apple-darwin/.test(macJob)) {
    fail("Changing the rustup default is not an explicit macOS candidate override");
  }
}

function fixtureMetadata(rustVersions = [EXPECTED_MSRV, EXPECTED_MSRV]) {
  return {
    workspace_members: ["rho-a 0.1.0 (path+file:///rho-a)", "rho-b 0.1.0 (path+file:///rho-b)"],
    packages: [
      { id: "rho-a 0.1.0 (path+file:///rho-a)", name: "rho-a", rust_version: rustVersions[0] },
      { id: "rho-b 0.1.0 (path+file:///rho-b)", name: "rho-b", rust_version: rustVersions[1] },
    ],
  };
}

function fixtureWorkflow() {
  const entries = [...REQUIRED_MATRIX]
    .map((identity) => {
      const [os, toolchain, rustupToolchain, host] = identity.split("|");
      return `          - os: ${os}\n            toolchain: "${toolchain}"\n            rustup_toolchain: ${rustupToolchain}\n            host: ${host}`;
    })
    .join("\n");
  return `name: Rust Compatibility
on:
  push:
    branches: [main]
    paths:
      - "**/Cargo.toml"
      - "Cargo.lock"
      - "rust-toolchain.toml"
      - ".cargo/**"
      - "crates/**/*.rs"
      - "desktop/src-tauri/**"
      - "vendor/jet/**/*.rs"
      - "runtime/ark.json"
      - "scripts/bootstrap-ark-macos.sh"
      - ".github/workflows/rust-compatibility.yml"
      - ".github/workflows/candidate-build-draft.yml"
      - "scripts/test-rust-msrv-contract.mjs"
  pull_request:
    branches: [main]
    paths:
      - "**/Cargo.toml"
      - "Cargo.lock"
      - "rust-toolchain.toml"
      - ".cargo/**"
      - "crates/**/*.rs"
      - "desktop/src-tauri/**"
      - "vendor/jet/**/*.rs"
      - "runtime/ark.json"
      - "scripts/bootstrap-ark-macos.sh"
      - ".github/workflows/rust-compatibility.yml"
      - ".github/workflows/candidate-build-draft.yml"
      - "scripts/test-rust-msrv-contract.mjs"
permissions:
  contents: read
jobs:
  rust-compatibility:
    strategy:
      fail-fast: false
      matrix:
        include:
${entries}
    env:
      RUSTUP_TOOLCHAIN: \${{ matrix.rustup_toolchain }}
    steps:
      - if: runner.os == 'Windows'
        run: echo "RHO_RTOOLS_BIN=C:\\rtools45\\x86_64-w64-mingw32.static.posix\\bin"
      - if: runner.os == 'macOS'
        run: ./scripts/bootstrap-ark-macos.sh
      - if: matrix.toolchain == 'stable'
        run: cargo fmt --all -- --check
      - run: |
          node scripts/test-rust-msrv-contract.mjs
          cargo check --workspace --all-targets --locked
          cargo test --workspace --locked --no-fail-fast
`;
}

function runSelfTests() {
  const root = `[workspace]\nresolver = "3"\n\n[workspace.package]\nrust-version = "1.88"\n`;
  validateRootManifest(root);
  assert.throws(() => validateRootManifest(root.replace('resolver = "3"', 'resolver = "2"')), /resolver/);
  assert.throws(() => validateRootManifest(root.replace('rust-version = "1.88"', 'rust-version = "1.89"')), /rust-version/);

  validateWorkspaceMetadata(fixtureMetadata());
  assert.throws(() => validateWorkspaceMetadata(fixtureMetadata([null, EXPECTED_MSRV])), /undeclared/);
  assert.throws(() => validateWorkspaceMetadata(fixtureMetadata(["1.89", EXPECTED_MSRV])), /1\.89/);
  const missingPackage = fixtureMetadata();
  missingPackage.packages.pop();
  assert.throws(() => validateWorkspaceMetadata(missingPackage), /omitted workspace member/);

  const workflow = fixtureWorkflow();
  validateCompatibilityWorkflow(workflow);
  const oneIdentity = [...REQUIRED_MATRIX][0];
  const [os, toolchain, rustupToolchain, host] = oneIdentity.split("|");
  const row = `          - os: ${os}\n            toolchain: "${toolchain}"\n            rustup_toolchain: ${rustupToolchain}\n            host: ${host}\n`;
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace(row, "")), /matrix identities/);
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace("RUSTUP_TOOLCHAIN:", "SELECTED_TOOLCHAIN:")), /explicitly override/);
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace(" --locked", "")), /missing:/);

  const candidates = `jobs:
  windows-candidate:
    run: cargo test --workspace --locked --no-fail-fast
  macos-submit:
    run: |
      export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
      echo "RUSTUP_TOOLCHAIN=$RUSTUP_TOOLCHAIN" >> "$GITHUB_ENV"
      cargo test --workspace --locked --no-fail-fast
  macos-notary-wait:
    run: true
`;
  validateCandidateWorkflow(candidates);
  assert.throws(() => validateCandidateWorkflow(candidates.replace(" --locked", "")), /locked workspace tests/);
  assert.throws(() => validateCandidateWorkflow(candidates.replace("export RUSTUP_TOOLCHAIN", "export SELECTED_TOOLCHAIN")), /explicitly select stable/);
}

function validateRepository(repositoryRoot) {
  const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  validateRootManifest(read("Cargo.toml"));
  const metadata = JSON.parse(execFileSync(
    "cargo",
    ["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  validateWorkspaceMetadata(metadata);
  validateCompatibilityWorkflow(read(".github/workflows/rust-compatibility.yml"));
  validateCandidateWorkflow(read(".github/workflows/candidate-build-draft.yml"));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--test")) {
    runSelfTests();
  } else {
    validateRepository(process.cwd());
  }
  console.log("Rust MSRV contract tests passed");
}
