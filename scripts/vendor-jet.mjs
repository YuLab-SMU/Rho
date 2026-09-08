#!/usr/bin/env node
// Reconstruct the small Jet dependency. No upstream code is executed by replay.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESTINATION = "vendor/jet-core";
const METADATA = "patches/jet/manifest.json";
const MAX_ARCHIVE = 32 * 1024 * 1024;
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const isHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safePath = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_.\/-]+$/.test(value) &&
  !value.startsWith("/") &&
  !value
    .split("/")
    .some((part) => !part || part === "." || part === ".." || part === ".git");
function regular(file, limit = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile(), `Expected a regular file: ${file}`);
  assert.ok(stat.size <= limit, `File exceeds size limit: ${file}`);
  return fs.readFileSync(file);
}
function directory(dir) {
  assert.ok(
    fs.lstatSync(dir).isDirectory(),
    `Expected a real directory: ${dir}`,
  );
}
export function files(dir, skipGit = false) {
  directory(dir);
  const result = {};
  function walk(current, prefix = "") {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipGit && !prefix && entry.name === ".git") continue;
      const name = prefix + entry.name,
        file = path.join(current, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Symlinks are not vendored: ${name}`);
      if (entry.isDirectory()) walk(file, name + "/");
      else {
        assert.ok(entry.isFile(), `Unexpected file type: ${name}`);
        result[name] = digest(regular(file));
      }
    }
  }
  walk(dir);
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
function sameFiles(actual, expected, label) {
  const changed = [
    ...new Set([...Object.keys(actual), ...Object.keys(expected)]),
  ].filter((name) => actual[name] !== expected[name]);
  assert.equal(
    changed.length,
    0,
    `${label}: missing, extra or changed files: ${changed.join(", ")}`,
  );
}
export function loadManifest(root = ROOT, verifyPatches = true) {
  directory(path.join(root, "patches"));
  directory(path.join(root, "patches/jet"));
  const m = JSON.parse(regular(path.join(root, METADATA)));
  assert.deepEqual(
    Object.keys(m).sort(),
    [
      "schema_version",
      "repository",
      "revision",
      "archive_sha256",
      "workspace_sha256",
      "upstream_files",
      "patches",
      "output_files",
    ].sort(),
  );
  assert.equal(m.schema_version, 1);
  assert.equal(m.repository, "https://github.com/wurli/jet");
  assert.match(m.revision, /^[a-f0-9]{40}$/);
  assert.ok(isHash(m.archive_sha256) && isHash(m.workspace_sha256));
  for (const manifest of [m.upstream_files, m.output_files]) {
    assert.ok(
      manifest &&
        Object.keys(manifest).length > 2 &&
        Object.keys(manifest).length <= 512,
    );
    for (const [name, hash] of Object.entries(manifest)) {
      assert.ok(safePath(name), `Unsafe snapshot path: ${name}`);
      assert.ok(isHash(hash), `Invalid hash: ${name}`);
    }
    assert.ok(manifest["Cargo.toml"] && manifest.LICENSE);
  }
  assert.equal(
    m.upstream_files.LICENSE,
    m.output_files.LICENSE,
    "The upstream license must remain byte-for-byte intact",
  );
  assert.ok(
    Array.isArray(m.patches) && m.patches.length > 0 && m.patches.length <= 32,
  );
  const names = m.patches.map((p) => p.file);
  assert.equal(new Set(names).size, names.length, "Duplicate patch in series");
  const present = fs
    .readdirSync(path.join(root, "patches/jet"))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  assert.deepEqual(
    present,
    [...names].sort(),
    "Patch files and ordered manifest disagree",
  );
  for (const patch of m.patches) {
    assert.deepEqual(Object.keys(patch).sort(), ["file", "sha256"]);
    assert.match(patch.file, /^[0-9]{4}-[a-z0-9-]+\.patch$/);
    const bytes = regular(path.join(root, "patches/jet", patch.file));
    if (verifyPatches)
      assert.equal(
        digest(bytes),
        patch.sha256,
        `Patch checksum mismatch: ${patch.file}`,
      );
  }
  return m;
}
export function upstreamDoc(m) {
  return `# Jet core\n\nThis is the generated core-library snapshot used by Rho's native R adapter.\nIt is third-party Jet code, with the original MIT license in [LICENSE](LICENSE).\n\n- Upstream: ${m.repository}\n- Pinned revision: \`${m.revision}\`\n- Selected upstream tree: \`crates/core/\`, plus the root \`LICENSE\`\n- Archive SHA-256: \`${m.archive_sha256}\`\n- Upstream workspace manifest SHA-256: \`${m.workspace_sha256}\`\n\nThe standalone Cargo manifest retains the inherited upstream version, edition,\ndependency requirements and features. CLI, Lua/Neovim, release infrastructure and\nother upstream components are not included. Core tests inside the Rust sources\nare retained. Rho's root Cargo.lock controls production dependency resolution.\n\nLocal modifications are replayed in order from [patches/jet](../../patches/jet/README.md).\nThe machine-readable pin, file hashes and patch hashes live in\n[manifest.json](../../patches/jet/manifest.json). Do not edit this generated snapshot\nwithout also updating the patch series and lock metadata.\n\nFrom the Rho repository root:\n\n\`\`\`sh\nnode scripts/vendor-jet.mjs check\nnode scripts/vendor-jet.mjs verify\n\`\`\`\n\nThe first command verifies offline hashes and reverse/forward patch replay. The\nsecond reconstructs from the checksum-pinned upstream archive and verifies the\nstandalone manifest's effective dependency settings against the upstream workspace.\nSee the patch README for rebuilding and preparing a reviewed upstream update.\n`;
}
const git = (cwd, args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      `core.attributesFile=${os.devNull}`,
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    },
  );
