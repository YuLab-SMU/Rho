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
    checklist: read("docs/release/active-0.4.0-dev.37-candidate-checklist.md"),
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
  assert.match(value.signing, /Free code signing provided by \[SignPath\.io\]\(https:\/\/about\.signpath\.io\),\s+certificate by \[SignPath Foundation\]\(https:\/\/signpath\.org\)/);
  assert.match(value.signing, /Windows downloads are currently not Authenticode-signed/i);
  assert.doesNotMatch(value.signing, /Windows downloads are Authenticode-signed/i, "unsigned Windows status must not be overstated");
  assert.match(value.signing, /rho-desktop\.exe/);
  assert.match(value.signing, /NSIS/i);
  for (const excluded of ["Ark", "Jet", "WebView2Loader"]) assert.match(value.signing, new RegExp(excluded));
  assert.match(value.signing, /manual approval[^.]*every signing request/i);
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
  assert.match(value.docsIndex, /design\/accepted-2026-07-25-about-and-update-check-design\.md/);
  assert.doesNotMatch(value.docsIndex, /design\/active-2026-07-25-about-and-update-check-design\.md/);
  assert.match(value.activeSpec, /Status: active; SP-READY1 repository-readiness package/);
  assert.match(value.activeSpec, /organization-owner MFA\s+audit,[\s\S]{0,360}remain\s+open/);
  assert.match(value.checklist, /SP-READY1 SignPath repository readiness/);
  assert.match(value.checklist, /owner MFA audit,[\s\S]{0,420}remain\s+open/i);
  assert.match(value.news, /Update checks are now user-initiated only/i);

  for (const constant of ["PRIVACY_POLICY", "SECURITY_POLICY", "CODE_SIGNING_POLICY", "LICENSE_URL", "SIGNPATH_IO", "SIGNPATH_FOUNDATION"]) {
    assert.match(value.generator, new RegExp(`const ${constant} =`));
  }
  assert.equal(occurrences(value.generator, />Code signing policy<\/a>/g), 3, "generated page disclosure, footer, and self-test must require Code signing policy");
  assert.match(value.generator, /Windows downloads are currently not Authenticode-signed/);
  assert.match(value.generator, /generated page omitted Code signing policy/);
  assert.equal(occurrences(value.generator, /<h2>Windows code-signing application<\/h2>/g), 2, "generated page and its self-test must disclose the pending SignPath application");
  assert.match(value.generator, /Rho is applying to SignPath Foundation for Windows code signing/);
  assert.match(value.generator, /Current Windows downloads are not Authenticode-signed/);
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
  expectRejected(current, "false Windows signing claim", (value) => {
    value.signing = value.signing.replace("Windows downloads are currently not Authenticode-signed", "Windows downloads are Authenticode-signed");
  }, /currently not Authenticode-signed/);
  expectRejected(current, "missing README uninstall guidance", (value) => {
    value.readme = value.readme.replace("## Uninstallation", "## Removal notes");
  }, /Uninstallation/);
  expectRejected(current, "missing download-page uninstall guidance", (value) => {
    value.generator = value.generator.replace("<h2>Uninstall Rho</h2>", "<h2>Remove Rho</h2>");
  }, /Uninstall Rho/);
  expectRejected(current, "missing download-page SignPath disclosure", (value) => {
    value.generator = value.generator.replace("<h2>Windows code-signing application</h2>", "<h2>Windows trust</h2>");
  }, /pending SignPath application/);
}

process.stdout.write(`SignPath readiness contract is valid${process.argv.includes("--self-test") ? " (negative self-tests passed)" : ""}.\n`);
