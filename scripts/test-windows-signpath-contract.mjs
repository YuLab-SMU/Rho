import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

const trial = {
  organizationId: "0b1b9db7-5b44-46d3-abff-faaae8ad587e",
  projectSlug: "rho",
  policySlug: "test-signing",
  artifactConfigurationSlug: "github-actions-nsis-installer",
  thumbprint: "74C895CBF9759AE1041A61F54F3B3BC6B0446511",
};

function block(text, start, end) {
  const result = text.match(new RegExp(end ? `${start}[\\s\\S]*?(?=${end})` : `${start}[\\s\\S]*$`));
  assert.ok(result, `Missing workflow block ${start}`);
  return result[0];
}

function assertSigningAction(value, label) {
  assert.match(value, /uses: signpath\/github-action-submit-signing-request@v2/, `${label} must use the SignPath v2 action`);
  assert.match(value, /api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/, `${label} must use only the protected token interface`);
  assert.match(value, new RegExp(`organization-id: ${trial.organizationId}`), `${label} organization ID drifted`);
  assert.match(value, new RegExp(`project-slug: ${trial.projectSlug}`), `${label} project slug drifted`);
  assert.match(value, new RegExp(`signing-policy-slug: ${trial.policySlug}`), `${label} policy slug drifted`);
  assert.match(value, new RegExp(`artifact-configuration-slug: ${trial.artifactConfigurationSlug}`), `${label} must name the ZIP configuration explicitly`);
  assert.match(value, /github-artifact-id: \$\{\{ steps\.upload_unsigned_installer\.outputs\.artifact-id \}\}/, `${label} must bind its own uploaded artifact ID`);
  assert.match(value, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, `${label} must provide the GitHub read token`);
  assert.match(value, /wait-for-completion: true/, `${label} must await the returned bytes`);
  assert.match(value, /wait-for-completion-timeout-in-seconds: 1800/, `${label} must bound SignPath waiting`);
  assert.match(value, /output-artifact-directory: target\/signpath-signed/, `${label} must stage returned bytes separately`);
}

function assertReturnedInstallerGate(value, label) {
  assert.match(value, /Get-ChildItem -LiteralPath "target\\signpath-signed" -Recurse -File -Filter \$expected/, `${label} must search only SignPath output`);
  assert.match(value, /\$matches\.Count -ne 1/, `${label} must reject zero or multiple returned installers`);
  assert.match(value, /Get-AuthenticodeSignature -LiteralPath \$matches\[0\]\.FullName/, `${label} must inspect returned bytes`);
  assert.match(value, /-not \$signature\.SignerCertificate/, `${label} must reject a missing signer`);
  assert.match(value, /SignatureStatus\]::NotSigned/, `${label} must reject NotSigned`);
  assert.match(value, new RegExp(trial.thumbprint), `${label} must bind the expected trial certificate`);
  assert.match(value, /Copy-Item -LiteralPath \$matches\[0\]\.FullName/, `${label} must replace the unsigned candidate with returned bytes`);
}

