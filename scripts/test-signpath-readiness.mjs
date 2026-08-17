import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = (relativePath) => normalize(fs.readFileSync(path.join(root, relativePath), "utf8"));

function snapshot() {
  return {
    privacy: read("PRIVACY.md"),
    signing: read("CODE_SIGNING_POLICY.md"),
    security: read("SECURITY.md"),
    owners: read(".github/CODEOWNERS"),
    readme: read("README.md"),
    frontend: read("desktop/dist/app.js"),
    html: read("desktop/dist/index.html"),
    updateBackend: read("desktop/src-tauri/src/update.rs"),
    desktopBackend: read("desktop/src-tauri/src/main.rs"),
    tauriConfig: read("desktop/src-tauri/tauri.conf.json"),
    windowsTauriConfig: read("desktop/src-tauri/tauri.windows.conf.json"),
    macosTauriConfig: read("desktop/src-tauri/tauri.macos.conf.json"),
    linuxTauriConfig: read("desktop/src-tauri/tauri.linux.conf.json"),
    updateDesign: read("docs/design/accepted-2026-07-25-about-and-update-check-design.md"),
    docsIndex: read("docs/README.md"),
    activeSpec: read("docs/plans/active-2026-08-11-signpath-application-readiness-spec.md"),
    autoSpec: read("docs/plans/active-2026-08-17-three-platform-automatic-updater-dev43-spec.md"),
    checklist: read("docs/release/historical-0.4.0-dev.39-candidate-checklist.md"),
    news: read("NEWS.md"),
    generator: read("scripts/generate-update-site.mjs"),
    compatibilityWorkflow: read(".github/workflows/rust-compatibility.yml"),
  };
}

function occurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function validate(value) {
  assert.match(value.privacy, /^# Rho Privacy Policy$/m, "PRIVACY.md must be the canonical privacy policy");
  assert.match(value.privacy, /does not include first-party\s+analytics, advertising, background telemetry, or automatic crash-report upload/i);
  assert.match(value.privacy, /After local startup becomes ready, Rho automatically contacts the fixed Rho\s+update service once/);
  assert.match(value.privacy, /operating system\s+credential store/i);
  assert.match(value.privacy, /custom Base URL/i);
  assert.match(value.privacy, /Crossref/i);
  assert.match(value.privacy, /uninstalling Rho does not\s+necessarily remove/i);
  assert.match(value.privacy, /security\/advisories\/new/);

  assert.match(value.signing, /^# Rho Code Signing Policy$/m);
  assert.match(value.signing, /Free code signing provided by \[SignPath\.io\]\(https:\/\/about\.signpath\.io\),\s+certificate by \[SignPath Foundation\]\(https:\/\/signpath\.org\)/);
  assert.match(value.signing, /published `0\.4\.0-dev\.24` Windows download[\s\S]{0,160}not Authenticode-signed/i);
  assert.match(value.signing, /SignPath Free Trial self-signed test certificate/i);
  assert.match(value.signing, /not\s+publicly trusted/i);
  assert.match(value.signing, /does not establish SignPath Foundation acceptance/i);
  assert.match(value.signing, /expected untrusted `UnknownError` status/i);
  assert.doesNotMatch(value.signing, /Windows downloads are Authenticode-signed/i, "unsigned Windows status must not be overstated");
  assert.match(value.signing, /rho-desktop\.exe/);
  assert.match(value.signing, /NSIS/i);
  for (const excluded of ["Ark", "Jet", "WebView2Loader"]) assert.match(value.signing, new RegExp(excluded));
  assert.match(value.signing, /production policy requires manual approval[^.]*every production\s+signing request/i);
  assert.match(value.signing, /Authors and Reviewers[\s\S]{0,180}organization members/i);
  assert.match(value.signing, /Approvers[\s\S]{0,180}organization owners/i);
  assert.match(value.signing, /multi-factor authentication\s+\(MFA\)/i);
  assert.match(value.signing, /RFC 3161/i);
  assert.match(value.signing, /SmartScreen/i);
  assert.match(value.signing, /pull request[\s\S]{0,120}rehearsal[\s\S]{0,120}fail closed/i);

  assert.match(value.security, /github\.com\/YuLab-SMU\/Rho\/security\/advisories\/new/);
  assert.match(value.security, /Do not open a public Issue/i);

  for (const owner of ["@GuangchuangYu", "@xiayh17"]) assert.match(value.owners, new RegExp(owner));
  for (const protectedPath of [
    "/.github/CODEOWNERS",
    "/.github/workflows/",
    "/.signpath/policies/",
    "/CODE_SIGNING_POLICY.md",
    "/PRIVACY.md",
    "/SECURITY.md",
    "/scripts/candidate-release.mjs",
    "/scripts/generate-update-site.mjs",
    "/scripts/test-signpath-candidate-workflow.mjs",
    "/docs/plans/active-2026-08-13-dev38-test-signed-prerelease-spec.md",
    "/docs/plans/implemented-2026-08-13-conditional-prerelease-policy-spec.md",
  ]) assert.match(value.owners, new RegExp(protectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const link of ["PRIVACY.md", "SECURITY.md", "CODE_SIGNING_POLICY.md", "LICENSE"]) {
    assert.match(value.readme, new RegExp(`\\]\\(${link.replace(".", "\\.")}\\)`), `README must link ${link}`);
  }
  assert.match(value.readme, /Code signing policy/);
  assert.match(value.readme, /Windows trust status is recorded per release/);
  assert.match(value.readme, /Free Trial self-signed test signature/);
  assert.match(value.readme, /not publicly trusted or a SignPath Foundation production/);
  assert.match(value.readme, /checks its fixed signed-update endpoint once after local startup/i);
  assert.match(value.readme, /^## Uninstallation$/m);
  assert.match(value.readme, /Settings > Apps > Installed apps/);
  assert.match(value.readme, /move \*\*Rho\.app\*\* from \*\*Applications\*\* to the\s+Trash/i);
  assert.match(value.readme, /Uninstalling the application does not automatically delete project files/i);

  assert.match(value.html, /data-menu-command="check-updates"/);
  assert.match(value.html, /id="updateInstall"[^>]*>Install and Restart/);
  assert.match(value.frontend, /"check-updates": \(\) => openUpdateDialog\(\)/);
  assert.match(value.frontend, /function openUpdateDialog\(\) \{\s*(?:void )?checkForUpdates\(\);\s*\}/);
  assert.match(value.frontend, /\$\("#updateRetry"\)\.addEventListener\("click", \(\) => checkForUpdates\(\)\)/);
  assert.match(value.frontend, /function installNativeUpdate\(\)/);
  assert.match(value.frontend, /invoke\("install_native_update", \{ expectedVersion \}\)/);
  assert.match(value.frontend, /Browser preview cannot install updates/);
  assert.match(value.frontend, /UPDATE_STALE/);
  assert.doesNotMatch(value.frontend, /updateView/);
  assert.equal(occurrences(value.frontend, /invoke\("check_for_updates"\)/g), 2, "manual retry and readiness-bound automatic update paths are required");
  assert.match(value.frontend, /runAutomaticUpdateAfterStartup/);
  assert.doesNotMatch(value.frontend, /setInterval[\s\S]{0,120}checkForUpdates/);
  assert.doesNotMatch(value.frontend, /checkForUpdates\(\{\s*background\s*:/);
  assert.doesNotMatch(value.frontend, /rho\.update\.(?:lastCheck|dismissed)/);
  assert.doesNotMatch(value.frontend, /async function checkForUpdates\([^)]*background/);
  assert.match(value.updateBackend, /pub const WEBSITE_URL: &str = "https:\/\/yulab-smu\.top\/Rho\/"/);
  assert.match(value.updateBackend, /NATIVE_UPDATE_STABLE_ENDPOINT/);
  assert.match(value.updateBackend, /NATIVE_UPDATE_DEVELOPMENT_ENDPOINT/);
  assert.match(value.updateBackend, /native_updater_supported\(\)/);
  assert.match(value.updateBackend, /normalized_native_update_notes/);
  assert.match(value.desktopBackend, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(value.desktopBackend, /async fn install_native_update\(/);
  assert.match(value.desktopBackend, /app\s*\.updater_builder\(\)/);
  assert.match(value.desktopBackend, /pending_native_update_matches/);
  const tauriConfig = JSON.parse(value.tauriConfig);
  assert.equal(tauriConfig.plugins.updater.endpoints[0], "https://yulab-smu.top/Rho/updates/tauri/stable.json");
  assert.match(tauriConfig.plugins.updater.pubkey, /^[A-Za-z0-9+/=]+$/);
  assert.equal(JSON.parse(value.windowsTauriConfig).bundle.createUpdaterArtifacts, true);
  assert.equal(JSON.parse(value.macosTauriConfig).bundle.createUpdaterArtifacts, true);
  assert.equal(JSON.parse(value.linuxTauriConfig).bundle.createUpdaterArtifacts, true);

  assert.match(value.updateDesign, /Update discovery is manual-only/i);
  assert.match(value.updateDesign, /Startup does not schedule or perform an update request/i);
  assert.match(value.autoSpec, /checks the selected channel automatically/i);
  assert.match(value.autoSpec, /Linux x86-64/);
  assert.doesNotMatch(value.updateDesign, /once-per-24-hours background check/i);
  assert.match(value.docsIndex, /plans\/active-2026-08-11-signpath-application-readiness-spec\.md/);
  assert.match(value.docsIndex, /design\/accepted-2026-07-25-about-and-update-check-design\.md/);
  assert.doesNotMatch(value.docsIndex, /design\/active-2026-07-25-about-and-update-check-design\.md/);
  assert.match(value.activeSpec, /Status: active; SP-READY1 repository-readiness package/);
  assert.match(value.activeSpec, /organization-owner MFA\s+audit,[\s\S]{0,360}remain\s+open/);
  assert.match(value.checklist, /CPREL1A-CPREL1D/);
  assert.match(value.checklist, /Windows clean-profile human installation[\s\S]{0,180}`NOT RUN`/);
  assert.match(value.checklist, /enabled-Gatekeeper human macOS launch[\s\S]{0,120}`NOT RUN`/);
  assert.match(value.checklist, /Free Trial self-signed test certificate/i);
  assert.match(value.checklist, /Release decision[\s\S]{0,100}`status: conditional`[\s\S]{0,80}`decision: CONDITIONAL_GO`/i);
  assert.match(value.news, /Update checks are now user-initiated only/i);

  for (const constant of ["PRIVACY_POLICY", "SECURITY_POLICY", "CODE_SIGNING_POLICY", "LICENSE_URL", "SIGNPATH_IO", "SIGNPATH_FOUNDATION"]) {
    assert.match(value.generator, new RegExp(`const ${constant} =`));
  }
  assert.equal(occurrences(value.generator, />Code signing policy<\/a>/g), 3, "generated page disclosure, footer, and self-test must require Code signing policy");
  assert.match(value.generator, /SignPath Free Trial self-signed test certificate/);
  assert.match(value.generator, /not publicly trusted; Windows or SmartScreen may still warn/);
  assert.match(value.generator, /does not establish Foundation acceptance/);
  assert.match(value.generator, /generated page omitted Code signing policy/);
  assert.equal(occurrences(value.generator, /<h2>Windows code-signing status<\/h2>/g), 2, "generated page and its self-test must disclose exact Windows trust status");
  assert.match(value.generator, /Rho is applying to SignPath Foundation for publicly trusted Windows code signing/);
  assert.match(value.generator, /Windows trust status is shown per release/);
  assert.match(value.generator, /generated page omitted SignPath Foundation attribution link/);
  assert.equal(occurrences(value.generator, /<h2>Uninstall Rho<\/h2>/g), 2, "generated page and its self-test must require Uninstall Rho guidance");
  assert.equal(occurrences(value.generator, /Settings &gt; Apps &gt; Installed apps/g), 2, "generated page and its self-test must require Windows uninstall guidance");
  assert.match(value.generator, /generated page omitted uninstall instructions/);

  assert.equal(occurrences(value.compatibilityWorkflow, /node scripts\/test-signpath-readiness\.mjs --self-test/g), 1);
  assert.equal(occurrences(value.compatibilityWorkflow, /node scripts\/test-signpath-readiness\.mjs(?:\s|$)/g), 2);
  for (const trigger of [
    "PRIVACY.md",
    "SECURITY.md",
    "CODE_SIGNING_POLICY.md",
    ".github/CODEOWNERS",
    "README.md",
    "NEWS.md",
    "scripts/test-signpath-readiness.mjs",
    "docs/design/accepted-2026-07-25-about-and-update-check-design.md",
    "docs/README.md",
    "docs/plans/active-2026-08-11-signpath-application-readiness-spec.md",
    "docs/plans/active-2026-08-13-dev38-test-signed-prerelease-spec.md",
    "docs/plans/implemented-2026-08-13-conditional-prerelease-policy-spec.md",
    "docs/release/historical-0.4.0-dev.39-candidate-checklist.md",
  ]) {
    assert.equal(occurrences(value.compatibilityWorkflow, new RegExp(`- "${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")), 2, `${trigger} must trigger push and PR validation`);
  }
}

function expectRejected(base, name, mutate, pattern) {
  const changed = structuredClone(base);
  mutate(changed);
  assert.throws(() => validate(changed), pattern, `${name} must fail closed`);
}

const current = snapshot();
validate(current);

if (process.argv.includes("--self-test")) {
  expectRejected(current, "missing attribution", (value) => {
    value.signing = value.signing.replace("Free code signing provided by [SignPath.io](https://about.signpath.io)", "Signing provider attribution unavailable");
  }, /Free code signing/);
  expectRejected(current, "periodic update scheduler", (value) => {
    value.frontend += "\nsetInterval(() => checkForUpdates(), 1000);\n";
  }, /setInterval/);
  expectRejected(current, "missing manual update entry", (value) => {
    value.frontend = value.frontend.replace('"check-updates": () => openUpdateDialog()', '"check-updates": () => {}');
  }, /check-updates/);
  expectRejected(current, "missing policy owner", (value) => {
    value.owners = value.owners.replaceAll("@xiayh17", "");
  }, /xiayh17/);
  expectRejected(current, "missing public policy link", (value) => {
    value.generator = value.generator.replaceAll(">Code signing policy</a>", ">Signing information</a>");
  }, /Code signing policy/);
  expectRejected(current, "false Windows signing claim", (value) => {
    value.signing += "\nWindows downloads are Authenticode-signed.\n";
  }, /unsigned Windows status must not be overstated/);
  expectRejected(current, "missing README uninstall guidance", (value) => {
    value.readme = value.readme.replace("## Uninstallation", "## Removal notes");
  }, /Uninstallation/);
  expectRejected(current, "missing download-page uninstall guidance", (value) => {
    value.generator = value.generator.replace("<h2>Uninstall Rho</h2>", "<h2>Remove Rho</h2>");
  }, /Uninstall Rho/);
  expectRejected(current, "missing download-page SignPath disclosure", (value) => {
    value.generator = value.generator.replace("<h2>Windows code-signing status</h2>", "<h2>Windows trust</h2>");
  }, /exact Windows trust status/);
}

process.stdout.write(`SignPath readiness contract is valid${process.argv.includes("--self-test") ? " (negative self-tests passed)" : ""}.\n`);
