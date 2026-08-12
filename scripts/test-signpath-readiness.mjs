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
    updateDesign: read("docs/design/accepted-2026-07-25-about-and-update-check-design.md"),
    docsIndex: read("docs/README.md"),
    activeSpec: read("docs/plans/active-2026-08-11-signpath-application-readiness-spec.md"),
    trialSpec: read("docs/plans/active-2026-08-12-signpath-trial-signing-spec.md"),
    checklist: read("docs/release/active-0.4.0-dev.33-candidate-checklist.md"),
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
  assert.match(value.privacy, /only after you choose\s+\*\*Help > Check for Updates\.\.\.\*\*/);
  assert.match(value.privacy, /operating system\s+credential store/i);
  assert.match(value.privacy, /custom Base URL/i);
  assert.match(value.privacy, /Crossref/i);
  assert.match(value.privacy, /uninstalling Rho does not\s+necessarily remove/i);
  assert.match(value.privacy, /security\/advisories\/new/);

  assert.match(value.signing, /^# Rho Code Signing Policy$/m);
  assert.match(value.signing, /self-signed test certificate,\s+`Rho Test Signing`,\s+managed through \[SignPath\.io\]\(https:\/\/about\.signpath\.io\)/);
  assert.match(value.signing, /not a publicly trusted\s+Windows publisher identity/i);
  assert.match(value.signing, /Historical Windows packages are unsigned/i);
  assert.match(value.signing, /does not trust that certificate by\s+default/i);
  assert.match(value.signing, /rho-desktop\.exe/);
  assert.match(value.signing, /NSIS/i);
  for (const excluded of ["Ark", "Jet", "WebView2Loader"]) assert.match(value.signing, new RegExp(excluded));
  assert.match(value.signing, /Only the final Rho NSIS installer[\s\S]{0,180}unsigned `rho-desktop\.exe`/i);
  assert.match(value.signing, /does not require separate manual approval/i);
  assert.match(value.signing, /Get-AuthenticodeSignature/);
  assert.match(value.signing, /missing signer or\s+`NotSigned` result fails closed/i);
  assert.match(value.signing, /SmartScreen/i);
  assert.match(value.signing, /pull request[\s\S]{0,120}rehearsal[\s\S]{0,120}fail closed/i);
  assert.doesNotMatch(value.signing, /certificate by \[SignPath Foundation\]/i, "trial policy must not claim a Foundation certificate");
  assert.doesNotMatch(value.signing, /^## Two-stage Windows procedure$/m, "trial policy must not present the Foundation two-stage procedure as current");

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
  ]) assert.match(value.owners, new RegExp(protectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const link of ["PRIVACY.md", "SECURITY.md", "CODE_SIGNING_POLICY.md", "LICENSE"]) {
    assert.match(value.readme, new RegExp(`\\]\\(${link.replace(".", "\\.")}\\)`), `README must link ${link}`);
  }
  assert.match(value.readme, /Code signing policy/);
  assert.match(value.readme, /does not perform automatic update checks/i);
  assert.match(value.readme, /^## Uninstallation$/m);
  assert.match(value.readme, /Settings > Apps > Installed apps/);
  assert.match(value.readme, /move \*\*Rho\.app\*\* from \*\*Applications\*\* to the\s+Trash/i);
  assert.match(value.readme, /Uninstalling the application does not automatically delete project files/i);
  assert.match(value.readme, /Historical Windows downloads are unsigned/i);
  assert.match(value.readme, /self-signed `Rho Test Signing` certificate/i);
  assert.match(value.readme, /not trusted by Windows or Microsoft\s+SmartScreen/i);

  assert.match(value.html, /data-menu-command="check-updates"/);
  assert.match(value.frontend, /"check-updates": \(\) => openUpdateDialog\(\)/);
  assert.match(value.frontend, /function openUpdateDialog\(\) \{\s*(?:void )?checkForUpdates\(\);\s*\}/);
  assert.match(value.frontend, /\$\("#updateRetry"\)\.addEventListener\("click", \(\) => checkForUpdates\(\)\)/);
  assert.equal(occurrences(value.frontend, /invoke\("check_for_updates"\)/g), 1, "one manual frontend path must own update invocation");
  assert.doesNotMatch(value.frontend, /maybeCheckForUpdates/);
  assert.doesNotMatch(value.frontend, /checkForUpdates\(\{\s*background\s*:/);
  assert.doesNotMatch(value.frontend, /rho\.update\.(?:lastCheck|dismissed)/);
  assert.doesNotMatch(value.frontend, /async function checkForUpdates\([^)]*background/);
  assert.match(value.updateBackend, /pub const WEBSITE_URL: &str = "https:\/\/yulab-smu\.top\/Rho\/"/);
  assert.match(value.updateBackend, /Duration::from_secs\(10\)/);
  assert.match(value.updateBackend, /const MAX_MANIFEST_BYTES: u64 = 64 \* 1024/);

  assert.match(value.updateDesign, /Update discovery is manual-only/i);
  assert.match(value.updateDesign, /Startup does not schedule or perform an update request/i);
  assert.doesNotMatch(value.updateDesign, /once-per-24-hours background check/i);
  assert.match(value.docsIndex, /plans\/active-2026-08-11-signpath-application-readiness-spec\.md/);
  assert.match(value.docsIndex, /plans\/active-2026-08-12-signpath-trial-signing-spec\.md/);
  assert.match(value.docsIndex, /design\/accepted-2026-07-25-about-and-update-check-design\.md/);
  assert.doesNotMatch(value.docsIndex, /design\/active-2026-07-25-about-and-update-check-design\.md/);
  assert.match(value.activeSpec, /Status: active; SP-READY1 repository-readiness package/);
  assert.match(value.activeSpec, /2026-08-12 Trial-Signing Amendment/);
  assert.match(value.activeSpec, /active-2026-08-12-signpath-trial-signing-spec\.md/);
  assert.match(value.trialSpec, /Status: active; STS1 implementation package authorized/);
  assert.match(value.trialSpec, /SIGNPATH_API_TOKEN/);
  assert.match(value.trialSpec, /self-signed code-signing certificate named `Rho Test Signing`/);
  assert.match(value.trialSpec, /does not make the signer a verified publisher or remove SmartScreen\s+warnings/i);
  assert.match(value.trialSpec, /only the outer NSIS installer/i);
  assert.match(value.checklist, /SP-READY1 SignPath repository readiness/);
  assert.match(value.checklist, /STS1 SignPath trial signing/);
  assert.match(value.news, /Update checks are now user-initiated only/i);

  for (const constant of ["PRIVACY_POLICY", "SECURITY_POLICY", "CODE_SIGNING_POLICY", "LICENSE_URL", "SIGNPATH_IO"]) {
    assert.match(value.generator, new RegExp(`const ${constant} =`));
  }
  assert.equal(occurrences(value.generator, />Code signing policy<\/a>/g), 3, "generated page disclosure, footer, and self-test must require Code signing policy");
  assert.match(value.generator, /Historical Windows downloads are unsigned/);
  assert.match(value.generator, /generated page omitted Code signing policy/);
  assert.equal(occurrences(value.generator, /<h2>Windows code-signing status<\/h2>/g), 2, "generated page and its self-test must disclose trial signing status");
  assert.match(value.generator, /self-signed <strong>Rho Test Signing<\/strong>/);
  assert.match(value.generator, /not trusted by Windows or Microsoft SmartScreen/);
  assert.doesNotMatch(value.generator, /SignPath Foundation/);
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
    "scripts/test-windows-signpath-contract.mjs",
    ".github/workflows/windows-manual-publish.yml",
    "scripts/invoke-0.2-release-checks.ps1",
    "docs/design/accepted-2026-07-25-about-and-update-check-design.md",
    "docs/README.md",
    "docs/plans/active-2026-08-11-signpath-application-readiness-spec.md",
    "docs/plans/active-2026-08-12-signpath-trial-signing-spec.md",
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
    value.signing = value.signing.replace("[SignPath.io](https://about.signpath.io)", "Signing provider attribution unavailable");
  }, /SignPath\\.io/);
  expectRejected(current, "background update scheduler", (value) => {
    value.frontend += "\nfunction maybeCheckForUpdates() { checkForUpdates({ background: true }); }\n";
  }, /maybeCheckForUpdates/);
  expectRejected(current, "missing manual update entry", (value) => {
    value.frontend = value.frontend.replace('"check-updates": () => openUpdateDialog()', '"check-updates": () => {}');
  }, /check-updates/);
  expectRejected(current, "missing policy owner", (value) => {
    value.owners = value.owners.replaceAll("@xiayh17", "");
  }, /xiayh17/);
  expectRejected(current, "missing public policy link", (value) => {
    value.generator = value.generator.replaceAll(">Code signing policy</a>", ">Signing information</a>");
  }, /Code signing policy/);
  expectRejected(current, "missing self-signed trust boundary", (value) => {
    value.signing = value.signing.replace("not a publicly trusted\nWindows publisher identity", "publicly trusted Windows publisher identity");
  }, /not a publicly trusted/);
  expectRejected(current, "missing README uninstall guidance", (value) => {
    value.readme = value.readme.replace("## Uninstallation", "## Removal notes");
  }, /Uninstallation/);
  expectRejected(current, "missing download-page uninstall guidance", (value) => {
    value.generator = value.generator.replace("<h2>Uninstall Rho</h2>", "<h2>Remove Rho</h2>");
  }, /Uninstall Rho/);
  expectRejected(current, "missing download-page SignPath disclosure", (value) => {
    value.generator = value.generator.replace("<h2>Windows code-signing status</h2>", "<h2>Windows trust</h2>");
  }, /trial signing status/);
}

process.stdout.write(`SignPath readiness contract is valid${process.argv.includes("--self-test") ? " (negative self-tests passed)" : ""}.\n`);
