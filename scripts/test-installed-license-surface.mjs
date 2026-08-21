import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

const base = readJson("desktop/src-tauri/tauri.conf.json");
const macos = readJson("desktop/src-tauri/tauri.macos.conf.json");
const windows = readJson("desktop/src-tauri/tauri.windows.conf.json");
assert.equal(base.bundle.license, "AGPL-3.0-only");
assert.equal(
  base.bundle.licenseFile,
  undefined,
  "AGPL must not be projected as an installer click-through EULA",
);

const expectedRhoResources = {
  "../../LICENSE": "licenses/rho/LICENSE.txt",
  "../../LICENSES.md": "licenses/rho/THIRD-PARTY-NOTICES.md",
};
for (const [platform, config] of [["macOS", macos], ["Windows", windows]]) {
  for (const [source, target] of Object.entries(expectedRhoResources)) {
    assert.equal(config.bundle.resources[source], target, `${platform} must bundle ${source}`);
  }
}
assert.equal(macos.bundle.resources["../resources/runtime/LICENSE"], "licenses/ark/LICENSE");
assert.equal(macos.bundle.resources["../resources/runtime/NOTICE"], "licenses/ark/NOTICE");
assert.equal(windows.bundle.resources["../resources/runtime/"], "resources/runtime/");
assert.equal(windows.bundle.resources["../resources/WebView2Loader.dll"], "WebView2Loader.dll");

const html = read("desktop/dist/index.html");
assert.match(html, /<strong>License<\/strong>\s*<span>GNU AGPL v3\.0 only<\/span>/);
assert.match(html, /Corresponding source is available from the Source Repository\./);
assert.match(html, /<button id="aboutLicense" type="button">Show License File<\/button>/);
assert.doesNotMatch(html, /licenses\/rho|LICENSE\.txt/);

const js = read("desktop/dist/app.js");
assert.match(js, /if \(command === "show_rho_license"\) return null;/);
const aboutHandlersStart = js.indexOf('$("#aboutClose")');
const aboutHandlers = js.slice(aboutHandlersStart, js.indexOf('$("#updateRetry")', aboutHandlersStart));
assert.match(aboutHandlers, /\$\("#aboutLicense"\)\.addEventListener\("click", async \(\) => \{/);
assert.match(aboutHandlers, /await invoke\("show_rho_license"\);/);
assert.match(aboutHandlers, /reportUiFailure\("show bundled license"/);
assert.doesNotMatch(aboutHandlers, /show_rho_license",\s*\{/);

const rust = read("desktop/src-tauri/src/main.rs");
assert.match(rust, /const RHO_LICENSE_RESOURCE: &str = "licenses\/rho\/LICENSE\.txt";/);
assert.match(rust, /async fn show_rho_license\(app: AppHandle\) -> Result<\(\), String>/);
const commandStart = rust.indexOf("fn ensure_bundled_license_file(");
const showCommandStart = rust.indexOf("async fn show_rho_license(", commandStart);
const commandEnd = rust.indexOf("\nasync fn bootstrap_runtime", showCommandStart + 1);
const command = rust.slice(commandStart, commandEnd);
assert.match(command, /app\s*\.path\(\)\s*\.resolve\(RHO_LICENSE_RESOURCE, BaseDirectory::Resource\)/);
assert.match(command, /symlink_metadata\(path\)/);
assert.match(command, /metadata\.is_file\(\)/);
assert.match(command, /!metadata\.file_type\(\)\.is_symlink\(\)/);
assert.match(command, /platform::reveal_path_command\(\&path\)/);
assert.doesNotMatch(command, /read_to_string|FileDialog|url: String|path: (?:String|PathBuf)/);
assert.match(rust, /tauri::generate_handler!\[[\s\S]*?show_rho_license,/);

const workflow = read(".github/workflows/candidate-build-draft.yml");
assert.equal(
  [...workflow.matchAll(/verify_rho_license_resources "\$app_path"/g)].length,
  2,
  "macOS submission and mounted-finalizer must both verify license resources",
);
assert.equal(
  [...workflow.matchAll(/local license_path="\$app_path\/Contents\/Resources\/licenses\/rho\/LICENSE\.txt"/g)].length,
  2,
);
assert.equal(
  [...workflow.matchAll(/local notices_path="\$app_path\/Contents\/Resources\/licenses\/rho\/THIRD-PARTY-NOTICES\.md"/g)].length,
  2,
);
assert.equal([...workflow.matchAll(/cmp -s LICENSE "\$license_path"/g)].length, 2);
assert.equal([...workflow.matchAll(/cmp -s LICENSES\.md "\$notices_path"/g)].length, 2);
assert.match(workflow, /--checks [^\n]*license_boundary/);

const candidate = read("scripts/candidate-release.mjs");
assert.match(candidate, /macos_aarch64:[\s\S]*?"license_boundary"/);
assert.match(candidate, /"0\.4\.0-dev\.24": new Set\(\["license_boundary"\]\)/);
assert.match(candidate, /export function validatePublishedPlatformEvidence/);

const updateSite = read("scripts/generate-update-site.mjs");
assert.match(updateSite, /validatePublishedPlatformEvidence\(supplied\.content/);
assert.match(updateSite, /fakeCandidateRecord\("0\.4\.0-dev\.24"\)/);
assert.match(updateSite, /fakeCandidateRecord\("0\.4\.0-dev\.34"\)/);
assert.match(updateSite, /fakeCandidateRecord\("0\.4\.0-dev\.23"\)/);
for (const strictConsumer of [
  ".github/workflows/candidate-build-draft.yml",
  ".github/workflows/candidate-publish.yml",
]) {
  assert.doesNotMatch(read(strictConsumer), /validatePublishedPlatformEvidence/);
}

const sourceCi = read(".github/workflows/rust-compatibility.yml");
assert.match(sourceCi, /- name: Verify installed license surface\s+if: matrix\.lane == 'source' && matrix\.toolchain == 'stable'\s+run: \|\s+node scripts\/test-installed-license-surface\.mjs\s+node scripts\/generate-update-site\.mjs --test true/);
assert.equal(
  [...sourceCi.matchAll(/- "scripts\/test-installed-license-surface\.mjs"/g)].length,
  2,
  "push and pull-request changes to the contract must trigger source CI",
);
for (const sourcePath of [
  ".github/workflows/candidate-publish.yml",
  ".github/workflows/update-site-publish.yml",
  "scripts/candidate-release.mjs",
  "scripts/generate-update-site.mjs",
]) {
  assert.equal(
    [...sourceCi.matchAll(new RegExp(`- "${sourcePath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`, "g"))].length,
    2,
    `${sourcePath} changes must trigger push and pull-request source CI`,
  );
}

const news = read("NEWS.md");
const dev33Start = news.indexOf("## 0.4.0-dev.33");
const dev33 = news.slice(dev33Start, news.indexOf("\n## 0.4.0-dev.32", dev33Start));
assert.match(dev33, /AGPL|license/i);
assert.match(dev33, /About/);

console.log("installed license surface contract is valid");
