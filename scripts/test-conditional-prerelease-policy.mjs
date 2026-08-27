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

assert.doesNotMatch(build, /default:\s*v0\.4\.0/);
assert.doesNotMatch(build, /default:\s*Rho 0\.4\.0/);
assert.match(build, /fs\.readFileSync\("Cargo\.toml", "utf8"\)/);
assert.match(build, /release_tag="v\$version"/);
assert.match(build, /release_name="Rho \$version"/);
assert.doesNotMatch(publish, /default:\s*v0\.4\.0/);
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

process.stdout.write("Conditional prerelease policy tests passed.\n");
