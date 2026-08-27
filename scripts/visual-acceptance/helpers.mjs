// Shared helpers for the visual acceptance scenario modules and their bounded
// browser collectors. Runtime actions still use only the fixed automation
// vocabulary exposed on `ctx`; filesystem helpers only protect local evidence
// identity and immutability.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { computeBuildIdentity } from "../rsr-build-identity.mjs";

export class AssertionFailure extends Error {}

const FRONTEND_BUILD_ID_PATTERN = /^[a-f0-9]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function existingPathComponents(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const components = [parsed.root];
  let cursor = parsed.root;
  for (const part of relative) {
    cursor = path.join(cursor, part);
    components.push(cursor);
  }
  return components;
}

export function ensureSecureDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(directory);
  for (const component of existingPathComponents(resolved)) {
    let stat;
    try {
      stat = fs.lstatSync(component);
    } catch (error) {
      if (error.code !== "ENOENT" || !create) {
        throw new AssertionFailure(`secure directory is unavailable: ${component}: ${error.message}`);
      }
      try {
        fs.mkdirSync(component);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      stat = fs.lstatSync(component);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AssertionFailure(`secure directory component must be a real directory: ${component}`);
    }
  }
  const real = fs.realpathSync(resolved);
  if (real !== resolved) {
    throw new AssertionFailure(`secure directory resolves outside its lexical path: ${resolved}`);
  }
  return resolved;
}