function initialize(dir) {
  git(dir, ["init", "--quiet"]);
  git(dir, ["add", "--force", "--all"]);
}
export function applySeries(root, stage, manifest, reverse = false) {
  const series = reverse ? [...manifest.patches].reverse() : manifest.patches;
  for (const patch of series) {
    const file = path.join(root, "patches/jet", patch.file);
    const args = [
      "apply",
      "--index",
      "--whitespace=error-all",
      ...(reverse ? ["--reverse"] : []),
      file,
    ];
    try {
      git(stage, ["apply", "--check", ...args.slice(1)]);
      git(stage, args);
    } catch (error) {
      throw new Error(
        `${reverse ? "Reverse" : "Forward"} replay failed at ${patch.file}: ${error.stderr?.toString().trim() || error.message}`,
      );
    }
  }
}
function copyFiles(from, to, names) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of names) {
    assert.ok(safePath(name));
    const dest = path.join(to, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, regular(path.join(from, name)), { mode: 0o644 });
  }
}
export function check(root = ROOT) {
  const m = loadManifest(root);
  directory(path.join(root, "vendor"));
  const destination = path.join(root, DESTINATION);
  const expected = {
    ...m.output_files,
    "UPSTREAM.md": digest(Buffer.from(upstreamDoc(m))),
  };
  sameFiles(files(destination), expected, "Vendored snapshot");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "rho-jet-check-"));
  try {
    copyFiles(destination, stage, Object.keys(m.output_files));
    initialize(stage);
    applySeries(root, stage, m, true);
    sameFiles(
      files(stage, true),
      m.upstream_files,
      "Reconstructed pristine core",
    );
    applySeries(root, stage, m);
    sameFiles(files(stage, true), m.output_files, "Forward replay");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return m;
}
function tar(archive, args, maxBuffer = 2 * 1024 * 1024) {
  return execFileSync("tar", [...args, archive], {
    maxBuffer,
    timeout: 30000,
    env: { ...process.env, LC_ALL: "C" },
  });
}
export function extractArchive(archive, revision, destination, expectedHash) {
  const bytes = regular(archive, MAX_ARCHIVE);
  assert.ok(bytes.length <= MAX_ARCHIVE, "Upstream archive exceeds 32 MiB");
  if (expectedHash)
    assert.equal(
      digest(bytes),
      expectedHash,
      "Upstream archive checksum mismatch",
    );
  const prefix = `jet-${revision}/`;
  const members = tar(archive, ["-tzf"]).toString().trim().split(/\r?\n/);
  const verbose = tar(archive, ["-tvzf"]).toString().split(/\r?\n/);
  const selected = members.filter(
    (name) =>
      !name.endsWith("/") &&
      (name === prefix + "LICENSE" ||
        name === prefix + "Cargo.toml" ||
        name.startsWith(prefix + "crates/core/")),
  );
  assert.ok(
    selected.length >= 4 && selected.length <= 513,
    "Unexpected upstream core inventory",
  );
  assert.equal(
    new Set(selected).size,
    selected.length,
    "Duplicate upstream archive member",
  );
  fs.mkdirSync(destination, { recursive: true });
  let total = 0,
    workspace;
  for (const member of selected) {
    const relative =
      member === prefix + "LICENSE"
        ? "LICENSE"
        : member === prefix + "Cargo.toml"
          ? null
          : member.slice((prefix + "crates/core/").length);
    assert.ok(
      relative === null || safePath(relative),
      `Unsafe upstream path: ${member}`,
    );
    // Read selected regular members to stdout, never extract paths or links to disk.
    assert.ok(
      verbose.some(
        (line) => line.startsWith("-") && line.endsWith(" " + member),
      ),
      `Upstream member is not a regular file: ${member}`,
    );
    const content = execFileSync("tar", ["-xOf", archive, member], {
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
    total += content.length;
    assert.ok(total <= 8 * 1024 * 1024, "Core source exceeds 8 MiB");
    if (relative === null) workspace = content;
    else {
      const file = path.join(destination, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o644 });
    }
  }
  assert.ok(workspace, "Upstream workspace Cargo.toml is missing");
  return { workspace, archiveHash: digest(bytes), hashes: files(destination) };
}
async function getArchive(root, revision, expected, supplied) {
  if (supplied) return path.resolve(supplied);
  const cache = path.join(root, "target/jet-upstream-cache");
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `${revision}.tar.gz`);
  if (fs.existsSync(archive)) {
    if (expected)
      assert.equal(
        digest(regular(archive, MAX_ARCHIVE)),
        expected,
        "Cached archive checksum mismatch; inspect/remove that cache entry explicitly",
      );
    return archive;
  }
  const url = `https://codeload.github.com/wurli/jet/tar.gz/${revision}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  assert.ok(response.ok, `Upstream download failed: HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= MAX_ARCHIVE, "Upstream archive exceeds 32 MiB");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (expected)
    assert.equal(
      digest(bytes),
      expected,
      "Downloaded archive checksum mismatch",
    );
  fs.writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
  return archive;
}
function verifyManifestSemantics(root, pristine, workspace, patched, temp) {
  const upstream = path.join(temp, "upstream-workspace");
  copyFiles(
    pristine,
    path.join(upstream, "crates/core"),
    Object.keys(files(pristine)),
  );
  fs.writeFileSync(path.join(upstream, "Cargo.toml"), workspace);
  fs.writeFileSync(
    path.join(upstream, "LICENSE"),
    regular(path.join(pristine, "LICENSE")),
  );
  const read = (file, vendored = false) => {
    const data = JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--manifest-path",
          file,
          "--format-version",
          "1",
          "--no-deps",
          "--offline",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    const pkg = data.packages.find((p) => p.name === "jet_core");
    assert.ok(pkg, "jet_core missing from manifest");
    if (vendored) {
      assert.equal(
        pkg.license,
        "MIT",
        "Vendored license metadata must retain MIT",
      );
      assert.deepEqual(
        pkg.publish,
        [],
        "The modified snapshot must not publish automatically",
      );
    }
    return {
      name: pkg.name,
      version: pkg.version,
      edition: pkg.edition,
      dependencies: pkg.dependencies
        .map((d) => ({
          name: d.name,
          req: d.req,
          source: d.source,
          rename: d.rename,
          kind: d.kind,
          target: d.target,
          optional: d.optional,
          uses_default_features: d.uses_default_features,
          features: [...d.features].sort(),
          registry: d.registry,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  };
  assert.deepEqual(
    read(path.join(patched, "Cargo.toml"), true),
    read(path.join(upstream, "crates/core/Cargo.toml")),
    "Standalone manifest changed the upstream core's effective version, edition or dependency settings; revise the manifest patch",
  );
}
function upstreamMatches(result, m) {
  assert.equal(
    digest(result.workspace),
    m.workspace_sha256,
    "Upstream workspace manifest mismatch",
  );
  sameFiles(result.hashes, m.upstream_files, "Pristine upstream core");
}
export async function reconstruct(
  root = ROOT,
  { archive: supplied, write = false } = {},
) {
  const m = loadManifest(root);
  const archive = await getArchive(
    root,
    m.revision,
    m.archive_sha256,
    supplied,
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rho-jet-replay-"));
  try {
    const pristine = path.join(temp, "pristine"),
      stage = path.join(temp, "patched");
    const result = extractArchive(
      archive,
      m.revision,
      pristine,
      m.archive_sha256,
    );
    upstreamMatches(result, m);
    copyFiles(pristine, stage, Object.keys(m.upstream_files));
    initialize(stage);
    applySeries(root, stage, m);
    sameFiles(files(stage, true), m.output_files, "Patched upstream core");
    verifyManifestSemantics(root, pristine, result.workspace, stage, temp);
    if (write) {
      directory(path.join(root, "vendor"));
      const status = git(root, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        DESTINATION,
      ]);
      assert.equal(
        status.trim(),
        "",
        "The generated snapshot has local changes. Preserve them as patches and commit before rebuilding",
      );
      const target = path.join(root, DESTINATION),
        next = path.join(root, `${DESTINATION}.next-${process.pid}`),
        backup = path.join(root, `${DESTINATION}.previous-${process.pid}`);
      if (fs.existsSync(target)) directory(target);
      assert.ok(
        !fs.existsSync(next) && !fs.existsSync(backup),
        "Previous rebuild material exists; inspect it first",
      );
      copyFiles(stage, next, Object.keys(m.output_files));
      fs.writeFileSync(path.join(next, "UPSTREAM.md"), upstreamDoc(m));
      let moved = false;
      try {
        if (fs.existsSync(target)) {
          fs.renameSync(target, backup);
          moved = true;
        }
        fs.renameSync(next, target);
      } catch (error) {
        if (moved && !fs.existsSync(target)) fs.renameSync(backup, target);
        throw error;
      } finally {
        if (fs.existsSync(next))
          fs.rmSync(next, { recursive: true, force: true });
      }
      if (moved) fs.rmSync(backup, { recursive: true });
    } else {
      sameFiles(
        files(path.join(root, DESTINATION)),
        {
          ...m.output_files,
          "UPSTREAM.md": digest(Buffer.from(upstreamDoc(m))),
        },
        "Vendored snapshot",
      );
    }
    return m;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export async function prepare(root, revision, supplied) {
  assert.match(
    revision ?? "",
    /^[a-f0-9]{40}$/,
    "An explicit full upstream commit is required",
  );
  const previous = loadManifest(root, false);
  const archive = await getArchive(
    root,
    revision,
    revision === previous.revision ? previous.archive_sha256 : undefined,
    supplied,
  );
  const parent = path.join(root, "target/jet-vendor-proposals");
  fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, `${revision.slice(0, 12)}-`));
  const pristine = path.join(output, "pristine"),
    stage = path.join(output, "jet-core");
  try {
    const result = extractArchive(
      archive,
      revision,
      pristine,
      revision === previous.revision ? previous.archive_sha256 : undefined,
    );
    fs.writeFileSync(
      path.join(output, "upstream-Cargo.toml"),
      result.workspace,
    );
    assert.equal(
      result.hashes.LICENSE,
      previous.upstream_files.LICENSE,
      "Upstream license changed; review it before changing the pin",
    );
    const m = {
      ...previous,
      revision,
      archive_sha256: result.archiveHash,
      workspace_sha256: digest(result.workspace),
      upstream_files: result.hashes,
      patches: previous.patches.map((p) => ({
        file: p.file,
        sha256: digest(regular(path.join(root, "patches/jet", p.file))),
      })),
    };
    copyFiles(pristine, stage, Object.keys(result.hashes));
    initialize(stage);
    applySeries(root, stage, m);
    m.output_files = files(stage, true);
    verifyManifestSemantics(root, pristine, result.workspace, stage, output);
    fs.rmSync(path.join(stage, ".git"), { recursive: true });
    fs.writeFileSync(path.join(stage, "UPSTREAM.md"), upstreamDoc(m));
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      JSON.stringify(m, null, 2) + "\n",
    );
    return output;
  } catch (error) {
    fs.writeFileSync(
      path.join(output, "PREPARE-ERROR.txt"),
      error.message + "\n",
    );
    throw new Error(
      `${error.message}\nReview material retained at ${output}; production files were not changed.`,
    );
  }
}
async function main(args) {
  const [command, ...rest] = args;
  const archiveIndex = rest.indexOf("--archive");
  let archive;
  if (archiveIndex !== -1) {
    archive = rest[archiveIndex + 1];
    assert.ok(archive, "--archive requires a file");
    rest.splice(archiveIndex, 2);
  }
  if (command === "check" && rest.length === 0 && !archive) {
    const m = check();
    console.log(
      `Jet core verified offline: ${Object.keys(m.output_files).length} source/license files, ${m.patches.length} ordered patches; reverse and forward replay match.`,
    );
  } else if (["verify", "rebuild"].includes(command) && rest.length === 0) {
    const m = await reconstruct(ROOT, {
      archive,
      write: command === "rebuild",
    });
    console.log(
      `Jet ${m.revision}: upstream archive, file checksums, patch replay and manifest semantics verified${command === "rebuild" ? "; snapshot rebuilt" : ""}.`,
    );
  } else if (command === "prepare" && rest.length === 1) {
    const output = await prepare(ROOT, rest[0], archive);
    console.log(
      `Prepared ${output}. Review the diff and run affected Rho checks before accepting; production files were not changed.`,
    );
  } else
    throw new Error(
      "Usage: node scripts/vendor-jet.mjs check | verify [--archive FILE] | rebuild [--archive FILE] | prepare FULL_COMMIT [--archive FILE]",
    );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
