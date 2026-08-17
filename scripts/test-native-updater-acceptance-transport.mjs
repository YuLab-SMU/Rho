import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
const count = (text, pattern) => [...text.matchAll(pattern)].length;

const transport = read("scripts/native-updater-acceptance.mjs");
const target = read(".github/workflows/native-updater-acceptance-target.yml");
const window = read(".github/workflows/native-updater-acceptance-window.yml");
const pages = read(".github/workflows/update-site-publish.yml");
const build = read(".github/workflows/candidate-build-draft.yml");
const publish = read(".github/workflows/candidate-publish.yml");
const checklist = read("docs/release/active-0.4.0-dev.41-native-updater-acceptance-target-checklist.md");
const spec = read("docs/plans/active-2026-08-15-tauri-native-updater-spec.md");
const notes = read(".github/release-notes/v0.4.0-dev.41.md");

assert.match(transport, /ACCEPTANCE_SOURCE_VERSION = "0\.4\.0-dev\.40"/);
assert.match(transport, /ACCEPTANCE_TARGET_VERSION = "0\.4\.0-dev\.41"/);
assert.match(transport, /ACCEPTANCE_SOURCE_COMMIT = "14b16ced90df02621e37913e23c6a555cf5963f0"/);
assert.match(transport, /MAX_ACCEPTANCE_WINDOW_MINUTES = 45/);
assert.match(transport, /validatePublicAcceptanceTarget/);
assert.match(transport, /validateAcceptanceSourceDraft/);
assert.match(transport, /validateAcceptancePair/);
assert.match(transport, /mutatedNativeUpdaterSignature/);
assert.match(transport, /assertNoActiveFixture/);
assert.match(transport, /recoverExpiredFixture/);
assert.match(transport, /removeFixtureOrAssertAbsent/);
assert.match(transport, /Recovery cleanup refuses to remove a fixture before its recorded expiry/);
assert.match(transport, /if \(process\.argv\[1\].*fileURLToPath\(import\.meta\.url\)\) runCli\(\)/);

assert.match(target, /^name: Publish Native Updater Acceptance Target/m);
assert.match(target, /workflow_dispatch:/);
assert.doesNotMatch(target, /workflow_run:/);
assert.match(target, /environment: rho-release/);
assert.equal(count(target, /environment: rho-release/g), 1, "Only the target state transition may require release approval");
assert.match(target, /v0\.4\.0-dev\.40/);
assert.match(target, /14b16ced90df02621e37913e23c6a555cf5963f0/);
assert.match(target, /Rho 0\.4\.0-dev\.41 Native Updater Acceptance Target/);
assert.match(target, /native-updater-acceptance\.mjs --mode create-target-marker/);
assert.match(target, /native-updater-acceptance\.mjs --mode validate-acceptance-pair/);
assert.equal(count(target, /uploadReleaseAsset/g), 1, "Only the bound target marker may be uploaded");
assert.equal(count(target, /updateRelease/g), 1, "Only one target Draft-to-public state transition is permitted");
assert.match(target, /draft: false, prerelease: true/);
assert.match(target, /rho-updater-verifier/g);
assert.doesNotMatch(target, /candidate-publish\.yml|Publish Rho Candidate|update-site-publish\.yml/);
assert.match(target, /updates\/tauri\/\$channel\.json/);
assert.match(target, /--range 0-0/);
assert.match(target, /test \"\$status\" = "404"/);
assert.doesNotMatch(target, /html_url: release\.html_url/);
assert.equal(
  count(target, /html_url: `https:\/\/github\.com\/\$\{owner\}\/\$\{repo\}\/releases\/tag\/\$\{release\.tag_name\}`/g),
  2,
  "Both target-workflow release snapshots must normalize Draft URLs from the validated tag",
);

assert.match(window, /^name: Run Native Updater Acceptance Window/m);
assert.match(window, /operation:[\s\S]*?- window[\s\S]*?- recover_cleanup/);
assert.match(window, /fixture_mode:[\s\S]*?- signature_rejection[\s\S]*?- valid/);
assert.match(window, /\^\(\[1-9\]\|\[1-3\]\[0-9\]\|4\[0-5\]\)\$/);
assert.match(window, /group: rho-update-site/);
assert.match(window, /cancel-in-progress: false/);
assert.equal(count(window, /environment: rho-release/g), 1, "Only fixture activation may request release approval");
assert.match(window, /if: \$\{\{ always\(\) && inputs\.operation == 'window' && needs\.activate\.outputs\.fixture_ready == 'true' \}\}/);
assert.match(window, /--mode remove-fixture/);
assert.match(window, /--mode remove-fixture-or-assert-absent/);
assert.match(window, /--mode recover-expired-fixture/);
assert.match(window, /--mode validate-acceptance-pair/);
assert.match(window, /id: fixture_armed/);
assert.match(window, /does not verify against the configured public key/);
assert.match(window, /target\/fixture\/signatures\/windows-x86_64\.sig/);
assert.doesNotMatch(window, /target\/fixture\/signatures\/windows-x86-64\.sig/);
assert.match(window, /\[\[ "\$status" == "404" \]\]/);
assert.doesNotMatch(window, /TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY_PASSWORD|APPLE_API_|SIGNPATH_/);
assert.doesNotMatch(window, /html_url: release\.html_url/);
assert.equal(
  count(window, /html_url: `https:\/\/github\.com\/\$\{owner\}\/\$\{repo\}\/releases\/tag\/\$\{release\.tag_name\}`/g),
  1,
  "The bounded-window release snapshot must normalize the source Draft URL from its validated tag",
);

assert.match(pages, /group: rho-update-site\n\s+cancel-in-progress: false/);
assert.match(pages, /assert-no-active-fixture/);
assert.match(pages, /rho-0\.4\.0-dev\.41-native-updater-acceptance-target\.json/);
assert.match(pages, /validate-public-target/);
assert.match(pages, /Native updater acceptance target marker is invalid/);
assert.match(pages, /The public dev\.41 native updater acceptance target is missing its required exclusion marker/);
assert.match(pages, /continue;/);

assert.match(build, /default: v0\.4\.0-dev\.42/);
assert.match(build, /default: Rho 0\.4\.0-dev\.42/);
assert.match(build, /expected_release_name="Rho 0\.4\.0-dev\.41 Native Updater Acceptance Target"/);
assert.match(build, /native-updater-acceptance\.mjs --test true/);
assert.match(publish, /dev\.41 native updater acceptance target may be published only by its dedicated protected workflow/);

assert.match(checklist, /The only permitted Draft mutation is the protected,/);
assert.match(checklist, /requested positive duration no greater than 45 minutes/);
assert.match(checklist, /manually dispatched recovery cleanup uses the same\s+exact-pair checks/);
assert.match(spec, /UPDATER-1C-T1/);
assert.match(notes, /^Rho 0\.4\.0-dev\.41 is an acceptance-only native updater target\./m);

execFileSync(process.execPath, ["scripts/native-updater-acceptance.mjs", "--test", "true"], { stdio: "inherit" });
console.log("Native updater acceptance transport contract tests passed.");
