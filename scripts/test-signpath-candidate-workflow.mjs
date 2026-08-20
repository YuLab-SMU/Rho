import assert from "node:assert/strict";
import fs from "node:fs";

const normalize = (value) => value.replace(/\r\n?/g, "\n");
const read = (file) => normalize(fs.readFileSync(file, "utf8"));
const occurrences = (value, pattern) => [...value.matchAll(pattern)].length;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function snapshot() {
  return {
    workflow: read(".github/workflows/candidate-build-draft.yml"),
    buildScript: read("scripts/build-windows-installer.ps1"),
    bundleType: read("scripts/tauri-bundle-type.mjs"),
    candidate: read("scripts/candidate-release.mjs"),
    generator: read("scripts/generate-update-site.mjs"),
    policy: read("CODE_SIGNING_POLICY.md"),
    spec: read("docs/plans/active-2026-08-17-signpath-free-trial-two-stage-dev42-spec.md"),
    checklist: read("docs/release/active-0.4.0-dev.42-two-stage-signing-checklist.md"),
    compatibility: read(".github/workflows/rust-compatibility.yml"),
  };
}

function step(job, label, nextLabel) {
  const end = nextLabel ? `(?=\\n      - name: ${escape(nextLabel)})` : "(?=\\n      - name:|$)";
  return job.match(new RegExp(`- name: ${escape(label)}[\\s\\S]*?${end}`))?.[0];
}

