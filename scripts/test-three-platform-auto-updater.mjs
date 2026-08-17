import assert from "node:assert/strict";
import fs from "node:fs";

import { candidatePlatformsForVersion } from "./candidate-release.mjs";
import { nativeUpdaterPlatformsForVersion } from "./tauri-native-updater.mjs";

const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
const update = read("desktop/src-tauri/src/update.rs");
const frontend = read("desktop/dist/app.js");
const build = read(".github/workflows/candidate-build-draft.yml");
const publish = read(".github/workflows/candidate-publish.yml");
const pages = read(".github/workflows/update-site-publish.yml");
const linuxBuild = read("scripts/build-linux.sh");
const linuxConfig = JSON.parse(read("desktop/src-tauri/tauri.linux.conf.json"));

assert.deepEqual(candidatePlatformsForVersion("0.4.0-dev.42"), ["windows_x86_64", "macos_aarch64"]);
assert.deepEqual(candidatePlatformsForVersion("0.4.0-dev.43"), ["windows_x86_64", "macos_aarch64", "linux_x86_64"]);
assert.deepEqual(nativeUpdaterPlatformsForVersion("0.4.0-dev.42"), ["windows_x86_64", "macos_aarch64"]);
assert.deepEqual(nativeUpdaterPlatformsForVersion("0.4.0-dev.43"), ["windows_x86_64", "macos_aarch64", "linux_x86_64"]);

assert.equal(linuxConfig.bundle.createUpdaterArtifacts, true);
assert.match(update, /\("linux", "x86_64"\)/);
assert.match(update, /fn install_linux_native_update/);
assert.match(update, /APPIMAGE/);
assert.match(update, /replace_linux_appimage_with/);
assert.match(update, /staged Linux AppImage smoke test failed/);
assert.match(update, /current image was restored/);
assert.match(update, /linux_appimage_replacement_is_transactional/);

assert.match(frontend, /automaticUpdateStarted: false/);
assert.match(frontend, /async function runAutomaticUpdateAfterStartup/);
assert.match(frontend, /await invoke\("check_for_updates"\)/);
assert.match(frontend, /await invoke\("install_native_update", \{ expectedVersion:/);
assert.match(frontend, /void runAutomaticUpdateAfterStartup\(\)/);
assert.match(frontend, /platform: "linux-x86_64"/);

assert.match(linuxBuild, /patch-appimage-apprun\.sh[\s\S]*signer sign "\$RHO_APPIMAGE"/);
assert.match(build, /linux-candidate:/);
assert.match(build, /--platform linux_x86_64/);
assert.match(build, /--linux_evidence/);
assert.match(build, /Rho_\$\{version\}_x86_64\.AppImage\.sig/);
assert.match(build, /--mode automated-acceptance/);
assert.match(publish, /linux_x86_64/);
assert.match(publish, /linuxUpdaterSignatureName/);
assert.match(pages, /linux_x86_64/);
assert.match(pages, /linux-x86_64/);

console.log("Three-platform automatic updater contract tests passed.");
