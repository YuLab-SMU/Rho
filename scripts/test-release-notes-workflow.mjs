import assert from "node:assert/strict";
import fs from "node:fs";

const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");
const read = (file) => normalizeLineEndings(fs.readFileSync(file, "utf8"));
const count = (text, pattern) => [...text.matchAll(pattern)].length;

const build = read(".github/workflows/candidate-build-draft.yml");
const publish = read(".github/workflows/candidate-publish.yml");
const updateSite = read(".github/workflows/update-site-publish.yml");
const metadata = read("scripts/test-release-metadata.ps1");
const readme = read(".github/release-notes/README.md");

assert.match(readme, /\.github\/release-notes\/v<version>\.md/);
assert.match(readme, /first line is a short plain-text summary/i);

const identity = build.match(/- name: Validate candidate identity and contract tools[\s\S]*?(?=\n  windows-candidate:)/)?.[0];
assert.ok(identity, "Missing candidate identity job");
assert.match(identity, /node scripts\/release-notes\.mjs --test true/);
assert.match(identity, /if \[\[ "\$BUILD_MODE" == "candidate" \]\]/);
assert.match(identity, /release-notes\.mjs --mode validate --version "\$version" --tag "\$release_tag"/);

const draft = build.match(/\n  draft-candidate:[\s\S]*$/)?.[0];
assert.ok(draft, "Missing candidate Draft job");
const prepareIndex = draft.indexOf("Prepare reviewed release notes from the exact candidate commit");
const createIndex = draft.indexOf("Create single-use draft and upload assets once");
assert.ok(prepareIndex >= 0 && prepareIndex < createIndex, "Release notes must be prepared before Draft creation");
assert.match(draft, /release-notes\.mjs --mode prepare/);
assert.match(draft, /validateReleaseNotesRecord/);
assert.match(draft, /body: releaseNotes\.body/);
assert.match(draft, /checked\.data\.tag_name !== process\.env\.CANDIDATE_TAG/);
assert.match(draft, /checked\.data\.name !== process\.env\.CANDIDATE_NAME/);
assert.match(draft, /checked\.data\.body !== releaseNotes\.body/);
assert.doesNotMatch(draft, /body: `Immutable cross-platform candidate/);
assert.equal(count(draft, /uploadReleaseAsset/g), 1, "Release notes must not expand the candidate asset upload loop");

const publishDownload = publish.match(/- name: Download draft assets and assemble publish record[\s\S]*?- name: Enforce immutable candidate and explicit release decision/)?.[0];
assert.ok(publishDownload, "Missing candidate publish admission step");
assert.match(publishDownload, /loadReleaseNotes/);
assert.match(publishDownload, /requireExactReleaseBody/);
assert.match(publishDownload, /releaseTag: process\.env\.RELEASE_TAG/);
assert.doesNotMatch(publishDownload, /367934137|v0\.4\.0-dev\.27|const legacy|fs\.existsSync\(releaseNotesPath\)/);
assert.match(publishDownload, /body_sha256: releaseBodySha256/);
assert.match(publishDownload, /publisher: process\.env\.PUBLISH_ACTOR/);

const publishTransition = publish.match(/- name: Publish without rebuilding or changing assets[\s\S]*$/)?.[0];
assert.ok(publishTransition, "Missing candidate publication transition");
assert.match(publishTransition, /snapshot\.body_sha256 !== beforeBodySha256/);
assert.match(publishTransition, /afterBodySha256 !== snapshot\.body_sha256/);
assert.match(publishTransition, /after\.data\.tag_name !== snapshot\.tag_name/);
assert.match(publishTransition, /after\.data\.target_commitish !== snapshot\.target_commitish/);
assert.match(publishTransition, /reviewed body/);
assert.equal(count(publishTransition, /updateRelease/g), 1, "Publication must retain one state transition");
assert.doesNotMatch(publishTransition, /body:/, "Publication must not rewrite the reviewed body");

assert.match(
  updateSite,
  /summary: String\(release\.body \|\| ""\)\.split\("\\n"\)\.find\(\(line\) => line\.trim\(\)\)/,
  "Update Site must continue projecting the reviewed first non-empty body line as its summary",
);
assert.match(updateSite, /rho-\$\{version\}-acceptance\.json/);
assert.match(updateSite, /workflows: \["Publish Rho Candidate"\]/);
assert.doesNotMatch(updateSite, /Windows Manual Publish/);
assert.match(updateSite, /\["v0\.2\.0-dev\.12", \{ releaseId: 358099496, evidenceAsset: "rho-0\.2-release\.json" \}\]/);
assert.match(updateSite, /release\.id === legacy\.releaseId && release\.prerelease === true/);
assert.doesNotMatch(
  updateSite,
  /\|\| release\.assets\.find\(\(asset\) => asset\.name === "rho-0\.2-release\.json"\)/,
  "Legacy evidence must not remain a fallback for new releases",
);

assert.match(metadata, /\.github\\release-notes\\README\.md/);
assert.match(metadata, /scripts\\release-notes\.mjs/);
assert.match(metadata, /\.github\\release-notes\\\$ReleaseTag\.md/);

process.stdout.write("Versioned release notes workflow tests passed.\n");