function assertContract({ candidate, manual, checks }) {
  const windowsCandidate = block(candidate, "\\n  windows-candidate:", "\\n  macos-submit:");
  assert.match(windowsCandidate, /permissions:\n\s+actions: read\n\s+contents: read/, "candidate signing token needs only Actions/content read permissions");
  const candidateAction = block(windowsCandidate, "- name: Sign Windows installer with the configured SignPath trial policy", "- name: Stage exactly one returned self-signed installer");
  assert.match(candidateAction, /if: needs\.identity\.outputs\.build_mode == 'candidate' && github\.repository == 'YuLab-SMU\/Rho'/, "candidate signing must be upstream-candidate-only");
  assertSigningAction(candidateAction, "candidate");
  const candidateStage = block(windowsCandidate, "- name: Stage exactly one returned self-signed installer", "- name: Create Windows platform evidence");
  assert.match(candidateStage, /if: needs\.identity\.outputs\.build_mode == 'candidate' && github\.repository == 'YuLab-SMU\/Rho'/, "candidate staging must be upstream-candidate-only");
  assertReturnedInstallerGate(candidateStage, "candidate");
  assert.ok(windowsCandidate.indexOf("Stage exactly one returned self-signed installer") < windowsCandidate.indexOf("Create Windows platform evidence"), "candidate evidence must follow signed-byte staging");
  const rehearsal = block(candidate, "\\n  rehearsal-evidence:", "\\n  draft-candidate:");
  assert.doesNotMatch(rehearsal, /SIGNPATH_API_TOKEN|github-action-submit-signing-request|signpath-signed/, "rehearsals must never receive trial signing authority");

  assert.match(manual, /^permissions:\n\s+actions: read\n\s+contents: write/m, "manual workflow needs Actions read and Release write permissions");
  const manualJob = block(manual, "\\n  publish-windows:");
  assert.match(manualJob, /if: github\.repository == 'YuLab-SMU\/Rho'/, "manual publishing must be upstream-only");
  assert.match(manualJob, /persist-credentials: false/, "manual checkout must not persist a write-capable token");
  assert.match(manualJob, /Manual release must use current upstream default-branch head/, "manual publishing must bind the current default-branch head");
  const preSign = block(manualJob, "- name: Verify source, build unsigned installer and run release smoke tests", "- name: Upload unsigned Windows installer for SignPath");
  assert.match(preSign, /BuildInstaller = \$true/, "pre-sign step must build the installer");
  assert.match(preSign, /SkipEvidence = \$true/, "pre-sign step must not create releasable evidence from unsigned bytes");
  const manualUpload = block(manualJob, "- name: Upload unsigned Windows installer for SignPath", "- name: Sign Windows installer with the configured SignPath trial policy");
  assert.match(manualUpload, /path: \$\{\{ steps\.pre_sign_checks\.outputs\.installer_path \}\}/, "manual signing must upload only the pre-sign installer output");
  const manualAction = block(manualJob, "- name: Sign Windows installer with the configured SignPath trial policy", "- name: Stage exactly one returned self-signed installer");
  assertSigningAction(manualAction, "manual");
  const manualStage = block(manualJob, "- name: Stage exactly one returned self-signed installer", "- name: Record release evidence from the returned signed installer");
  assertReturnedInstallerGate(manualStage, "manual");
  const finalEvidence = block(manualJob, "- name: Record release evidence from the returned signed installer", "- name: Create GitHub release");
  assert.match(finalEvidence, /InstallerPath = "\$\{\{ steps\.stage_signed_installer\.outputs\.installer_path \}\}"/, "final evidence must consume only staged returned bytes");
  assert.match(finalEvidence, /RequireAuthenticodeSignature = \$true/, "final evidence must enforce signer presence");
  assert.ok(manualJob.indexOf("Record release evidence from the returned signed installer") < manualJob.indexOf("Create GitHub release"), "Release creation must follow signed-byte evidence");
  assert.doesNotMatch(manual, /updateRelease|deleteReleaseAsset/, "manual release assets must remain immutable");

  assert.match(checks, /\[string\]\$InstallerPath/, "release checker must accept an explicitly staged installer");
  assert.match(checks, /\[switch\]\$RequireAuthenticodeSignature/, "release checker must expose signer-presence gate");
  assert.match(checks, /\[switch\]\$SkipEvidence/, "pre-sign checker must be able to avoid unsigned evidence");
  assert.match(checks, /Use either -BuildInstaller or -InstallerPath, not both\./, "release checker must reject ambiguous artifact selection");
  assert.match(checks, /RequireAuthenticodeSignature requires -BuildInstaller or -InstallerPath\./, "release checker must reject an unbound signature assertion");
  assert.match(checks, /Get-AuthenticodeSignature -LiteralPath \$Path/, "release checker must inspect supplied final bytes");
  assert.match(checks, /Installer signer thumbprint does not match the configured Rho Test Signing certificate\./, "release checker must reject unexpected signer certificates");
  assert.match(checks, /if \(-not \$SkipEvidence\)/, "unsigned pre-sign stage must not emit release evidence");
}

const current = {
  candidate: read(".github/workflows/candidate-build-draft.yml"),
  manual: read(".github/workflows/windows-manual-publish.yml"),
  checks: read("scripts/invoke-0.2-release-checks.ps1"),
};
assertContract(current);

for (const [name, mutate, pattern] of [
  ["candidate token", (value) => ({ ...value, candidate: value.candidate.replace("SIGNPATH_API_TOKEN", "SIGNPATH_TOKEN_MISSING") }), /protected token interface/],
  ["artifact configuration", (value) => ({ ...value, candidate: value.candidate.replace("artifact-configuration-slug: github-actions-nsis-installer", "") }), /ZIP configuration/],
  ["returned cardinality", (value) => ({ ...value, manual: value.manual.replace("$matches.Count -ne 1", "$matches.Count -lt 1") }), /zero or multiple/],
  ["not-signed rejection", (value) => ({ ...value, manual: value.manual.replace("SignatureStatus]::NotSigned", "SignatureStatus]::UnknownError") }), /NotSigned/],
  ["final signed evidence", (value) => ({ ...value, manual: value.manual.replace("RequireAuthenticodeSignature = $true", "") }), /signer presence/],
]) {
  assert.throws(() => assertContract(mutate(current)), pattern, `${name} regression must fail closed`);
}

process.stdout.write("Windows SignPath trial signing workflow contract tests passed.\n");