function validate(value) {
  const windows = value.workflow.match(/\n  windows-candidate:[\s\S]*?(?=\n  macos-submit:)/)?.[0];
  const rehearsal = value.workflow.match(/\n  rehearsal-evidence:[\s\S]*?(?=\n  draft-candidate:)/)?.[0];
  const draft = value.workflow.match(/\n  draft-candidate:[\s\S]*$/)?.[0];
  assert.ok(windows, "Windows candidate job is missing");
  assert.ok(rehearsal, "Rehearsal aggregation job is missing");
  assert.ok(draft, "Candidate Draft job is missing");

  const orderedSteps = [
    "Run complete Windows candidate validation",
    "Build and smoke-test unsigned Windows executable",
    "Patch unsigned Windows executable for exact NSIS bundle type",
    "Load protected SignPath deployment configuration",
    "Verify and isolate exact unsigned Windows executable",
    "Prepare fixed official SignPath module",
    "Submit exact Windows executable through official SignPath REST module",
    "Verify and promote returned test-signed Windows executable",
    "Bundle NSIS without rebuilding signed Windows executable",
    "Verify signed executable survival and isolate unsigned Windows installer",
    "Submit exact Windows installer through official SignPath REST module",
    "Verify and promote returned test-signed Windows installer",
    "Sign final Authenticode Windows updater artifact",
    "Install and verify signed Windows payload",
    "Clear SignPath deployment values before evidence handoff",
    "Create Windows platform evidence",
    "Upload immutable Windows candidate inputs",
  ];
  let previous = -1;
  for (const label of orderedSteps) {
    const index = windows.indexOf(label);
    assert.ok(index > previous, `${label} must occur in the fail-closed candidate order`);
    previous = index;
  }

  for (const label of orderedSteps.slice(2, 15)) {
    const currentStep = step(windows, label);
    assert.ok(currentStep, `Missing candidate-only step ${label}`);
    assert.match(currentStep, /if: \$\{\{ (?:always\(\) && )?needs\.identity\.outputs\.build_mode == 'candidate' \}\}/);
  }

  const build = step(windows, orderedSteps[1]);
  assert.ok(build);
  assert.match(build, /-BuildMode NoBundle/);
  assert.match(build, /Get-AuthenticodeSignature[\s\S]*Status -ne "NotSigned"/);
  assert.match(build, /rho-desktop\.exe/);
  assert.doesNotMatch(build, /target\\candidate\\Rho_/);

  const patchStep = step(windows, orderedSteps[2], orderedSteps[3]);
  assert.ok(patchStep);
  assert.match(patchStep, /tauri-bundle-type\.mjs --mode patch --file \$binary/);
  assert.match(patchStep, /NSIS-patched Windows Workspace smoke failed/);
  assert.match(patchStep, /Status -ne "NotSigned"/);

  const config = step(windows, orderedSteps[3], orderedSteps[4]);
  assert.ok(config);
  for (const key of [
    "SIGNPATH_ORGANIZATION_ID",
    "SIGNPATH_PROJECT_SLUG",
    "SIGNPATH_SIGNING_POLICY_SLUG",
    "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG",
    "SIGNPATH_CERTIFICATE_THUMBPRINT",
  ]) assert.match(config, new RegExp(key));
  assert.match(config, /SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG: \$\{\{ secrets\.SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.match(config, /SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG[\s\S]*blank or multiline/);
  assert.match(config, /SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG[\s\S]*invalid slug/);
  assert.match(config, /SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG[\s\S]*must differ from the installer/);
  assert.match(config, /Compare-Object[^\n]*\$required/);
  assert.match(config, /::add-mask::\$value[\s\S]*GITHUB_ENV/);
  assert.match(config, /unexpected key set/);

  assert.equal(
    occurrences(windows, /SIGNPATH_API_TOKEN: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/g),
    2,
    "API token must be scoped only to the two signing requests",
  );
  assert.doesNotMatch(windows.match(/\n    env:[\s\S]*?\n    steps:/)?.[0] || "", /SIGNPATH_API_TOKEN/);
  assert.equal(occurrences(windows, /Install-Module -Name SignPath/g), 1, "Pinned SignPath module must be installed once");
  assert.equal(occurrences(windows, /Submit-SigningRequest/g), 2, "Candidate must submit binary and installer independently");

  const binarySubmit = step(windows, orderedSteps[6], orderedSteps[7]);
  const installerSubmit = step(windows, orderedSteps[10], orderedSteps[11]);
  assert.ok(binarySubmit && installerSubmit);
  for (const submission of [binarySubmit, installerSubmit]) {
    for (const argument of [
      "-InputArtifactPath",
      "-ProjectSlug",
      "-SigningPolicySlug",
      "-ArtifactConfigurationSlug",
      "-WaitForCompletion",
      "-OutputArtifactPath",
      "-OrganizationId",
      "-ApiToken",
    ]) assert.match(submission, new RegExp(argument.replace(/-/g, "\\-")));
    assert.match(submission, /WaitForCompletionTimeoutInSeconds 900/);
    assert.match(submission, /UploadAndDownloadRequestTimeoutInSeconds 300/);
  }
  assert.match(binarySubmit, /ArtifactConfigurationSlug \$env:SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG/);
  assert.match(installerSubmit, /ArtifactConfigurationSlug \$env:SIGNPATH_ARTIFACT_CONFIGURATION_SLUG/);

  assert.equal(occurrences(windows, /4a732624a7214dc8290dbf81ed2714d6b509be319427c2d55fd0c679d13ab5ae/g), 1);
  assert.match(windows, /RHO_UNSIGNED_BINARY_SHA256/);
  assert.match(windows, /RHO_SIGNED_BINARY_SHA256/);
  assert.match(windows, /RHO_UNSIGNED_INSTALLER_SHA256/);
  assert.match(windows, /RHO_SIGNED_INSTALLER_SHA256/);
  assert.match(windows, /-BuildMode BundleOnly/);
  assert.match(windows, /Signed Windows executable changed while bundling NSIS/);
  assert.match(windows, /Status -ne "UnknownError"/);
  assert.match(windows, /SignerCertificate\.Thumbprint/);
  assert.match(windows, /SignerCertificate\.Subject -ne \$signature\.SignerCertificate\.Issuer/);
  assert.match(windows, /binary_request_id/);
  assert.match(windows, /installer_request_id/);
  assert.match(windows, /binary_bundled_sha256/);
  assert.match(windows, /installed_binary_sha256/);
  assert.match(windows, /installed_outside_workspace = \$true/);
  assert.match(windows, /cleanup_verified = \$true/);
  assert.match(windows, /installedHash -ne \$env:RHO_SIGNED_BINARY_SHA256/);
  assert.match(windows, /installed executable is inside the workspace/);
  assert.match(windows, /Get-AuthenticodeSignature -LiteralPath \$installedExecutable/);

  const finalSign = step(windows, orderedSteps[12], orderedSteps[13]);
  assert.ok(finalSign);
  assert.match(finalSign, /signer sign "\$artifact"/);
  assert.match(finalSign, /cargo run --locked -p rho-updater-verifier/);
  const install = step(windows, orderedSteps[13], orderedSteps[14]);
  assert.ok(install);
  assert.match(install, /Start-Process[\s\S]*\/S/);
  assert.match(install, /UninstallString/);
  assert.match(install, /cleanup/);

  const platform = step(windows, orderedSteps[15], orderedSteps[16]);
  assert.ok(platform);
  assert.match(platform, /CANDIDATE_MODE/);
  assert.match(platform, /authenticode_binary,authenticode_installer,installed_payload_signature,signpath_binary_request_binding,signpath_installer_request_binding,free_trial_self_signed/);
  assert.match(platform, /--signing/);
  assert.match(rehearsal, /--mode aggregate/);
  assert.doesNotMatch(rehearsal, /--require_windows_signing true/);
  assert.match(draft, /--require_windows_signing true/);

  assert.match(value.buildScript, /\[ValidateSet\("Full", "NoBundle", "BundleOnly"\)\]/);
  assert.match(value.buildScript, /\[string\]\$BuildMode = "Full"/);
  assert.match(value.buildScript, /"NoBundle"[\s\S]*--no-bundle/);
  assert.match(value.buildScript, /"BundleOnly"[\s\S]*"bundle"[\s\S]*"--bundles", "nsis"/);
  assert.match(value.buildScript, /Release executable changed during BundleOnly/);
  assert.match(value.buildScript, /NoBundle mode must not produce an installer/);
  assert.match(
    value.buildScript,
    /\$BuildMode -eq "Full"[\s\S]*Remove-Item -LiteralPath \$installerDirectory -Recurse -Force/,
  );
  assert.match(value.bundleType, /__TAURI_BUNDLE_TYPE_VAR_UNK/);
  assert.match(value.bundleType, /__TAURI_BUNDLE_TYPE_VAR_NSS/);
  assert.match(value.bundleType, /exactly one unknown bundle token/);
  assert.match(value.bundleType, /nsisIndexes\.length \+ 1/);
  assert.match(value.bundleType, /after\.length !== before\.length/);

  assert.match(value.candidate, /LEGACY_WINDOWS_SIGNING_CHECKS/);
  assert.match(value.candidate, /TWO_STAGE_WINDOWS_SIGNING_CHECKS/);
  assert.match(value.candidate, /TWO_STAGE_SIGNING_VERSIONS = new Set\(\["0\.4\.0-dev\.42", "0\.4\.0-dev\.43", "0\.4\.0"\]\)/);
  assert.match(value.candidate, /schema_version/);
  for (const field of [
    "binary_request_id",
    "binary_unsigned_sha256",
    "binary_signed_sha256",
    "binary_bundled_sha256",
    "installer_request_id",
    "installer_unsigned_sha256",
    "installer_signed_sha256",
    "installed_binary_sha256",
    "installed_signature_status",
    "installed_signer_thumbprint",
    "installed_outside_workspace",
    "cleanup_verified",
  ]) assert.match(value.candidate, new RegExp(field));
  assert.match(value.candidate, /Windows installed binary hash does not match the signed binary/);
  assert.match(value.candidate, /Windows binary hash changed during bundling/);
  assert.match(value.candidate, /Windows SignPath request IDs must be distinct/);
  assert.match(value.candidate, /UNSIGNED_CANDIDATE_COMPATIBILITY = new Set\(\["0\.4\.0-dev\.27"\]\)/);
  assert.match(value.candidate, /UNSIGNED_PUBLISHED_COMPATIBILITY = new Set\(\["0\.4\.0-dev\.24"\]\)/);

  assert.match(value.generator, /Windows trust: Authenticode-signed with a SignPath Free Trial self-signed test certificate/);
  assert.match(value.generator, /It is not publicly trusted; Windows or SmartScreen may still warn/);
  assert.match(value.generator, /does not establish Foundation acceptance/);
  assert.match(value.policy, /Free Trial test-signed prerelease boundary/);
  assert.match(value.policy, /not\s+publicly trusted/);
  assert.match(value.spec, /Status: active `SP-FT2-DEV42`/);
  assert.match(value.spec, /build --no-bundle/);
  assert.match(value.spec, /bundle --bundles nsis/);
  assert.match(value.checklist, /Current release decision: `NO_RELEASE_DECISION`/);

  assert.equal(occurrences(value.compatibility, /node scripts\/test-signpath-candidate-workflow\.mjs --self-test/g), 1);
  assert.equal(occurrences(value.compatibility, /node scripts\/test-signpath-candidate-workflow\.mjs(?:\s|$)/g), 2);
  for (const trigger of [
    "scripts/build-windows-installer.ps1",
    "scripts/tauri-bundle-type.mjs",
    "scripts/test-tauri-bundle-type.mjs",
    "scripts/test-signpath-candidate-workflow.mjs",
    "docs/plans/active-2026-08-17-signpath-free-trial-two-stage-dev42-spec.md",
    "docs/release/active-0.4.0-dev.42-two-stage-signing-checklist.md",
  ]) {
    assert.equal(
      occurrences(value.compatibility, new RegExp(`- "${escape(trigger)}"`, "g")),
      2,
      `${trigger} must trigger push and PR checks`,
    );
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
  expectRejected(current, "binary signing omission", (value) => {
    value.workflow = value.workflow.replace("Submit exact Windows executable through official SignPath REST module", "Skip Windows executable signing");
  }, /Submit exact Windows executable/);
  expectRejected(current, "token scope expansion", (value) => {
    value.workflow = value.workflow.replace(
      "    permissions:\n      contents: read\n    steps:\n      - name: Check out immutable candidate commit",
      "    permissions:\n      contents: read\n    env:\n      SIGNPATH_API_TOKEN: expanded\n    steps:\n      - name: Check out immutable candidate commit",
    );
  }, /SIGNPATH_API_TOKEN/);
  expectRejected(current, "binary config secret removal", (value) => {
    value.workflow = value.workflow.replace("SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG: ${{ secrets.SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG }}", "SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG: hard-coded");
  }, /SIGNPATH_BINARY_ARTIFACT_CONFIGURATION_SLUG/);
  expectRejected(current, "installed verification omission", (value) => {
    value.workflow = value.workflow.replace("Install and verify signed Windows payload", "Skip installed payload verification");
  }, /Install and verify/);
  expectRejected(current, "build mode contraction", (value) => {
    value.buildScript = value.buildScript.replace('"Full", "NoBundle", "BundleOnly"', '"Full"');
  }, /ValidateSet/);
  expectRejected(current, "false public trust", (value) => {
    value.generator = value.generator.replace("It is not publicly trusted; Windows or SmartScreen may still warn.", "It is publicly trusted.");
  }, /not publicly trusted/);
}

process.stdout.write(`SignPath two-stage candidate workflow contract is valid${process.argv.includes("--self-test") ? " (negative self-tests passed)" : ""}.\n`);
