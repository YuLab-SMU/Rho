// Checks that the candidate a release promotes is the one a CI run packed from this commit and
// installed on every platform it carries, then prints its tarball and npm dist-tag for
// $GITHUB_OUTPUT. Nothing is built or changed.
// Usage: node scripts/release-check.mjs CANDIDATE_DIR INSTALL_REPORTS_DIR
// Environment: GITHUB_SHA, CANDIDATE_RUN (the run that packed it), RELEASE_TAG (empty in a rehearsal).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

const [dir, reports] = process.argv.slice(2);
const { GITHUB_SHA: commit, CANDIDATE_RUN: run, RELEASE_TAG: tag } = process.env;
assert.ok(dir && reports && commit && run, 'usage: release-check.mjs CANDIDATE_DIR INSTALL_REPORTS_DIR, with GITHUB_SHA and CANDIDATE_RUN');
const sha256 = file => createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');

for (const line of fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [, digest, file] = line.match(/^([0-9a-f]{64}) [ *](.+)$/) ?? [];
  assert.ok(digest, 'SHA256SUMS line: ' + line);
  assert.equal(sha256(file), digest, file + ' matches SHA256SUMS');
}
const c = JSON.parse(fs.readFileSync(path.join(dir, 'composition.json'), 'utf8'));
const digest = sha256(c.artifact.filename);
assert.equal(c.artifact.sha256, digest, 'the composition names this tarball');
assert.equal(c.application.commit, commit, 'the candidate was packed from this commit');
assert.ok(c.build?.run?.endsWith('/actions/runs/' + run), `the candidate was packed by run ${run}, not ${c.build?.run}`);
assert.deepEqual(c.platforms, ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64']);
for (const platform of c.platforms) {
  const report = JSON.parse(fs.readFileSync(path.join(reports, `install-${platform}.json`), 'utf8'));
  assert.equal(report.passed, true, platform + ' installation passed');
  assert.equal(report.artifact.sha256, digest, platform + ' installed this tarball');
}
const m = JSON.parse(execFileSync('tar', ['-xOzf', path.join(dir, c.artifact.filename), 'package/package.json'], { encoding: 'utf8' }));
assert.equal(m.name, '@rho-workspace/rho'); assert.equal(m.private, undefined);
if (tag) assert.equal('v' + m.version, tag, 'the tag names this version');
console.error(`${c.artifact.filename} ${digest}: commit ${commit}, run ${run}, installed on ${c.platforms.join(', ')}`);
console.log('tarball=' + c.artifact.filename);
console.log('version=' + m.version);
console.log('dist-tag=' + (m.version.includes('-') ? 'next' : 'latest'));
