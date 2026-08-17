import assert from "node:assert/strict";
import fs from "node:fs";

const normalize = (value) => value.replace(/\r\n?/g, "\n");
const read = (file) => normalize(fs.readFileSync(file, "utf8"));
const count = (value, pattern) => [...value.matchAll(pattern)].length;

const build = read(".github/workflows/candidate-build-draft.yml");
const publish = read(".github/workflows/candidate-publish.yml");
const pages = read(".github/workflows/update-site-publish.yml");
const candidate = read("scripts/candidate-release.mjs");
const updater = read("scripts/tauri-native-updater.mjs");
const signatureVerifier = read("crates/rho-updater-verifier/src/main.rs");
const updateSource = read("desktop/src-tauri/src/update.rs");
const frontend = read("desktop/dist/app.js");
const backend = read("desktop/src-tauri/src/main.rs");
const config = JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
const windowsConfig = JSON.parse(read("desktop/src-tauri/tauri.windows.conf.json"));
const macosConfig = JSON.parse(read("desktop/src-tauri/tauri.macos.conf.json"));
const spec = read("docs/plans/active-2026-08-15-tauri-native-updater-spec.md");
const checklist = read("docs/release/active-0.4.0-dev.42-two-stage-signing-checklist.md");
const crossReview = read("docs/project/active-document-cross-review.md");
const notes = read(".github/release-notes/v0.4.0-dev.42.md");

const windows = build.match(/\n  windows-candidate:[\s\S]*?(?=\n  macos-submit:)/)?.[0];
const macSubmit = build.match(/\n  macos-submit:[\s\S]*?(?=\n  macos-notary-wait:)/)?.[0];
const macFinalize = build.match(/\n  macos-finalize:[\s\S]*?(?=\n  rehearsal-evidence:)/)?.[0];
const draft = build.match(/\n  draft-candidate:[\s\S]*$/)?.[0];
assert.ok(windows && macSubmit && macFinalize && draft, "Candidate workflow jobs are incomplete");

