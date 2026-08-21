import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validatePhase2FinalContract(value) {
  assert.match(value.compatibility, /^  workflow_dispatch:$/m);
  assert.match(
    value.compatibility,
    /if: github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.draft == false/,
  );
  assert.match(value.compatibility, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(
    value.compatibility,
    /contents:\s*write|secrets\.|upload-artifact|createRelease|notarytool|codesign/,
    "Phase 2 validation gained write, secret, signing, upload, or release authority",
  );
  for (const identity of [
    "macos-26|stable",
    'macos-26|"1.88.0"',
    "windows-latest|stable",
    'windows-latest|"1.88.0"',
    "ubuntu-22.04|stable",
    'ubuntu-22.04|"1.88.0"',
  ]) {
    const [os, toolchain] = identity.split("|");
    assert.ok(
      value.compatibility.includes(`- os: ${os}`)
        && value.compatibility.includes(`toolchain: ${toolchain}`),
      `Phase 2 final matrix lost ${identity}`,
    );
  }
  for (const marker of [
    "Build, install, smoke and remove unsigned Windows app",
    "Build, mount and smoke unsigned macOS app",
    "Build, extract and smoke unsigned Linux AppImage",
    "lane: installed",
    "matrix.lane == 'installed'",
    "rho-rust-v3-${{ runner.os }}-${{ env.RUSTUP_TOOLCHAIN }}-source",
    "rho-rust-v3-${{ runner.os }}-${{ env.RUSTUP_TOOLCHAIN }}-installed",
    "RHO_INTERNAL_EXTENSION_RUNTIME=legacy",
    "--smoke-test",
  ]) assert.ok(value.compatibility.includes(marker), `Phase 2 installed gate lost ${marker}`);
  for (const marker of [
    '"durable_first_enable": true',
    'report["recoverable_uninstall"] = json!(true)',
    'report["exact_trash_purged"] = json!(true)',
    'report["update_expected_old_cas"] = json!(true)',
    'report["rollback_restart_cached"] = json!(true)',
    'report["recovery_project_revision_once"] = json!(true)',
  ]) assert.ok(value.installed.includes(marker), `Phase 2 installed audit lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.11"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.11");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.11");
  assert.match(value.news, /## 0\.4\.1-dev\.11[\s\S]*Workspace-plugin crash-point recovery truth/);
  assert.match(value.spec, /Activated P2-4G contract — 2026-08-21/);
  for (const marker of [
    "Owner Phase 2 integration acceptance and visual-gate disposition — 2026-08-21",
    "dbd51d18038820c0ead6f1d3006ef28d164d2df3",
    "32456277341",
    "32456281744",
    "Visual modularization is a separate",
    "does not authorize release, publication, distribution",
  ]) assert.ok(value.spec.includes(marker), `Phase 2 acceptance disposition lost ${marker}`);
  assert.doesNotMatch(value.commands, /\binstall_workspace_plugin\b/, "Phase 2 added install command");
  assert.doesNotMatch(value.frontend, /data-plugin-install/, "Phase 2 added install UI");
}

function fixture() {
  return {
    compatibility: `name: Rust Compatibility
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  rust-compatibility:
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false
    strategy:
      matrix:
        include:
          - os: macos-26
            toolchain: stable
          - os: macos-26
            toolchain: "1.88.0"
          - os: windows-latest
            toolchain: stable
            lane: installed
          - os: windows-latest
            toolchain: "1.88.0"
          - os: ubuntu-22.04
            toolchain: stable
          - os: ubuntu-22.04
            toolchain: "1.88.0"
    steps:
      - name: Build, install, smoke and remove unsigned Windows app
        if: matrix.lane == 'installed'
      - name: Build, mount and smoke unsigned macOS app
      - name: Build, extract and smoke unsigned Linux AppImage
      - run: echo 'rho-rust-v3-\${{ runner.os }}-\${{ env.RUSTUP_TOOLCHAIN }}-source'
      - run: echo 'rho-rust-v3-\${{ runner.os }}-\${{ env.RUSTUP_TOOLCHAIN }}-installed'
      - run: RHO_INTERNAL_EXTENSION_RUNTIME=legacy rho-desktop --smoke-test`,
    installed: '"durable_first_enable": true\nreport["recoverable_uninstall"] = json!(true)\nreport["exact_trash_purged"] = json!(true)\nreport["update_expected_old_cas"] = json!(true)\nreport["rollback_restart_cached"] = json!(true)\nreport["recovery_project_revision_once"] = json!(true)',
    workspace: 'version = "0.4.1-dev.11"',
    tauri: '{"version":"0.4.1-dev.11"}',
    packageJson: '{"version":"0.4.1-dev.11"}',
    news: "## 0.4.1-dev.11\n### Workspace-plugin crash-point recovery truth",
    spec: "Activated P2-4G contract — 2026-08-21\nOwner Phase 2 integration acceptance and visual-gate disposition — 2026-08-21\ndbd51d18038820c0ead6f1d3006ef28d164d2df3\n32456277341\n32456281744\nVisual modularization is a separate follow-on design stream\ndoes not authorize release, publication, distribution",
    commands: "list_workspace_plugins",
    frontend: "Workspace Plugins",
  };
}

if (process.argv.includes("--test")) {
  validatePhase2FinalContract(fixture());
  for (const [name, mutate] of [
    ["dispatch", (value) => { value.compatibility = value.compatibility.replace("  workflow_dispatch:\n", ""); }],
    ["read only", (value) => { value.compatibility = value.compatibility.replace("contents: read", "contents: write"); }],
    ["matrix", (value) => { value.compatibility = value.compatibility.replaceAll("- os: windows-latest", "- os: omitted"); }],
    ["installed", (value) => { value.installed = value.installed.replace('report["rollback_restart_cached"] = json!(true)', ""); }],
    ["Windows installed lane", (value) => { value.compatibility = value.compatibility.replace("lane: installed", "lane: source"); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.10"'; }],
    ["visual disposition", (value) => { value.spec = value.spec.replace("Visual modularization is a separate", "Visual work is bundled"); }],
    ["install", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validatePhase2FinalContract(value), undefined, name);
  }
} else {
  validatePhase2FinalContract({
    compatibility: read(".github/workflows/rust-compatibility.yml"),
    installed: read("desktop/src-tauri/src/main.rs"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    news: read("NEWS.md"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    frontend: read("desktop/dist/app.js"),
  });
}

console.log("extension Phase 2 final validation contract passed");
