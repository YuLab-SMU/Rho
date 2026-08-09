import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "desktop", "dist", "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");
const main = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "main.rs"), "utf8");
const review = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "git_review.rs"), "utf8");
const git = fs.readFileSync(path.join(root, "desktop", "src-tauri", "src", "git.rs"), "utf8");

assert.match(html, /data-context-tab="git"[\s\S]*id="gitPanel"/);
assert.match(html, /id="gitWorkingFiles"[\s\S]*id="gitStagedFiles"/);
assert.match(html, /id="gitDiffReview"[\s\S]*id="gitHunkList"/);
assert.match(html, /id="gitCommitMessage"[\s\S]*id="gitCommitButton"/);
assert.match(html, /id="gitRefreshButton"[^>]*aria-label="Refresh Git review"/);
assert.match(html, /app\.js\?v=0\.4\.0-dev\.26(?:&amp;|&)rev=m(?:1-shell|2-workbench|3-scientific-review-v3)/);

assert.match(css, /\.git-review-body\s*\{[^}]*overflow:\s*hidden/);
assert.match(css, /\.git-hunk-list\s*\{[^}]*overflow:\s*auto/);
assert.match(css, /\.git-diff-line\s*\{[^}]*min-width:\s*max-content/);
assert.match(
  css,
  /@media \(max-width: 960px\)[\s\S]*\.git-change-groups\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
  "Narrow Git review must stack file groups inside the context panel",
);
assert.match(
  css,
  /@media \(max-width: 960px\)[\s\S]*\.git-diff-header\s*\{[^}]*flex-direction:\s*column/,
  "Narrow Git review actions must not force horizontal page overflow",
);

for (const command of [
  "git_diff",
  "git_diff_unified",
  "git_stage",
  "git_unstage_file",
  "git_hunk_stage",
  "git_hunk_unstage",
  "git_restore_file",
  "git_staged_revision",
  "git_commit",
]) {
  assert.match(js, new RegExp(`"${command}"`), `Missing frontend/mock command ${command}`);
  assert.match(main, new RegExp(`async fn ${command}\\b`), `Missing Tauri command ${command}`);
}

assert.match(js, /function renderGitReview\(\)/);
assert.match(js, /function selectGitReviewFile\(path, staged\)/);
assert.match(js, /function confirmGitRestore\(diff\)/);
assert.match(js, /confirmLabel:\s*"Restore file"[\s\S]*cancelLabel:\s*"Keep changes"/);
assert.match(js, /filePath:\s*diff\.path, expectedRevision:\s*diff\.revision/);
assert.match(js, /filePath:\s*diff\.path, hunkIndex:\s*hunk\.index, expectedRevision:\s*diff\.revision/);
assert.match(js, /expectedStagedRevision:\s*state\.gitReview\.stagedRevision/);
assert.match(js, /invoke\("git_diff_unified", \{ filePath:\s*path, staged \}\)/);
assert.match(js, /invoke\("git_resolve_conflict", \{ filePath:\s*file, resolution:\s*res \}\)/);
assert.match(js, /scenario === "git-review"/);
assert.match(js, /seedMockGitReview\(\)/);
assert.match(js, /gitPreviewState === "stale"[\s\S]*mockGitRevisionSequence \+= 1/);
assert.match(js, /gitPreviewState === "failure"[\s\S]*mockGitFailureCommand = "git_diff"[\s\S]*mockGitFailureCommand = null/);
assert.doesNotMatch(js, /hunk_content\s*:/, "Frontend must never send raw patch content");
for (const staleArgument of ["file_path", "expected_revision", "hunk_index", "expected_staged_revision"]) {
  assert.doesNotMatch(
    js,
    new RegExp(`(?:args\\.${staleArgument}\\b|[,{]\\s*${staleArgument}\\s*:)`),
    `Frontend/mock must use the installed Tauri camelCase argument for ${staleArgument}`,
  );
}

assert.match(
  main,
  /async fn git_hunk_stage\([\s\S]*file_path: String,[\s\S]*hunk_index: usize,[\s\S]*expected_revision: String/,
);
assert.match(
  main,
  /async fn git_hunk_unstage\([\s\S]*file_path: String,[\s\S]*hunk_index: usize,[\s\S]*expected_revision: String/,
);
assert.doesNotMatch(main, /hunk_content:\s*String/, "Exposed Tauri handlers must not accept raw patches");

assert.match(review, /fn validate_repository\(project_root: &Path\)/);
assert.match(review, /fn validate_relative_path\(project_root: &Path, file_path: &str\)/);
assert.match(review, /fn validate_relative_path_at_root\([\s\S]*root: &Path/);
assert.match(review, /Git path contains a symlink or reparse point/);
assert.match(review, /\["write-tree"\]/);
assert.match(review, /fn repository_revision\(project_root: &Path\)/);
assert.match(review, /\["rev-parse", "--git-dir"\]/);
assert.match(review, /\["rev-parse", "--git-common-dir"\]/);
assert.match(review, /Sha256::digest\(value\.as_bytes\(\)\)/);
assert.match(review, /"repository\\0\{repository\}tree\\0/);
assert.match(review, /MAX_DIFF_BYTES:\s*usize\s*=\s*1024 \* 1024/);
assert.match(git, /pub fn run_git_bounded\(/);
assert.match(git, /String::from_utf8\(stdout\)/);
assert.match(review, /let diff = review_diff\(project_root, file_path, false\)\?/);
assert.match(review, /let diff = review_diff\(project_root, file_path, true\)\?/);
assert.match(review, /\["commit", "--no-verify", "-m", message\.trim\(\)\]/);
assert.match(review, /MAX_CHANGED_FILES:\s*usize\s*=\s*200/);
assert.match(review, /MAX_DIFF_HUNKS:\s*usize\s*=\s*128/);
assert.match(review, /MAX_DIFF_LINES:\s*usize\s*=\s*4_000/);

console.log("Git review UI and guarded-command contract checks passed.");
