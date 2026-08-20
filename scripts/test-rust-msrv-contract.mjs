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

const REQUIRED_CACHE_PATHS = [
  "~/.cargo/registry/index/",
  "~/.cargo/registry/cache/",
  "~/.cargo/git/db/",
  "target/",
];

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
  if (!/^      CARGO_INCREMENTAL: "0"$/m.test(workflow)) {
    fail("Rust CI must disable incremental compilation for the shared build cache");
  }
}

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
  if (!/^    types: \[opened, reopened, synchronize, ready_for_review\]$/m.test(workflow)) {
    fail("Rust compatibility must run at the Ready transition and later non-Draft updates");
  }
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
    '".github/workflows/rust-fast.yml"',
    '".github/workflows/candidate-build-draft.yml"',
    '"scripts/test-rust-msrv-contract.mjs"',
    '"scripts/test-tauri-command-inventory.mjs"',
    '"scripts/test-extension-run-history-contract.mjs"',
    '"scripts/test-extension-p1-3-contract.mjs"',
    '"scripts/test-extension-phase-1-acceptance.mjs"',
    '"scripts/test-extension-phase-2-host-contract.mjs"',
    '"desktop/dist/app.js"',
    '"desktop/dist/index.html"',
    '"desktop/package.json"',
    '"desktop/package-lock.json"',
    '"NEWS.md"',
    '"r/rho.agent/R/aisdk_adapter.R"',
  ]) {
    const occurrences = workflow.split(requiredPath).length - 1;
    if (occurrences !== 2) fail(`Both Rust compatibility triggers must include ${requiredPath}`);
  }
  if (/contents:\s*write|secrets\.|upload-artifact|createRelease|notarytool|codesign/.test(workflow)) {
    fail("Rust compatibility workflow must not receive release, credential, signing, upload, or write authority");
  }
  if (!/fail-fast: false/.test(workflow) || /continue-on-error:/.test(workflow)) {
    fail("All Rust compatibility legs must remain required and independently visible");
  }
  if (!/^    if: github\.event_name == 'push' \|\| github\.event\.pull_request\.draft == false$/m.test(workflow)) {
    fail("Rust compatibility matrix must be gated to main pushes and non-Draft PRs");
  }
  if (!/group: rust-compatibility-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/.test(workflow)
      || !/cancel-in-progress: true/.test(workflow)) {
    fail("Rust compatibility must cancel obsolete runs for the same ref");
  }
  const actualMatrix = matrixIdentities(workflow);
  assert.deepEqual(actualMatrix, REQUIRED_MATRIX, "Rust compatibility matrix identities changed");
  if (!/^      RUSTUP_TOOLCHAIN: \$\{\{ matrix\.rustup_toolchain \}\}$/m.test(workflow)) {
    fail("Every matrix leg must explicitly override rust-toolchain.toml through RUSTUP_TOOLCHAIN");
  }
  for (const command of [
    "node scripts/test-rust-msrv-contract.mjs",
    "node scripts/test-tauri-command-inventory.mjs --test",
    "node scripts/test-tauri-command-inventory.mjs",
    "node scripts/test-extension-phase-1-acceptance.mjs --test",
    "node scripts/test-extension-phase-1-acceptance.mjs",
    "node scripts/test-extension-phase-2-host-contract.mjs --test",
    "node scripts/test-extension-phase-2-host-contract.mjs",
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
  if (!/timeout-minutes: 90/.test(workflow)) {
    fail("Rust compatibility must reserve enough time for stable-leg installed-app acceptance");
  }
  for (const marker of [
    "Build, install, smoke and remove unsigned Windows app",
    "Build, mount and smoke unsigned macOS app",
    "Build, extract and smoke unsigned Linux AppImage",
    "./scripts/build-windows-installer.ps1",
    "scripts/build-linux.sh",
    "RHO_INTERNAL_EXTENSION_RUNTIME=legacy",
    "env -u RHO_INTERNAL_EXTENSION_RUNTIME",
  ]) {
    if (!workflow.includes(marker)) fail(`Rust compatibility installed-app gate is missing: ${marker}`);
  }
  if ((workflow.match(/if: matrix\.toolchain == 'stable' && runner\.os ==/g) ?? []).length < 3) {
    fail("Each installed-app acceptance leg must run only on stable Rust");
  }
  if (!/Rho uninstall registry cleanup failed/.test(workflow)
      || !/hdiutil detach/.test(workflow)
      || !/rm -rf -- "\$key_dir" "\$extract_dir"/.test(workflow)) {
    fail("Installed-app acceptance must prove Windows, macOS, and Linux cleanup");
  }
  validateCargoCache(workflow);
}

export function validateFastWorkflow(text) {
  const workflow = normalizeLineEndings(text);
  if (!/^name: Rust Fast$/m.test(workflow)) fail("Missing Rust Fast workflow name");
  if (!/^on:\n  pull_request:\n    branches: \[main\]/m.test(workflow)) {
    fail("Rust Fast must run only for pull requests targeting main");
  }
  if (!/^    types: \[opened, reopened, synchronize\]$/m.test(workflow)) {
    fail("Rust Fast must cover Draft open, reopen, and synchronize feedback");
  }
  if (/^  push:/m.test(workflow)) fail("Rust Fast must not duplicate the main-push matrix");
  if (!/^permissions:\n  contents: read$/m.test(workflow)) {
    fail("Rust Fast must remain read-only");
  }
  if (!/group: rust-fast-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/.test(workflow)
      || !/cancel-in-progress: true/.test(workflow)) {
    fail("Rust Fast must cancel obsolete runs for the same PR");
  }
  if (!/^    if: github\.event\.pull_request\.draft == true$/m.test(workflow)) {
    fail("Rust Fast must admit Draft PRs only and avoid duplicating the Ready matrix");
  }
  if (!/^    runs-on: ubuntu-22\.04$/m.test(workflow)
      || !/^      RUSTUP_TOOLCHAIN: stable-x86_64-unknown-linux-gnu$/m.test(workflow)
      || !/host: x86_64-unknown-linux-gnu/.test(workflow)) {
    fail("Rust Fast must use explicitly selected Ubuntu current stable");
  }
  if (/strategy:\s*\n\s*matrix:/.test(workflow)) {
    fail("Rust Fast must remain a single job, not a matrix");
  }
  for (const requiredPath of [
    '"**/Cargo.toml"',
    '"Cargo.lock"',
    '"rust-toolchain.toml"',
    '".cargo/**"',
    '"crates/**/*.rs"',
    '"desktop/src-tauri/**"',
    '"vendor/jet/**/*.rs"',
    '"runtime/ark.json"',
    '"scripts/bootstrap-ark-linux.sh"',
    '".github/workflows/rust-fast.yml"',
    '".github/workflows/rust-compatibility.yml"',
    '"scripts/test-rust-msrv-contract.mjs"',
    '"scripts/test-tauri-command-inventory.mjs"',
    '"scripts/test-extension-run-history-contract.mjs"',
    '"scripts/test-extension-p1-3-contract.mjs"',
    '"scripts/test-extension-phase-1-acceptance.mjs"',
    '"scripts/test-extension-phase-2-host-contract.mjs"',
    '"desktop/dist/app.js"',
    '"desktop/dist/index.html"',
    '"desktop/package.json"',
    '"desktop/package-lock.json"',
    '"NEWS.md"',
    '"r/rho.agent/R/aisdk_adapter.R"',
  ]) {
    if (!workflow.includes(requiredPath)) fail(`Rust Fast path filter is missing ${requiredPath}`);
  }
  for (const command of [
    "node scripts/test-rust-msrv-contract.mjs --test",
    "node scripts/test-rust-msrv-contract.mjs",
    "node scripts/test-tauri-command-inventory.mjs --test",
    "node scripts/test-tauri-command-inventory.mjs",
    "node scripts/test-license-contract.mjs --test",
    "node scripts/test-license-contract.mjs",
    "node scripts/test-extension-run-history-contract.mjs --test",
    "node scripts/test-extension-run-history-contract.mjs",
    "node scripts/test-extension-p1-3-contract.mjs --test",
    "node scripts/test-extension-p1-3-contract.mjs",
    "node scripts/test-extension-phase-1-acceptance.mjs --test",
    "node scripts/test-extension-phase-1-acceptance.mjs",
    "node scripts/test-extension-phase-2-host-contract.mjs --test",
    "node scripts/test-extension-phase-2-host-contract.mjs",
    "cargo fmt --all -- --check",
    "cargo check --workspace --all-targets --locked",
    "cargo test --workspace --locked --no-fail-fast",
  ]) {
    if (!workflow.includes(command)) fail(`Rust Fast is missing: ${command}`);
  }
  if (!workflow.includes("./scripts/bootstrap-ark-linux.sh")
      || !workflow.includes("./scripts/prepare-runtime-resources.sh")) {
    fail("Rust Fast must stage the pinned Linux Ark resources required by Tauri");
  }
  if (/contents:\s*write|secrets\.|upload-artifact|createRelease|tauri\s+build|notarytool|codesign|continue-on-error:/.test(workflow)) {
    fail("Rust Fast must not receive mutation, release, credential, or allowed-failure authority");
  }
  validateCargoCache(workflow);
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
      - "desktop/dist/app.js"
      - "desktop/dist/index.html"
      - "desktop/package.json"
      - "desktop/package-lock.json"
      - "NEWS.md"
      - "r/rho.agent/R/aisdk_adapter.R"
      - "vendor/jet/**/*.rs"
      - "runtime/ark.json"
      - "scripts/bootstrap-ark-macos.sh"
      - ".github/workflows/rust-compatibility.yml"
      - ".github/workflows/rust-fast.yml"
      - ".github/workflows/candidate-build-draft.yml"
      - "scripts/test-rust-msrv-contract.mjs"
      - "scripts/test-tauri-command-inventory.mjs"
      - "scripts/test-extension-run-history-contract.mjs"
      - "scripts/test-extension-p1-3-contract.mjs"
      - "scripts/test-extension-phase-1-acceptance.mjs"
      - "scripts/test-extension-phase-2-host-contract.mjs"
  pull_request:
    branches: [main]
    types: [opened, reopened, synchronize, ready_for_review]
    paths:
      - "**/Cargo.toml"
      - "Cargo.lock"
      - "rust-toolchain.toml"
      - ".cargo/**"
      - "crates/**/*.rs"
      - "desktop/src-tauri/**"
      - "desktop/dist/app.js"
      - "desktop/dist/index.html"
      - "desktop/package.json"
      - "desktop/package-lock.json"
      - "NEWS.md"
      - "r/rho.agent/R/aisdk_adapter.R"
      - "vendor/jet/**/*.rs"
      - "runtime/ark.json"
      - "scripts/bootstrap-ark-macos.sh"
      - ".github/workflows/rust-compatibility.yml"
      - ".github/workflows/rust-fast.yml"
      - ".github/workflows/candidate-build-draft.yml"
      - "scripts/test-rust-msrv-contract.mjs"
      - "scripts/test-tauri-command-inventory.mjs"
      - "scripts/test-extension-run-history-contract.mjs"
      - "scripts/test-extension-p1-3-contract.mjs"
      - "scripts/test-extension-phase-1-acceptance.mjs"
      - "scripts/test-extension-phase-2-host-contract.mjs"
permissions:
  contents: read
concurrency:
  group: rust-compatibility-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  rust-compatibility:
    if: github.event_name == 'push' || github.event.pull_request.draft == false
    timeout-minutes: 90
    strategy:
      fail-fast: false
      matrix:
        include:
${entries}
    env:
      RUSTUP_TOOLCHAIN: \${{ matrix.rustup_toolchain }}
      CARGO_INCREMENTAL: "0"
    steps:
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry/index/
            ~/.cargo/registry/cache/
            ~/.cargo/git/db/
            target/
          key: rho-rust-v1-\${{ runner.os }}-\${{ env.RUSTUP_TOOLCHAIN }}-\${{ hashFiles('Cargo.lock') }}
          restore-keys: |
            rho-rust-v1-\${{ runner.os }}-\${{ env.RUSTUP_TOOLCHAIN }}-
      - if: runner.os == 'Windows'
        run: echo "RHO_RTOOLS_BIN=C:\\rtools45\\x86_64-w64-mingw32.static.posix\\bin"
      - if: runner.os == 'macOS'
        run: ./scripts/bootstrap-ark-macos.sh
      - if: matrix.toolchain == 'stable'
        run: cargo fmt --all -- --check
      - run: |
          node scripts/test-rust-msrv-contract.mjs
          node scripts/test-tauri-command-inventory.mjs --test
          node scripts/test-tauri-command-inventory.mjs
          node scripts/test-extension-phase-1-acceptance.mjs --test
          node scripts/test-extension-phase-1-acceptance.mjs
          node scripts/test-extension-phase-2-host-contract.mjs --test
          node scripts/test-extension-phase-2-host-contract.mjs
          cargo check --workspace --all-targets --locked
          cargo test --workspace --locked --no-fail-fast
      - name: Build, install, smoke and remove unsigned Windows app
        if: matrix.toolchain == 'stable' && runner.os == 'Windows'
        run: |
          ./scripts/build-windows-installer.ps1
          echo "Rho uninstall registry cleanup failed"
      - name: Build, mount and smoke unsigned macOS app
        if: matrix.toolchain == 'stable' && runner.os == 'macOS'
        run: |
          env -u RHO_INTERNAL_EXTENSION_RUNTIME rho-desktop --smoke-test
          RHO_INTERNAL_EXTENSION_RUNTIME=legacy rho-desktop --smoke-test
          hdiutil detach mount
      - name: Build, extract and smoke unsigned Linux AppImage
        if: matrix.toolchain == 'stable' && runner.os == 'Linux'
        run: |
          scripts/build-linux.sh
          env -u RHO_INTERNAL_EXTENSION_RUNTIME rho-desktop --smoke-test
          RHO_INTERNAL_EXTENSION_RUNTIME=legacy rho-desktop --smoke-test
          rm -rf -- "$key_dir" "$extract_dir"
`;
}

function fixtureFastWorkflow() {
  return `name: Rust Fast
on:
  pull_request:
    branches: [main]
    types: [opened, reopened, synchronize]
    paths:
      - "**/Cargo.toml"
      - "Cargo.lock"
      - "rust-toolchain.toml"
      - ".cargo/**"
      - "crates/**/*.rs"
      - "desktop/src-tauri/**"
      - "desktop/dist/app.js"
      - "desktop/dist/index.html"
      - "desktop/package.json"
      - "desktop/package-lock.json"
      - "NEWS.md"
      - "r/rho.agent/R/aisdk_adapter.R"
      - "vendor/jet/**/*.rs"
      - "runtime/ark.json"
      - "scripts/bootstrap-ark-linux.sh"
      - ".github/workflows/rust-fast.yml"
      - ".github/workflows/rust-compatibility.yml"
      - "scripts/test-rust-msrv-contract.mjs"
      - "scripts/test-tauri-command-inventory.mjs"
      - "scripts/test-extension-run-history-contract.mjs"
      - "scripts/test-extension-p1-3-contract.mjs"
      - "scripts/test-extension-phase-1-acceptance.mjs"
      - "scripts/test-extension-phase-2-host-contract.mjs"
permissions:
  contents: read
concurrency:
  group: rust-fast-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  rust-fast:
    if: github.event.pull_request.draft == true
    runs-on: ubuntu-22.04
    env:
      RUSTUP_TOOLCHAIN: stable-x86_64-unknown-linux-gnu
      CARGO_INCREMENTAL: "0"
    steps:
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry/index/
            ~/.cargo/registry/cache/
            ~/.cargo/git/db/
            target/
          key: rho-rust-v1-\${{ runner.os }}-\${{ env.RUSTUP_TOOLCHAIN }}-\${{ hashFiles('Cargo.lock') }}
          restore-keys: |
            rho-rust-v1-\${{ runner.os }}-\${{ env.RUSTUP_TOOLCHAIN }}-
      - run: rustc -vV | grep -Fx "host: x86_64-unknown-linux-gnu"
      - run: |
          ./scripts/bootstrap-ark-linux.sh
          ./scripts/prepare-runtime-resources.sh
      - run: |
          node scripts/test-rust-msrv-contract.mjs --test
          node scripts/test-rust-msrv-contract.mjs
          node scripts/test-tauri-command-inventory.mjs --test
          node scripts/test-tauri-command-inventory.mjs
          node scripts/test-license-contract.mjs --test
          node scripts/test-license-contract.mjs
          node scripts/test-extension-run-history-contract.mjs --test
          node scripts/test-extension-run-history-contract.mjs
          node scripts/test-extension-p1-3-contract.mjs --test
          node scripts/test-extension-p1-3-contract.mjs
          node scripts/test-extension-phase-1-acceptance.mjs --test
          node scripts/test-extension-phase-1-acceptance.mjs
          node scripts/test-extension-phase-2-host-contract.mjs --test
          node scripts/test-extension-phase-2-host-contract.mjs
          cargo fmt --all -- --check
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
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace("ready_for_review", "converted_to_draft")), /Ready transition/);
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace("draft == false", "draft == true")), /gated/);
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace("actions/cache@v4", "actions/cache@v3")), /cache/);
  assert.throws(() => validateCompatibilityWorkflow(workflow.replace("hashFiles('Cargo.lock')", "github.sha")), /cache key/);

  const fastWorkflow = fixtureFastWorkflow();
  validateFastWorkflow(fastWorkflow);
  assert.throws(() => validateFastWorkflow(fastWorkflow.replace("synchronize", "ready_for_review")), /Draft open/);
  assert.throws(() => validateFastWorkflow(fastWorkflow.replace("contents: read", "contents: write")), /read-only/);
  assert.throws(() => validateFastWorkflow(fastWorkflow.replace("draft == true", "draft == false")), /Draft PRs only/);
  assert.throws(() => validateFastWorkflow(fastWorkflow.replace("actions/cache@v4", "actions/cache@v3")), /cache/);
  assert.throws(() => validateFastWorkflow(fastWorkflow.replace("env.RUSTUP_TOOLCHAIN", "matrix.toolchain")), /cache key/);
  assert.throws(() => validateFastWorkflow(fastWorkflow.replace(" --locked", "")), /missing:/);

  const candidates = `jobs:
  windows-candidate:
    run: cargo test --workspace --locked --no-fail-fast
  macos-submit:
    run: |
      export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
      echo "RUSTUP_TOOLCHAIN=$RUSTUP_TOOLCHAIN" >> "$GITHUB_ENV"
      cargo test --workspace --locked --no-fail-fast
  linux-candidate:
    run: cargo test --workspace --locked --no-fail-fast
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
  validateFastWorkflow(read(".github/workflows/rust-fast.yml"));
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
