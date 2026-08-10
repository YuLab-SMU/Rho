import assert from "node:assert/strict";
import fs from "node:fs";

const normalizeLineEndings = (text) => text.replace(/\r\n/g, "\n");
const read = (file) => normalizeLineEndings(fs.readFileSync(file, "utf8"));
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const expectedVersion = "0.4.0-dev.27";
const expectedVersionPattern = escapeRegExp(expectedVersion);
const cargo = read("Cargo.toml");
const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
assert.equal(cargoVersion, expectedVersion, "Cargo candidate version must be synchronized");
assert.equal(JSON.parse(read("desktop/src-tauri/tauri.conf.json")).version, expectedVersion);
assert.equal(JSON.parse(read("desktop/package.json")).version, expectedVersion);
const packageLock = JSON.parse(read("desktop/package-lock.json"));
assert.equal(packageLock.version, expectedVersion);
assert.equal(packageLock.packages[""].version, expectedVersion);
assert.match(read("desktop/dist/index.html"), new RegExp(`styles\\.css\\?v=${expectedVersionPattern}`));
assert.match(read("desktop/dist/index.html"), new RegExp(`app\\.js\\?v=${expectedVersionPattern}`));
assert.ok(
  count(read("desktop/dist/app.js"), new RegExp(expectedVersionPattern, "g")) >= 3,
  "Mock identity must be synchronized",
);

