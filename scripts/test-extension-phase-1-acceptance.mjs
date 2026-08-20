import assert from "node:assert/strict";
import fs from "node:fs";

const EXPECTED_VERSION = "0.4.1-dev.5";
const read = (path) => fs.readFileSync(path, "utf8");

export function validatePhase1Acceptance(value) {
  assert.match(value.cargo, new RegExp(`^version = "${EXPECTED_VERSION.replaceAll(".", "\\.")}"$`, "m"), "Cargo workspace version changed");
  assert.equal(JSON.parse(value.tauri).version, EXPECTED_VERSION, "Tauri version changed");
  assert.equal(JSON.parse(value.packageJson).version, EXPECTED_VERSION, "desktop package version changed");
  const lock = JSON.parse(value.packageLock);
  assert.equal(lock.version, EXPECTED_VERSION, "desktop lock root version changed");
  assert.equal(lock.packages[""].version, EXPECTED_VERSION, "desktop lock package version changed");
  const localVersions = [...value.cargoLock.matchAll(/name = "rho-[^"]+"\nversion = "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(localVersions.length >= 11, "Cargo.lock omitted local Rho packages");
  assert.ok(localVersions.every((version) => version === EXPECTED_VERSION), "Cargo.lock local versions diverged");
  const expectedVersionPattern = EXPECTED_VERSION.replaceAll(".", "\\.");
  assert.match(value.index, new RegExp(`styles\\.css\\?v=${expectedVersionPattern}`));
  assert.match(value.index, new RegExp(`app\\.js\\?v=${expectedVersionPattern}`));
  assert.ok((value.frontend.match(new RegExp(expectedVersionPattern, "g")) ?? []).length >= 2, "browser version fixtures diverged");
  assert.match(value.news, /^## 0\.4\.1-dev\.1 - 2026-08-18$/m, "NEWS candidate section is missing");
  assert.match(value.news, /Keychain access is deferred to the exact Provider/,
    "NEWS must record lazy selected-Provider credential access");
  assert.match(value.news, /internal first-party runtime,\n  not a public plugin SDK/, "NEWS must not claim a public SDK");

  assert.match(value.runtime, /None \| Some\("candidate"\) => Self::Candidate/, "candidate is not the missing-variable default");
  assert.match(value.runtime, /Some\("legacy"\) => Self::Legacy/, "explicit legacy override is missing");
  assert.match(value.runtimeTests, /parse\(None, sink\.as_ref\(\)\),\s*InternalExtensionRuntimeMode::Candidate/, "runtime default regression test is missing");
  assert.match(value.desktop, /build_extension_host\(None, diagnostics\(\)\)/, "desktop default-host regression test is missing");
  assert.match(value.desktop, /async fn smoke_extension_runtime\(/, "packaged extension smoke is missing");
  for (const marker of [
    '"candidate_exercised": true',
    '"run_history_parity": true',
    '"workspace_snapshot_typed": true',
    '"viewer_host_injected": true',
    '"old_workspace_rejected": true',
    '"legacy_override_exercised": true',
  ]) {
    assert.ok(value.desktop.includes(marker), `packaged smoke marker is missing: ${marker}`);
  }
  for (const id of [
    "org.yulab.rho.run-history",
    "org.yulab.rho.workspace-snapshot-tool",
    "org.yulab.rho.project-file-viewer",
  ]) {
    assert.equal((value.desktop.match(new RegExp(id.replaceAll(".", "\\."), "g")) ?? []).length >= 1, true, `static inventory lost ${id}`);
  }

  assert.match(value.compatibility, /timeout-minutes: 90/);
  assert.match(value.compatibility, /Build, install, smoke and remove unsigned Windows app/);
  assert.match(value.compatibility, /Build, mount and smoke unsigned macOS app/);
  assert.match(value.compatibility, /Build, extract and smoke unsigned Linux AppImage/);
  assert.doesNotMatch(value.compatibility, /contents:\s*write|secrets\.|upload-artifact|notarytool|createRelease/, "installed acceptance gained external publication authority");
  assert.ok((value.compatibility.match(/RHO_INTERNAL_EXTENSION_RUNTIME=legacy/g) ?? []).length >= 2, "Unix legacy installed smoke is incomplete");
  assert.ok((value.compatibility.match(/RHO_INTERNAL_EXTENSION_RUNTIME = "legacy"/g) ?? []).length >= 2, "Windows legacy installed smoke is incomplete");
  assert.match(value.p14, /0\.4\.1-dev\.0/);
  assert.match(value.p14, /six Rust legs plus all three unsigned installed-app legs/);
}

function fixture() {
  const packages = Array.from({ length: 11 }, (_, index) => `[[package]]\nname = "rho-${index}"\nversion = "${EXPECTED_VERSION}"`).join("\n");
  return {
    cargo: `[workspace.package]\nversion = "${EXPECTED_VERSION}"`,
    cargoLock: packages,
    tauri: JSON.stringify({ version: EXPECTED_VERSION }),
    packageJson: JSON.stringify({ version: EXPECTED_VERSION }),
    packageLock: JSON.stringify({ version: EXPECTED_VERSION, packages: { "": { version: EXPECTED_VERSION } } }),
    index: `styles.css?v=${EXPECTED_VERSION}\napp.js?v=${EXPECTED_VERSION}`,
    frontend: `${EXPECTED_VERSION}\n${EXPECTED_VERSION}`,
    news: `## 0.4.1-dev.1 - 2026-08-18\nKeychain access is deferred to the exact Provider\ninternal first-party runtime,\n  not a public plugin SDK`,
    runtime: `None | Some("candidate") => Self::Candidate\nSome("legacy") => Self::Legacy`,
    runtimeTests: `parse(None, sink.as_ref()), InternalExtensionRuntimeMode::Candidate`,
    desktop: `build_extension_host(None, diagnostics())\nasync fn smoke_extension_runtime() {}\n"candidate_exercised": true\n"run_history_parity": true\n"workspace_snapshot_typed": true\n"viewer_host_injected": true\n"old_workspace_rejected": true\n"legacy_override_exercised": true\norg.yulab.rho.run-history\norg.yulab.rho.workspace-snapshot-tool\norg.yulab.rho.project-file-viewer`,
    compatibility: `permissions:\n  contents: read\ntimeout-minutes: 90\nBuild, install, smoke and remove unsigned Windows app\nBuild, mount and smoke unsigned macOS app\nBuild, extract and smoke unsigned Linux AppImage\nRHO_INTERNAL_EXTENSION_RUNTIME=legacy\nRHO_INTERNAL_EXTENSION_RUNTIME=legacy\nRHO_INTERNAL_EXTENSION_RUNTIME = "legacy"\nRHO_INTERNAL_EXTENSION_RUNTIME = "legacy"`,
    p14: `0.4.1-dev.0\nsix Rust legs plus all three unsigned installed-app legs`,
  };
}

function selfTest() {
  validatePhase1Acceptance(fixture());
  for (const [name, mutate] of [
    ["version", (value) => { value.tauri = JSON.stringify({ version: "0.4.0" }); }],
    ["default", (value) => { value.runtime = value.runtime.replace("Self::Candidate", "Self::Legacy"); }],
    ["smoke", (value) => { value.desktop = value.desktop.replace('"run_history_parity": true', ""); }],
    ["installed", (value) => { value.compatibility = value.compatibility.replace("Build, mount and smoke unsigned macOS app", ""); }],
    ["authority", (value) => { value.compatibility += "\ncontents: write"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validatePhase1Acceptance(value), undefined, name);
  }
}

if (process.argv.includes("--test")) {
  selfTest();
} else {
  validatePhase1Acceptance({
    cargo: read("Cargo.toml"),
    cargoLock: read("Cargo.lock"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    packageLock: read("desktop/package-lock.json"),
    index: read("desktop/dist/index.html"),
    frontend: read("desktop/dist/app.js"),
    news: read("NEWS.md"),
    runtime: read("crates/rho-extension-runtime/src/lifecycle.rs"),
    runtimeTests: read("crates/rho-extension-runtime/tests/lifecycle.rs"),
    desktop: read("desktop/src-tauri/src/main.rs"),
    compatibility: read(".github/workflows/rust-compatibility.yml"),
    p14: read("docs/plans/implemented-2026-08-18-p1-4-default-acceptance-spec.md"),
  });
}

console.log("extension Phase 1 acceptance contract passed");