export function secureContainedPath(root, candidate, {
  allowMissing = false,
  expectedType = "file",
} = {}) {
  const secureRoot = ensureSecureDirectory(root);
  const resolved = path.resolve(candidate);
  if (!within(secureRoot, resolved) || resolved === secureRoot) {
    throw new AssertionFailure(`evidence path escapes its secure root: ${candidate}`);
  }
  const relative = path.relative(secureRoot, resolved).split(path.sep).filter(Boolean);
  let cursor = secureRoot;
  for (const [index, part] of relative.entries()) {
    cursor = path.join(cursor, part);
    const final = index === relative.length - 1;
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing) {
        if (!final) throw new AssertionFailure(`evidence path ancestor is missing: ${cursor}`);
        return resolved;
      }
      throw new AssertionFailure(`evidence path is unavailable: ${cursor}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      throw new AssertionFailure(`evidence path must not contain symlinks: ${cursor}`);
    }
    if (!final && !stat.isDirectory()) {
      throw new AssertionFailure(`evidence path ancestor is not a directory: ${cursor}`);
    }
    if (final && expectedType === "file" && !stat.isFile()) {
      throw new AssertionFailure(`evidence path is not a regular file: ${cursor}`);
    }
    if (final && expectedType === "directory" && !stat.isDirectory()) {
      throw new AssertionFailure(`evidence path is not a directory: ${cursor}`);
    }
  }
  const real = fs.realpathSync(resolved);
  if (!within(fs.realpathSync(secureRoot), real)) {
    throw new AssertionFailure(`evidence path resolves outside its secure root: ${candidate}`);
  }
  return resolved;
}

function readStableRegularFile(file, label) {
  let descriptor;
  try {
    const lexical = path.resolve(file);
    const stat = fs.lstatSync(lexical);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AssertionFailure(`${label} must be a real regular file: ${lexical}`);
    }
    descriptor = fs.openSync(lexical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new AssertionFailure(`${label} changed while being read: ${lexical}`);
    }
    const current = fs.lstatSync(lexical);
    if (!current.isFile() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new AssertionFailure(`${label} path changed while being read: ${lexical}`);
    }
    return bytes;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

export function readDirectoryIdentity(root) {
  const secureRoot = ensureSecureDirectory(root);
  const files = [];
  const visit = (directory, relativeRoot = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeRoot, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new AssertionFailure(`frontend dist must not contain symlinks: ${relative}`);
      }
      if (stat.isDirectory()) {
        visit(absolute, relative);
      } else if (stat.isFile()) {
        files.push({ relative, bytes: readStableRegularFile(absolute, "frontend dist asset") });
      } else {
        throw new AssertionFailure(`frontend dist contains an unsupported entry: ${relative}`);
      }
    }
  };
  visit(secureRoot);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const name = Buffer.from(file.relative, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(Buffer.from("file\0"));
    hash.update(name);
    hash.update(Buffer.from("\0"));
    hash.update(length);
    hash.update(file.bytes);
    bytes += file.bytes.length;
  }
  return { files: files.length, bytes, sha256: hash.digest("hex") };
}

export function assertDirectoryIdentity(expected, actual, label = "directory") {
  const valid = (identity) => Number.isSafeInteger(identity?.files) && identity.files >= 1
    && Number.isSafeInteger(identity?.bytes) && identity.bytes > 0
    && typeof identity?.sha256 === "string" && SHA256_PATTERN.test(identity.sha256);
  if (!valid(expected)) throw new AssertionFailure(`${label}: expected byte identity is invalid`);
  if (!valid(actual)) throw new AssertionFailure(`${label}: observed byte identity is invalid`);
  if (expected.files !== actual.files || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
    throw new AssertionFailure(
      `${label} changed (expected ${expected.sha256}/${expected.files}/${expected.bytes}, got ${actual.sha256}/${actual.files}/${actual.bytes})`,
    );
  }
  return actual;
}

export function readFrontendBuildId(distRoot) {
  const secureRoot = ensureSecureDirectory(distRoot);
  const identityFile = secureContainedPath(secureRoot, path.join(secureRoot, "build-identity.json"));
  let stat;
  try {
    stat = fs.lstatSync(identityFile);
  } catch (error) {
    throw new AssertionFailure(`frontend build identity is unreadable: ${error.message}`);
  }
  if (!stat.isFile()) {
    throw new AssertionFailure("frontend build identity must be a regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  } catch (error) {
    throw new AssertionFailure(`frontend build identity is invalid JSON: ${error.message}`);
  }
  if (typeof parsed?.build_id !== "string" || !FRONTEND_BUILD_ID_PATTERN.test(parsed.build_id)) {
    throw new AssertionFailure("frontend build identity must contain a 12-character lowercase SHA prefix");
  }
  return parsed.build_id;
}

export function currentSourceFrontendBuildId(repositoryRoot) {
  return computeBuildIdentity(repositoryRoot).id;
}

export function assertFrontendBuildId(expected, actual, label = "frontend") {
  if (typeof expected !== "string" || !FRONTEND_BUILD_ID_PATTERN.test(expected)) {
    throw new AssertionFailure(`${label}: expected frontend build identity is invalid`);
  }
  if (typeof actual !== "string" || !FRONTEND_BUILD_ID_PATTERN.test(actual)) {
    throw new AssertionFailure(`${label}: reported frontend build identity is invalid`);
  }
  if (actual !== expected) {
    throw new AssertionFailure(
      `${label}: frontend build identity mismatch (expected ${expected}, got ${actual})`,
    );
  }
  return actual;
}

export function createExclusiveEvidenceOutput(output) {
  const resolved = path.resolve(output);
  ensureSecureDirectory(path.dirname(resolved), { create: true });
  try {
    fs.mkdirSync(resolved);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new AssertionFailure(`evidence output already exists; evidence is immutable: ${resolved}`);
    }
    throw error;
  }
  ensureSecureDirectory(resolved);
  return resolved;
}

export function assertCollectorOutputOpen(output) {
  const secureOutput = ensureSecureDirectory(output);
  const evidenceFile = path.join(secureOutput, "evidence.json");
  if (!fs.existsSync(evidenceFile)) return;
  secureContainedPath(secureOutput, evidenceFile);
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  } catch (error) {
    throw new AssertionFailure(`collector run evidence is unreadable: ${error.message}`);
  }
  if (evidence?.finished_at != null) {
    throw new AssertionFailure(`collector cannot append to finalized evidence: ${output}`);
  }
}

export function writeExclusiveArtifact(file, bytes) {
  const parent = ensureSecureDirectory(path.dirname(file));
  const resolved = secureContainedPath(parent, file, { allowMissing: true });
  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new AssertionFailure(`collector artifact already exists; refusing overwrite: ${resolved}`);
    }
    throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
  secureContainedPath(parent, resolved);
}

export function writeAtomicArtifact(root, file, bytes) {
  const secureRoot = ensureSecureDirectory(root);
  const resolved = path.resolve(file);
  if (!within(secureRoot, resolved) || resolved === secureRoot) {
    throw new AssertionFailure(`atomic artifact escapes its secure root: ${file}`);
  }
  ensureSecureDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved)) secureContainedPath(secureRoot, resolved);
  const temporary = `${resolved}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeExclusiveArtifact(temporary, bytes);
  try {
    fs.renameSync(temporary, resolved);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  secureContainedPath(secureRoot, resolved);
  return resolved;
}

export function truncate(value, max = 300) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function assertIncludes(haystack, needle, label) {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  if (!text.includes(needle)) {
    throw new AssertionFailure(`${label}: expected ${JSON.stringify(needle)} in ${truncate(text, 500)}`);
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AssertionFailure(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(truncate(actual, 200))}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Client-side guard for one automation request. The bridge holds an
// unanswered eval for up to 300s (its own timeout), so a request emitted
// while the frontend listener is momentarily absent must be abandoned
// quickly and retried by the surrounding poll instead.
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new AssertionFailure(`${label} request timed out after ${ms}ms`)), ms);
    }),
  ]);
}