const localPackagePattern = /name = "rho-[^"]+"\r?\nversion = "([^"]+)"/g;
assert.deepEqual(
  [...'name = "rho-fixture"\r\nversion = "0.4.0-dev.27"'.matchAll(localPackagePattern)].map((match) => match[1]),
  [expectedVersion],
  "Cargo.lock parsing must accept Windows CRLF checkouts",
);
const lockLocalVersions = [...read("Cargo.lock").matchAll(localPackagePattern)].map((match) => match[1]);
assert.ok(lockLocalVersions.length >= 9, "Expected local Rho workspace packages in Cargo.lock");
assert.ok(lockLocalVersions.every((version) => version === expectedVersion), "Cargo.lock local package versions must match the candidate");

const build = read(".github/workflows/candidate-build-draft.yml");
const buildModePattern = /build_mode:\n[\s\S]*?default: rehearsal\n[\s\S]*?type: choice\n[\s\S]*?- rehearsal\n[\s\S]*?- candidate/;
const crlfBuildModeFixture = [
  "build_mode:",
  "  default: rehearsal",
  "  type: choice",
  "  options:",
  "    - rehearsal",
  "    - candidate",
].join("\r\n");
assert.match(
  normalizeLineEndings(crlfBuildModeFixture),
  buildModePattern,
  "Workflow contract parsing must accept Windows CRLF checkouts",
);
assert.match(build, /name: Build Rho Candidate \/ Rehearsal/);
assert.match(build, buildModePattern);
assert.match(build, new RegExp(`release_tag:\\n[\\s\\S]*?default: v${expectedVersionPattern}`));
assert.match(build, new RegExp(`release_name:\\n[\\s\\S]*?default: Rho ${expectedVersionPattern}`));
assert.match(build, /candidate-release\.mjs --mode admission --build_mode "\$BUILD_MODE" --repository "\$GITHUB_REPOSITORY" --workflow_ref "\$GITHUB_REF" --default_branch "\$DEFAULT_BRANCH"/);
assert.match(build, /commit="\$\(git rev-parse "\$\{INPUT_REF\}\^\{commit\}"\)"/);
assert.match(build, /Requested commit \$commit is not the current default-branch commit \$default_commit/);
assert.equal(count(build, /persist-credentials: false/g), 7, "Every candidate checkout must avoid persisted Git credentials");
assert.match(build, /runs-on: macos-26\b/);
assert.doesNotMatch(build, /macos-26-arm64/);
assert.match(build, /DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/);
assert.match(build, /--bundles app,dmg/);
assert.match(build, /test "\$\(xcodebuild -version \| sed -n '1p'\)" = "Xcode 26\.6"/);
for (const secret of [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "KEYCHAIN_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_PRIVATE_KEY",
]) assert.match(build, new RegExp(`secrets\\.${secret}\\b`), `Missing ${secret} secret interface`);
assert.doesNotMatch(build, /secrets\.APPLE_API_KEY_PATH/);
assert.match(build, /APPLE_API_KEY_PATH=\$api_key_path/);
assert.doesNotMatch(build, /security import[^\n]+ -A(?: |$)/);
assert.match(build, /security import[^\n]+ -T \/usr\/bin\/codesign/);
assert.match(build, /if: always\(\)/);
assert.match(build, /security delete-keychain "\$keychain_path"/);
assert.doesNotMatch(build, /security delete-keychain[^\n]+\|\| true/);
assert.match(build, /api_key_path="\$RUNNER_TEMP\/rho-notary-api-key\.p8"/);
assert.match(build, /rm -f [^\n]+ "\$api_key_path"/);
assert.match(build, /test ! -e "\$keychain_path"/);
for (const command of [
  "codesign --verify --deep --strict --verbose=4",
  "xcrun notarytool submit",
  "xcrun stapler validate",
  "spctl --assess --type execute",
  "spctl --assess --type open",
]) assert.ok(build.includes(command), `Missing macOS release gate: ${command}`);
assert.doesNotMatch(build, /xcrun notarytool history/);
assert.match(build, /env -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH npx/);
assert.match(build, /require_exact_arm64 "Rho app executable"/);
assert.match(build, /require_exact_arm64 "Bundled Ark executable"/);
assert.equal(
  count(build, /require_exact_library_validation_entitlement "(?:Rho app executable|Bundled Ark executable)"/g),
  4,
  "Submission and mounted-finalizer app/Ark signatures must prove the exact entitlement set",
);
assert.match(build, /codesign -d --entitlements - --xml "\$binary_path"/);
assert.match(build, /plutil -convert json -o "\$json_path" "\$plist_path"/);
assert.match(build, /node scripts\/validate-macos-entitlements\.mjs "\$json_path"/);
assert.match(
  build,
  /--checks [^\n]*arm64,codesign,entitlements,notarization,notary_binding,staple,gatekeeper/,
  "The candidate evidence must record entitlement and immutable notarization binding independently",
);

const macSubmitJob = build.match(/\n  macos-submit:[\s\S]*?(?=\n  macos-notary-wait:)/)?.[0];
const macWaitJob = build.match(/\n  macos-notary-wait:[\s\S]*?(?=\n  macos-finalize:)/)?.[0];
const macFinalizeJob = build.match(/\n  macos-finalize:[\s\S]*?(?=\n  rehearsal-evidence:)/)?.[0];
assert.ok(macSubmitJob && macWaitJob && macFinalizeJob, "Missing asynchronous macOS notarization jobs");
assert.match(macSubmitJob, /runs-on: macos-26\n\s+timeout-minutes: 60/);
assert.match(macSubmitJob, /xcrun notarytool submit "\$submitted_dmg"[^\n]+ --no-wait --output-format json/);
assert.doesNotMatch(macSubmitJob, /notarytool submit[^\n]+ --wait(?: |$)/);
assert.equal(count(build, /xcrun notarytool submit/g), 1, "The exact final DMG must be submitted once");
assert.match(macSubmitJob, /macos-notary\.mjs submission/);
assert.match(macSubmitJob, /rho-notary-submission-\$\{\{ needs\.identity\.outputs\.version \}\}-\$\{\{ github\.run_id \}\}/);
const entitlementValidationIndex = macSubmitJob.indexOf('require_exact_library_validation_entitlement "Rho app executable"');
const dmgSubmitIndex = macSubmitJob.indexOf('xcrun notarytool submit "$submitted_dmg"');
const cleanupIndex = macSubmitJob.indexOf("Remove temporary Apple credentials before artifact handoff");
const submissionUploadIndex = macSubmitJob.indexOf("Upload immutable unstapled DMG and pending request");
assert.ok(
  entitlementValidationIndex >= 0
    && entitlementValidationIndex < dmgSubmitIndex
    && dmgSubmitIndex < cleanupIndex
    && cleanupIndex < submissionUploadIndex,
  "Entitlement validation, one submission, credential cleanup, and immutable handoff must stay ordered",
);
assert.match(macSubmitJob, /echo "RHO_SIGNING_KEYCHAIN="/);
assert.match(macSubmitJob, /echo "APPLE_API_KEY_PATH="/);
assert.match(macSubmitJob, /api_key_path="\$\{APPLE_API_KEY_PATH:-\$RUNNER_TEMP\/rho-notary-api-key\.p8\}"/);
assert.equal(count(macSubmitJob, /secrets\.APPLE_API_KEY\b/g), 2, "Cleanup must not receive the API key ID secret");

assert.match(macWaitJob, /runs-on: ubuntu-latest/);
assert.match(macWaitJob, /timeout-minutes: 350/);
assert.match(macWaitJob, /macos-notary\.mjs wait/);
assert.match(macWaitJob, /--poll-interval-ms 120000 --max-wait-ms 19800000/);
assert.match(macWaitJob, /rho-notary-acceptance-\$\{\{ needs\.identity\.outputs\.version \}\}-\$\{\{ github\.run_id \}\}/);
for (const secret of ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY"]) {
  assert.match(macWaitJob, new RegExp(`secrets\\.${secret}\\b`), `Waiter is missing ${secret}`);
}
for (const secret of ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "KEYCHAIN_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_TEAM_ID"]) {
  assert.doesNotMatch(macWaitJob, new RegExp(`secrets\\.${secret}\\b`), `Waiter must not receive ${secret}`);
}
assert.doesNotMatch(macWaitJob, /notarytool|APPLE_API_KEY_PATH|contents: write/);

assert.match(macFinalizeJob, /runs-on: macos-26\n\s+timeout-minutes: 60/);
assert.doesNotMatch(macFinalizeJob, /secrets\.|notarytool submit/);
assert.match(macFinalizeJob, /Install exact Workspace smoke runtime dependency/);
assert.match(macFinalizeJob, /read\.dcf\('r\/rho\.bridge\/DESCRIPTION'\)/);
assert.match(macFinalizeJob, /identical\(non_base, 'jsonlite'\)/);
assert.match(macFinalizeJob, /install\.packages\('jsonlite'\)/);
assert.doesNotMatch(macFinalizeJob, /remotes::install_deps|rho\.agent/);
assert.match(macFinalizeJob, /macos-notary\.mjs verify/);
assert.match(macFinalizeJob, /xcrun stapler staple "\$dmg_path"/);
assert.match(macFinalizeJob, /hdiutil attach "\$dmg_path" -nobrowse -readonly -mountpoint "\$mount_point"/);
assert.match(macFinalizeJob, /app_path="\$mount_point\/Rho\.app"/);
const finalVerifyIndex = macFinalizeJob.indexOf("macos-notary.mjs verify");
const finalDependencyIndex = macFinalizeJob.indexOf("Install exact Workspace smoke runtime dependency");
const dmgStapleIndex = macFinalizeJob.indexOf('xcrun stapler staple "$dmg_path"');
const finalGatekeeperIndex = macFinalizeJob.indexOf("spctl --assess --type execute");
const finalSmokeIndex = macFinalizeJob.indexOf('"$app_path/Contents/MacOS/rho-desktop" --smoke-test');
assert.ok(
  finalDependencyIndex >= 0
    && finalDependencyIndex < finalVerifyIndex
    && finalVerifyIndex < dmgStapleIndex
    && dmgStapleIndex < finalGatekeeperIndex
    && finalGatekeeperIndex < finalSmokeIndex,
  "Immutable binding, staple, mounted Gatekeeper, and Workspace smoke must stay ordered",
);
const bridgeDescription = read("r/rho.bridge/DESCRIPTION");
const imports = bridgeDescription.match(/Imports:\n((?:    .+\n?)+)/)?.[1]
  ?.split(",")
  .map((value) => value.trim().split(/\s+/)[0])
  .filter(Boolean);
assert.deepEqual(imports?.filter((name) => !["methods", "utils"].includes(name)).sort(), ["jsonlite"]);
assert.match(build, /needs: \[identity, windows-candidate, macos-finalize\]/g);
assert.doesNotMatch(build, /macos-candidate/);

const entitlementValidator = read("scripts/validate-macos-entitlements.mjs");
assert.match(entitlementValidator, /MAX_MACOS_ENTITLEMENTS_BYTES = 4 \* 1024/);
assert.match(entitlementValidator, /com\.apple\.security\.cs\.disable-library-validation/);
assert.match(entitlementValidator, /keys\.length !== 1/);
const notaryContract = read("scripts/macos-notary.mjs");
assert.match(notaryContract, /NOTARY_API_ORIGIN = "https:\/\/appstoreconnect\.apple\.com"/);
assert.match(notaryContract, /"Accepted", "In Progress", "Invalid", "Rejected"/);
assert.match(notaryContract, /alg: "ES256"/);
assert.match(notaryContract, /aud: "appstoreconnect-v1"/);
assert.match(notaryContract, /MAX_NOTARY_LOG_BYTES = 1024 \* 1024/);
assert.match(notaryContract, /dsaEncoding: "ieee-p1363"/);
assert.match(notaryContract, /EXACT_DEVELOPER_LOG_HOSTS = new Set\(\["notary-artifacts-prod\.s3\.amazonaws\.com"\]\)/);
assert.match(
  read(".github/workflows/candidate-publish.yml"),
  new RegExp(`default: v${expectedVersionPattern}`),
);
assert.match(build, /draft: true/);
assert.match(build, /prerelease: true/);
assert.match(build, /getReleaseByTag/);
assert.match(build, /git\.getRef/);
assert.doesNotMatch(build, /deleteReleaseAsset/);
assert.equal(count(build, /uploadReleaseAsset/g), 1, "Only the draft assembly loop may upload release assets");
assert.equal(count(build, /contents: write/g), 1, "Only candidate draft assembly may request contents write");
assert.equal(count(build, /overwrite: true/g), 2, "Only the two final platform artifacts may be replaced on a rerun");
assert.equal(count(build, /pattern: rho-\$\{\{ needs\.identity\.outputs\.version \}\}-\*-\$\{\{ github\.run_id \}\}/g), 2);
assert.match(build, /name: rho-\$\{\{ needs\.identity\.outputs\.version \}\}-windows-x86-64-\$\{\{ github\.run_id \}\}/);
assert.match(build, /name: rho-\$\{\{ needs\.identity\.outputs\.version \}\}-macos-arm64-\$\{\{ github\.run_id \}\}/);
assert.equal(count(build, /name: rho-notary-(?:submission|acceptance)-\$\{\{ needs\.identity\.outputs\.version \}\}-\$\{\{ github\.run_id \}\}/g), 5);
assert.doesNotMatch(build, /name: rho-notary-(?:submission|acceptance)[\s\S]{0,300}overwrite: true/);
assert.equal(count(build, /needs: \[identity, windows-candidate, macos-finalize\]/g), 2);

const rehearsalJob = build.match(/\n  rehearsal-evidence:[\s\S]*?(?=\n  draft-candidate:)/)?.[0];
assert.ok(rehearsalJob, "Missing rehearsal evidence job");
assert.match(rehearsalJob, /needs\.identity\.outputs\.build_mode == 'rehearsal'/);
assert.match(rehearsalJob, /github\.repository == 'YuLab-SMU\/Rho_for_mac'/);
assert.match(rehearsalJob, /permissions:\n\s+contents: read/);
assert.match(rehearsalJob, /candidate-release\.mjs --mode rehearsal/);
assert.match(rehearsalJob, /unlinkSync/);
assert.doesNotMatch(rehearsalJob, /contents: write|createRelease|uploadReleaseAsset|getReleaseByTag|git\.getRef/);
const rehearsalUpload = rehearsalJob.match(/- name: Upload exact review-only rehearsal artifact[\s\S]*$/)?.[0];
assert.ok(rehearsalUpload, "Missing rehearsal artifact upload");
assert.equal(count(rehearsalUpload, /^\s+target\/candidate\//gm), 7, "Rehearsal artifact must contain exactly seven files");
assert.match(rehearsalUpload, /rho-\$\{\{ needs\.identity\.outputs\.version \}\}-rehearsal-evidence\.json/);
assert.match(rehearsalUpload, /github\.run_id/);
assert.match(rehearsalUpload, /github\.run_attempt/);
assert.doesNotMatch(rehearsalUpload, /candidate-evidence\.json/);
assert.match(rehearsalUpload, /retention-days: 14/);

const draftJob = build.match(/\n  draft-candidate:[\s\S]*$/)?.[0];
assert.ok(draftJob, "Missing candidate draft job");
assert.match(draftJob, /needs\.identity\.outputs\.build_mode == 'candidate'/);
assert.match(draftJob, /github\.repository == 'YuLab-SMU\/Rho'/);
assert.match(draftJob, /permissions:\n\s+contents: write/);

const candidateTool = read("scripts/candidate-release.mjs");
assert.match(candidateTool, /rho_candidate_rehearsal_evidence/);
assert.match(candidateTool, /REHEARSAL_REPOSITORY = "YuLab-SMU\/Rho_for_mac"/);
assert.match(candidateTool, /CANDIDATE_REPOSITORY = "YuLab-SMU\/Rho"/);
assert.match(candidateTool, /validateBuildAdmission/);
assert.match(candidateTool, /Rehearsal evidence exceeds its byte budget/);
assert.match(candidateTool, /"notary_binding"/);

const publish = read(".github/workflows/candidate-publish.yml");
assert.match(publish, /environment: rho-release/);
const publishIdentity = publish.match(/- name: Resolve immutable draft identity[\s\S]*?- name: Check out the exact draft contract/)?.[0];
assert.ok(publishIdentity, "Missing immutable draft identity step");
assert.match(publishIdentity, /github\.paginate\(github\.rest\.repos\.listReleases/);
assert.match(publishIdentity, /matches\.length !== 1/);
assert.match(publishIdentity, /core\.setOutput\("release_id", String\(release\.id\)\)/);
assert.doesNotMatch(publish, /getReleaseByTag/);
const publishDownload = publish.match(/- name: Download draft assets and assemble publish record[\s\S]*?- name: Enforce immutable candidate and explicit MAC5 GO/)?.[0];
assert.ok(publishDownload, "Missing immutable draft download step");
assert.match(publishDownload, /RELEASE_ID: \$\{\{ steps\.identity\.outputs\.release_id \}\}/);
assert.match(publishDownload, /getRelease\(\{ owner, repo, release_id: releaseId \}\)/);
assert.match(publishDownload, /release\.data\.tag_name !== process\.env\.RELEASE_TAG/);
assert.match(publish, /candidate-release\.mjs --mode publish/);
assert.match(publish, /256 \* 1024/);
assert.match(publish, /publish-release-snapshot\.json/);
assert.match(publish, /Draft identity or assets changed after content validation/);
assert.match(publish, /rho-\$\{version\}-acceptance\.json/);
assert.match(publish, /draft: false/);
assert.match(publish, /prerelease: true/);
assert.doesNotMatch(publish, /uploadReleaseAsset|deleteReleaseAsset|createRelease/);
assert.equal(count(publish, /updateRelease/g), 1, "Publish workflow may perform one release state transition");

const pages = read(".github/workflows/update-site-publish.yml");
assert.match(pages, /"Publish Rho Candidate"/);
assert.match(pages, /rho-\$\{version\}-candidate-evidence\.json/);
assert.match(pages, /target_commitish: release\.target_commitish/);
assert.match(pages, /artifacts\.macos_aarch64/);
assert.match(pages, /Platform evidence content mismatch/);

const update = read("desktop/src-tauri/src/update.rs");
assert.match(update, /macos_aarch64: Option<UpdateArtifact>/);
assert.match(update, /if let Some\(artifact\) = &manifest\.artifacts\.macos_aarch64/);
assert.match(update, /UPDATE_PLATFORM_UNAVAILABLE/);
assert.match(read("desktop/dist/app.js"), /This release does not include an installer for this Mac yet\./);
const generator = read("scripts/generate-update-site.mjs");
assert.match(generator, /validateAggregateEvidence/);
assert.match(generator, /Download for macOS \(Apple Silicon\)/);
assert.match(generator, /candidate platforms/);

process.stdout.write("MAC4 release contract tests passed.\n");
