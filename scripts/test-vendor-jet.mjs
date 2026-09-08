import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySeries,
  check,
  digest,
  extractArchive,
  files,
  loadManifest,
  prepare,
  reconstruct,
  upstreamDoc,
} from "./vendor-jet.mjs";

const revision = "a".repeat(40);
const upstreamCargo =
  '[package]\nname = "jet_core"\nversion.workspace = true\nedition.workspace = true\n';
const standaloneCargo =
  '[package]\nname = "jet_core"\nversion = "0.0.2"\nedition = "2024"\nlicense = "MIT"\npublish = false\n\n[workspace]\n';
const license =
  "Fixture copyright and permission notice; retained unchanged.\n";
const git = (cwd, args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      `core.attributesFile=${os.devNull}`,
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
function write(dir, name, value) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function archive(parent, rev, version = "0.0.2", symlink = false) {
  const folder = path.join(parent, `jet-${rev}`);
  fs.mkdirSync(folder, { recursive: true });
  write(
    folder,
    "Cargo.toml",
    `[workspace]\nmembers = ["crates/core"]\nresolver = "2"\n\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n`,
  );
  write(folder, "LICENSE", license);
  write(folder, "crates/core/Cargo.toml", upstreamCargo);
  write(folder, "crates/core/src/lib.rs", "pub const ANSWER: u8 = 41;\n");
  write(
    folder,
    "crates/cli/src/main.rs",
    'fn main() { panic!("must not be included") }\n',
  );
  if (symlink) {
    fs.unlinkSync(path.join(folder, "crates/core/src/lib.rs"));
    fs.symlinkSync(
      path.join(folder, "LICENSE"),
      path.join(folder, "crates/core/src/lib.rs"),
    );
  }
  const result = path.join(parent, `${rev}.tar.gz`);
  execFileSync("tar", ["-czf", result, "-C", parent, `jet-${rev}`]);
  return { result, folder };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-vendor-fixture-"));
  const { result, folder } = archive(root, revision);
  const generated = path.join(root, "vendor/jet-core");
  write(generated, "Cargo.toml", upstreamCargo);
  write(generated, "LICENSE", license);
  write(generated, "src/lib.rs", "pub const ANSWER: u8 = 41;\n");
  const inputs = files(generated);
  git(generated, ["init", "--quiet"]);
  git(generated, ["add", "--force", "--all"]);
  write(generated, "Cargo.toml", standaloneCargo);
  write(generated, "src/lib.rs", "pub const ANSWER: u8 = 42;\n");
  const patch = git(generated, ["diff", "--no-ext-diff", "--binary"]);
  fs.rmSync(path.join(generated, ".git"), { recursive: true });
  const m = {
    schema_version: 1,
    repository: "https://github.com/wurli/jet",
    revision,
    archive_sha256: digest(fs.readFileSync(result)),
    workspace_sha256: digest(fs.readFileSync(path.join(folder, "Cargo.toml"))),
    upstream_files: inputs,
    patches: [
      { file: "0001-fixture.patch", sha256: digest(Buffer.from(patch)) },
    ],
    output_files: files(generated),
  };
  write(root, "patches/jet/0001-fixture.patch", patch);
  write(root, "patches/jet/manifest.json", JSON.stringify(m, null, 2) + "\n");
  write(generated, "UPSTREAM.md", upstreamDoc(m));
  git(root, ["init", "--quiet"]);
  return { root, generated, m, archive: result, patch };
}
const f = fixture();
try {
  check(f.root);
  await reconstruct(f.root, { archive: f.archive });
  assert.equal(fs.existsSync(path.join(f.generated, "crates/cli")), false);
  const pristineSnapshot = files(f.generated);
  const tamper = (name, value, pattern) => {
    const original = fs.readFileSync(path.join(f.generated, name));
    write(f.generated, name, value);
    assert.throws(() => check(f.root), pattern);
    write(f.generated, name, original);
  };
  tamper("src/lib.rs", "changed\n", /Vendored snapshot/);
  tamper("LICENSE", "lost attribution\n", /Vendored snapshot/);
  tamper("UPSTREAM.md", "wrong revision\n", /Vendored snapshot/);
  write(f.generated, "unexpected.txt", "extra");
  assert.throws(() => check(f.root), /unexpected.txt/);
  fs.unlinkSync(path.join(f.generated, "unexpected.txt"));
  const source = path.join(f.generated, "src/lib.rs");
  fs.renameSync(source, source + ".missing");
  assert.throws(() => check(f.root), /src\/lib.rs/);
  fs.renameSync(source + ".missing", source);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  write(outside, "sentinel", "untouched");
  const link = path.join(f.generated, "src/linked");
  fs.symlinkSync(outside, link, "junction");
  assert.throws(() => check(f.root), /Symlinks/);
  fs.unlinkSync(link);
  assert.equal(
    fs.readFileSync(path.join(outside, "sentinel"), "utf8"),
    "untouched",
  );
  write(f.root, "patches/jet/0001-fixture.patch", f.patch + "\n");
  assert.throws(() => check(f.root), /Patch checksum mismatch/);
  write(f.root, "patches/jet/0001-fixture.patch", f.patch);
  const saveManifest = (m) =>
    write(f.root, "patches/jet/manifest.json", JSON.stringify(m));
  saveManifest({
    ...f.m,
    upstream_files: { ...f.m.upstream_files, "../escape": "0".repeat(64) },
  });
  assert.throws(() => loadManifest(f.root), /Unsafe snapshot path/);
  saveManifest(f.m);
  saveManifest({
    ...f.m,
    upstream_files: { ...f.m.upstream_files, "src/lib.rs": "0".repeat(64) },
  });
  assert.throws(() => check(f.root), /Reconstructed pristine core/);
  saveManifest(f.m);
  const badArchive = path.join(f.root, "bad.tar.gz");
  fs.writeFileSync(badArchive, "bad archive");
  await assert.rejects(
    reconstruct(f.root, { archive: badArchive, write: true }),
    /archive checksum mismatch/,
  );
  assert.deepEqual(
    files(f.generated),
    pristineSnapshot,
    "Failed verification must not replace the snapshot",
  );
  await assert.rejects(
    reconstruct(f.root, { archive: f.archive, write: true }),
    /local changes/,
    "Uncommitted generated files must be preserved",
  );
  assert.deepEqual(files(f.generated), pristineSnapshot);
  fs.rmSync(f.generated, { recursive: true });
  await reconstruct(f.root, { archive: f.archive, write: true });
  check(f.root);
  assert.deepEqual(
    files(f.generated),
    pristineSnapshot,
    "Rebuild is byte reproducible",
  );
  git(f.root, ["add", "vendor/jet-core"]);
  git(f.root, [
    "-c",
    "user.name=Rho vendor fixture",
    "-c",
    "user.email=vendor-fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `core.hooksPath=${path.join(f.root, "no-hooks")}`,
    "commit",
    "--quiet",
    "-m",
    "Fixture snapshot",
  ]);
  await reconstruct(f.root, { archive: f.archive, write: true });
  assert.deepEqual(
    files(f.generated),
    pristineSnapshot,
    "Replacing a clean snapshot preserves every byte",
  );
  assert.equal(
    git(f.root, ["status", "--porcelain", "--", "vendor/jet-core"]).trim(),
    "",
  );
  const proposal = await prepare(f.root, revision, f.archive);
  assert.deepEqual(files(path.join(proposal, "jet-core")), pristineSnapshot);
  assert.deepEqual(
    files(f.generated),
    pristineSnapshot,
    "Preparation must not modify production files",
  );
  await assert.rejects(
    prepare(f.root, "main", f.archive),
    /full upstream commit/,
  );
  const changed = archive(f.root, "b".repeat(40), "0.0.3");
  await assert.rejects(
    prepare(f.root, "b".repeat(40), changed.result),
    /effective version, edition or dependency settings/,
  );
  assert.deepEqual(
    files(f.generated),
    pristineSnapshot,
    "Failed preparation leaves production intact",
  );
  // Windows's directory junction test above is mandatory; creating a file symlink
  // can require an OS privilege that CI does not provide.
  if (process.platform !== "win32") {
    const linked = archive(f.root, "c".repeat(40), "0.0.2", true);
    assert.throws(
      () =>
        extractArchive(
          linked.result,
          "c".repeat(40),
          path.join(f.root, "linked-output"),
          digest(fs.readFileSync(linked.result)),
        ),
      /not a regular file/,
    );
  }
  // A patch that cannot apply must fail at the named patch instead of disappearing.
  const broken = path.join(f.root, "broken-stage");
  fs.mkdirSync(broken);
  write(broken, "Cargo.toml", "wrong\n");
  git(broken, ["init", "--quiet"]);
  git(broken, ["add", "--all"]);
  assert.throws(() => applySeries(f.root, broken, f.m), /0001-fixture.patch/);
  check(f.root);
  console.log(
    "Vendoring fixtures passed: exact bytes/license, ordered replay, hashes, path and link rejection, archive mismatch, non-destructive rebuild, proposal isolation and manifest drift.",
  );
} finally {
  fs.rmSync(f.root, { recursive: true, force: true });
}
