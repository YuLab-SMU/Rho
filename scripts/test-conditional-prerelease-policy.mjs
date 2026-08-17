import assert from "node:assert/strict";
import fs from "node:fs";

const normalize = (value) => value.replace(/\r\n?/g, "\n");
const read = (file) => normalize(fs.readFileSync(file, "utf8"));
const occurrences = (value, pattern) => [...value.matchAll(pattern)].length;

const candidate = read("scripts/candidate-release.mjs");
const build = read(".github/workflows/candidate-build-draft.yml");
const publish = read(".github/workflows/candidate-publish.yml");
const updateWorkflow = read(".github/workflows/update-site-publish.yml");
const generator = read("scripts/generate-update-site.mjs");
const notes = read(".github/release-notes/v0.4.0-dev.39.md");
const oldNotes = read(".github/release-notes/v0.4.0-dev.38.md");
const spec = read("docs/plans/implemented-2026-08-13-conditional-prerelease-policy-spec.md");
const checklist = read("docs/release/historical-0.4.0-dev.39-candidate-checklist.md");
const crossReview = read("docs/project/active-document-cross-review.md");

assert.match(spec, /Status: implemented; CPREL1A-CPREL1D completed/);
assert.match(spec, /does not make either\s+missing observation pass/);
assert.match(spec, /fresh `dev\.39` identity/);
assert.match(checklist, /Status: historical published conditional prerelease record/);
assert.match(checklist, /immutable limitations, not passed checks/);
assert.match(crossReview, /schema-v2 actor-bound `CONDITIONAL_GO`/);

assert.equal(
  occurrences(candidate, /CONDITIONAL_ACCEPTANCE_VERSIONS = new Set\(\["0\.4\.0-dev\.39"\]\)/g),
  1,
  "Conditional publication must remain allowlisted to exactly dev.39",
);
for (const value of [
  'status !== "conditional"',
  'decision !== "CONDITIONAL_GO"',
  'scope !== "public_prerelease_only"',
  "windows_human_install_not_run",
  "macos_gatekeeper_human_launch_not_run",
  "no_windows_device",
  "gatekeeper_assessments_disabled",
  "authorized_by !== publisher",
  "createConditionalAcceptanceEvidence",
  'args.mode === "conditional-acceptance"',
]) assert.match(candidate, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

assert.match(build, /default: v0\.4\.0-dev\.43/);
assert.match(build, /default: Rho 0\.4\.0-dev\.43/);
assert.match(publish, /default: v0\.4\.0-dev\.43/);
assert.match(publish, /PUBLISH_ACTOR: \$\{\{ github\.actor \}\}/);
assert.match(publish, /publisher: process\.env\.PUBLISH_ACTOR/);
assert.match(publish, /Enforce immutable candidate and explicit release decision/);
assert.equal(occurrences(publish, /updateRelease/g), 1, "Publication must remain one state transition");

assert.match(updateWorkflow, /rho-\$\{version\}-acceptance\.json/);
assert.match(updateWorkflow, /Candidate acceptance asset is missing or exceeds its byte budget/);
assert.match(updateWorkflow, /evidence_sha256: evidenceSha256/);
assert.match(generator, /validateAcceptanceEvidence/);
assert.match(generator, /Conditional prerelease:/);
assert.match(generator, /Automated candidate checks passed, but this build is for evaluation only/);

assert.match(notes, /^Rho 0\.4\.0-dev\.39 is a conditional evaluation prerelease/m);
assert.match(notes, /Windows clean-profile human installation[\s\S]*were not run/);
assert.match(notes, /Enabled-Gatekeeper macOS human launch was not run/);
assert.match(notes, /CONDITIONAL_GO/);
assert.match(oldNotes, /Publication remains gated by exact installed Windows and macOS acceptance/);

process.stdout.write("Conditional prerelease policy tests passed.\n");