export async function waitUntil(label, probe, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new AssertionFailure(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

export async function waitReady(ctx, timeoutMs = 90_000) {
  return waitUntil("workbench ready", async () => {
    const ready = await withTimeout(ctx.ready(), 10_000, "ready");
    return ready.rsrReady === true ? ready : null;
  }, { timeoutMs });
}

function normalizedProjectPath(projectPath) {
  return path.resolve(path.normalize(projectPath));
}

export function acceptedProjectReady(before, after, projectPath) {
  if (after?.rsrReady !== true || typeof after.projectPath !== "string") return false;
  const expected = normalizedProjectPath(projectPath);
  if (normalizedProjectPath(after.projectPath) !== expected) return false;
  if (typeof before?.projectPath !== "string" || normalizedProjectPath(before.projectPath) !== expected) {
    return true;
  }
  const beforeRevision = before.evidence?.projectRevision;
  const afterRevision = after.evidence?.projectRevision;
  return Number.isSafeInteger(beforeRevision)
    && Number.isSafeInteger(afterRevision)
    && afterRevision > beforeRevision;
}

// Opens a project and waits until the readiness probe reports the exact
// normalized path. A same-root activation must also advance project revision.
export async function openProject(ctx, projectPath, timeoutMs = 90_000) {
  const before = await withTimeout(ctx.ready(), 10_000, "ready before project open");
  await ctx.act({ kind: "open_project", path: projectPath });
  const expected = normalizedProjectPath(projectPath);
  return waitUntil(`project ${expected} active`, async () => {
    const ready = await withTimeout(ctx.ready(), 10_000, "ready");
    return acceptedProjectReady(before, ready, projectPath) ? ready : null;
  }, { timeoutMs });
}

export async function waitRuntimeReady(ctx, timeoutMs = 90_000) {
  return waitUntil("workspace runtime ready", async () => {
    const snapshot = await withTimeout(ctx.snapshot(), 10_000, "snapshot");
    return snapshot.runtimes.some((runtime) => runtime.status === "ready") ? snapshot : null;
  }, { timeoutMs });
}

// Runs one console submission and returns the {status, preview, execution_id}
// result. Fails the calling gate when the execution did not end in the
// expected terminal status.
export async function runConsole(ctx, code, { expect = "completed", timeoutMs = 120_000, label = code } = {}) {
  const result = await ctx.act({ kind: "console_submit", code, timeout_ms: timeoutMs });
  if (result.status !== expect) {
    throw new AssertionFailure(
      `${label}: expected status ${JSON.stringify(expect)}, got ${JSON.stringify(result.status)}; preview: ${truncate(result.preview, 400)}`,
    );
  }
  return result;
}

export async function sourceProjectFile(ctx, relativePath, options = {}) {
  return runConsole(ctx, `source(${JSON.stringify(relativePath)})`, { ...options, label: `source(${relativePath})` });
}

// Bounded record listing for one open surface. Each record text is capped at
// 500 characters by the automation surface, so assert on record-level facts
// rather than whole-surface text.
export async function surfaceRecords(ctx, surfaceId, { attribute = "data-domain-id", selector = `[data-${attribute.split("-").slice(1).join("-")}]` } = {}) {
  const css = `[data-surface-id="${surfaceId}"] ${selector}`;
  const records = await ctx.query(css, { all: true, attribute });
  return records.map((record) => ({ id: record.value ?? null, text: record.text ?? "" }));
}

export async function domainRecords(ctx, surfaceId) {
  return surfaceRecords(ctx, surfaceId, { attribute: "data-domain-id", selector: "[data-domain-id]" });
}

export async function environmentRecords(ctx) {
  return surfaceRecords(ctx, "rho.environment", { attribute: "data-environment-id", selector: "[data-environment-id]" });
}

export async function openSurface(ctx, surfaceId, timeoutMs = 20_000) {
  await ctx.act({ kind: "open_surface", surface_id: surfaceId });
  return waitUntil(`surface ${surfaceId} mounted`, async () => {
    const matches = await ctx.query(`[data-surface-id="${surfaceId}"]`);
    return matches.length > 0 ? true : null;
  }, { timeoutMs });
}

// Give one component a reviewable viewport by closing unrelated placements.
// This uses the same close command as the visible surface chrome and keeps
// scenario assertions independent from whichever panels a prior gate opened.
export async function isolateSurfaces(ctx, keepSurfaceIds) {
  const keep = new Set(keepSurfaceIds);
  const snapshot = await ctx.snapshot();
  for (const instance of snapshot.surfaces) {
    if (!keep.has(instance.surface_id)) {
      await ctx.act({ kind: "close_instance", instance_id: instance.instance_id });
    }
  }
}

export async function waitForText(ctx, text, timeoutMs = 30_000) {
  await ctx.act({ kind: "wait", until: { text }, timeout_ms: timeoutMs });
}

export async function waitForSelector(ctx, selector, timeoutMs = 30_000) {
  await ctx.act({ kind: "wait", until: { selector }, timeout_ms: timeoutMs });
}