assert.equal(windowsConfig.bundle.createUpdaterArtifacts, true);
assert.equal(macosConfig.bundle.createUpdaterArtifacts, true);
assert.equal(config.plugins.updater.endpoints[0], "https://yulab-smu.top/Rho/updates/tauri/stable.json");
assert.match(config.plugins.updater.pubkey, /^[A-Za-z0-9+/=]+$/);
assert.match(backend, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
assert.match(backend, /app\s*\.updater_builder\(\)/);
assert.match(backend, /async fn install_native_update\(/);
assert.match(backend, /update::validate_native_update_candidate_metadata\(/);
assert.match(backend, /download_and_verify_native_update/);
assert.match(backend, /UPDATE_DOWNLOAD/);
assert.match(backend, /install_verified_native_update/);
assert.doesNotMatch(backend, /pending\.update\.install/);
assert.match(updateSource, /MAX_NATIVE_UPDATE_ARTIFACT_BYTES/);
assert.match(updateSource, /parsed_native_update_signature/);
assert.match(updateSource, /install_windows_native_update/);
assert.match(updateSource, /replace_macos_app_with/);
assert.match(updateSource, /macos_native_update_staging_and_replacement_are_transactional/);
assert.match(frontend, /invoke\("install_native_update", \{ expectedVersion \}\)/);
assert.match(frontend, /Could not install the update/);
assert.match(frontend, /renderUpdateFailure\(error, \{ duringInstall: true \}\)/);
assert.doesNotMatch(frontend, /plugin:updater/);

assert.match(windows, /signer generate --ci --write-keys/);
assert.match(windows, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ needs\.identity\.outputs\.build_mode == 'candidate' && secrets\.TAURI_SIGNING_PRIVATE_KEY \|\| '' \}\}/);
assert.match(windows, /Tauri did not create the required updater artifact signature/);
const windowsBinaryPromotion = windows.indexOf("Verify and promote returned test-signed Windows executable");
const windowsBundle = windows.indexOf("Bundle NSIS without rebuilding signed Windows executable");
const windowsPromotion = windows.indexOf("Verify and promote returned test-signed Windows installer");
const windowsFinalSign = windows.indexOf("Sign final Authenticode Windows updater artifact");
assert.ok(
  windowsBinaryPromotion >= 0 && windowsBinaryPromotion < windowsBundle && windowsBundle < windowsPromotion,
  "Windows executable must be Authenticode-signed before the no-rebuild NSIS bundle and installer signing",
);
assert.ok(windowsPromotion >= 0 && windowsPromotion < windowsFinalSign, "Windows updater signature must follow final Authenticode promotion");
assert.match(windows, /Install and verify signed Windows payload/);
assert.match(windows, /installed_binary_sha256/);
assert.match(windows, /signer sign "\$artifact"/);
assert.match(windows, /cargo run --locked -p rho-updater-verifier/);
assert.match(windows, /Upload final Windows native updater signature/);

assert.match(macSubmit, /signer generate --ci --write-keys/);
assert.match(macSubmit, /Tauri did not create exactly one signed macOS updater artifact/);
assert.equal(count(macSubmit, /xcrun notarytool submit/g), 2, "DMG and same-app archive require independent notarization submissions");
assert.match(macSubmit, /ditto -c -k --keepParent "\$app_path" "\$submitted_app_archive"/);
assert.match(macSubmit, /--artifact "\$submitted_app_archive" --artifact-kind app_zip/);
assert.match(macFinalize, /macos-app-archive-notary-accepted/);
assert.match(macFinalize, /xcrun stapler staple "\$updater_app_path"/);
assert.match(macFinalize, /tar -C "\$updater_extract" -czf "\$updater_tar" Rho\.app/);
assert.match(macFinalize, /Sign final notarized macOS updater archive/);
assert.match(macFinalize, /signer sign "\$artifact"/);
assert.match(macFinalize, /cargo run --locked -p rho-updater-verifier/);
assert.match(macFinalize, /Upload final macOS native updater inputs/);

assert.match(signatureVerifier, /verify_stream/);
assert.match(signatureVerifier, /Tauri updater public key/);
assert.match(signatureVerifier, /Tauri updater signature does not verify/);

assert.match(draft, /tauri-native-updater\.mjs --mode evidence/);
for (const name of [
  "Rho_${version}_x64-setup.exe.sig",
  "Rho_${version}_aarch64.app.tar.gz",
  "Rho_${version}_aarch64.app.tar.gz.sig",
  "rho-${version}-tauri-native-updater-evidence.json",
]) assert.ok(draft.includes(name), `Draft omits ${name}`);

for (const name of [
  "nativeUpdaterEvidenceName",
  "windowsUpdaterSignatureName",
  "macosUpdaterArchiveName",
  "native_updater_evidence",
  "native_updater_evidence_asset",
  "native_updater_signatures",
]) assert.ok(publish.includes(name), `Publish admission omits ${name}`);
assert.match(candidate, /NATIVE_UPDATER_REQUIRED_VERSIONS = new Set\(\["0\.4\.0-dev\.40", "0\.4\.0-dev\.42"\]\)/);
assert.match(candidate, /validateNativeUpdaterReleaseAssets/);
assert.match(updater, /TAURI_PUBLIC_KEY_ID = "173c902c085bfe5f"/);
assert.match(updater, /validateNativeUpdaterReleaseAssets/);
assert.match(updater, /native_updater_archive/);

assert.match(pages, /updates\/tauri\/development\.json/);
assert.match(pages, /rho-\$\{version\}-tauri-native-updater-evidence\.json/);
assert.match(pages, /Rho_\$\{version\}_aarch64\.app\.tar\.gz\.sig/);
assert.match(pages, /Verify deployed native updater manifest/);

assert.match(spec, /Status: active; `UPDATER-1A` source\/signing\/publication-contract work is/);
assert.match(spec, /`UPDATER-1C-T1`, the bounded `dev\.41` acceptance transport/);
assert.match(spec, /No updater signature may be reused after a byte-changing/);
assert.match(checklist, /Current release decision: `NO_RELEASE_DECISION`/);
assert.match(crossReview, /may not own an\n   unbounded download or destructive default install/);
assert.match(notes, /^Rho signs both the Windows application executable and NSIS installer/m);

console.log("Tauri native updater contract tests passed.");
