import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import {
  candidatePlatformsForVersion,
  createAggregateEvidence,
  createPlatformEvidence,
  sha256File,
  validateAggregateEvidence,
  validatePublishedPlatformEvidence,
} from "./candidate-release.mjs";
import {
  loadReleaseNotes,
  requireExactReleaseBody,
  validateReleaseNotesRecord,
} from "./release-notes.mjs";
import {
  createNativeUpdaterEvidence,
  nativeUpdaterPlatformsForVersion,
  tauriManifestFromEvidence,
  validateNativeUpdaterReleaseAssets,
  validateNativeUpdaterEvidence,
} from "./tauri-native-updater.mjs";

export const ACCEPTANCE_SOURCE_VERSION = "0.4.0-dev.40";
export const ACCEPTANCE_TARGET_VERSION = "0.4.0-dev.41";
export const ACCEPTANCE_SOURCE_COMMIT = "14b16ced90df02621e37913e23c6a555cf5963f0";
export const ACCEPTANCE_SOURCE_TAG = `v${ACCEPTANCE_SOURCE_VERSION}`;
export const ACCEPTANCE_TARGET_TAG = `v${ACCEPTANCE_TARGET_VERSION}`;
export const ACCEPTANCE_TARGET_RELEASE_NAME = "Rho 0.4.0-dev.41 Native Updater Acceptance Target";
const ACCEPTANCE_NATIVE_PLATFORMS = nativeUpdaterPlatformsForVersion(ACCEPTANCE_TARGET_VERSION);
const ACCEPTANCE_CANDIDATE_PLATFORMS = candidatePlatformsForVersion(ACCEPTANCE_TARGET_VERSION);
export const ACCEPTANCE_TARGET_MARKER_NAME = `rho-${ACCEPTANCE_TARGET_VERSION}-native-updater-acceptance-target.json`;
export const PAGES_FIXTURE_MARKER_NAME = ".rho-native-updater-acceptance.json";
export const MAX_ACCEPTANCE_MARKER_BYTES = 16 * 1024;
export const MAX_ACCEPTANCE_WINDOW_MINUTES = 45;
export const ACCEPTANCE_FIXTURE_MODES = ["signature_rejection", "valid"];

const REPOSITORY = "https://github.com/YuLab-SMU/Rho";
const RELEASE_MARKER_TYPE = "rho_native_updater_acceptance_target";
const FIXTURE_TYPE = "rho_native_updater_acceptance_fixture";
const FIXTURE_PURPOSE = "UPDATER-1C-T1";
const MAX_RELEASE_BODY_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^[1-9]\d{0,19}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    fail(`${label} keys are invalid: expected ${wanted.join(", ")}; received ${actual.join(", ")}`);
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) fail(`Invalid argument at ${key || "end of input"}`);
    if (Object.hasOwn(result, key.slice(2))) fail(`Duplicate argument: ${key}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function requireArgs(args, names) {
  for (const name of names) {
    if (typeof args[name] !== "string" || !args[name]) fail(`Missing required argument --${name}`);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeExclusiveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), { flag: "wx" });
}

function readJson(filePath, label) {
  const bytes = readRegularFile(filePath, label, MAX_RELEASE_BODY_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not JSON: ${error.message}`);
  }
}

function readRegularFile(filePath, label, maximum = Number.MAX_SAFE_INTEGER) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maximum) {
    fail(`${label} is missing, empty, a symlink, or exceeds its byte budget: ${path.basename(filePath)}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== stat.size) fail(`${label} changed while being read: ${path.basename(filePath)}`);
  return bytes;
}

function fileRecord(filePath, label, maximum = Number.MAX_SAFE_INTEGER) {
  const bytes = readRegularFile(filePath, label, maximum);
  return {
    name: path.basename(filePath),
    size_bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function validateRecord(value, expectedName, label, maximum = Number.MAX_SAFE_INTEGER) {
  assertExactKeys(value, ["name", "size_bytes", "sha256"], label);
  if (
    value.name !== expectedName
    || !Number.isSafeInteger(value.size_bytes)
    || value.size_bytes <= 0
    || value.size_bytes > maximum
    || !HEX64.test(value.sha256)
  ) fail(`${label} is invalid`);
  return value;
}

function validateCanonicalUtc(value, label) {
  if (typeof value !== "string" || !UTC.test(value)) fail(`${label} is not canonical UTC`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail(`${label} is not a valid UTC timestamp`);
  }
  return parsed;
}

function releaseAssetNames(version, includeMarker = false) {
  const values = [
    `Rho_${version}_x64-setup.exe`,
    `Rho_${version}_x64-setup.exe.sha256`,
    `rho-${version}-windows-x86_64-evidence.json`,
    `Rho_${version}_aarch64.dmg`,
    `Rho_${version}_aarch64.dmg.sha256`,
    `rho-${version}-macos-aarch64-evidence.json`,
    `rho-${version}-candidate-evidence.json`,
    `Rho_${version}_x64-setup.exe.sig`,
    `Rho_${version}_aarch64.app.tar.gz`,
    `Rho_${version}_aarch64.app.tar.gz.sig`,
    `rho-${version}-tauri-native-updater-evidence.json`,
  ];
  if (includeMarker) values.push(ACCEPTANCE_TARGET_MARKER_NAME);
  return values.sort();
}

function nativeEvidenceName(version) {
  return `rho-${version}-tauri-native-updater-evidence.json`;
}

function candidateEvidenceName(version) {
  return `rho-${version}-candidate-evidence.json`;
}

function validateReleaseRecord(value, { version, state, expectedName }) {
  assertExactKeys(
    value,
    ["release_id", "tag_name", "target_commitish", "draft", "prerelease", "name", "body", "published_at", "html_url", "assets"],
    "acceptance release record",
  );
  if (
    typeof value.release_id !== "string"
    || !RELEASE_ID.test(value.release_id)
    || value.tag_name !== `v${version}`
    || typeof value.target_commitish !== "string"
    || !SHA.test(value.target_commitish)
    || value.prerelease !== true
    || value.name !== expectedName
    || typeof value.body !== "string"
    || !value.body.trim()
    || Buffer.byteLength(value.body, "utf8") > MAX_RELEASE_BODY_BYTES
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value.body)
    || value.html_url !== `${REPOSITORY}/releases/tag/v${version}`
  ) fail(`Release identity is invalid for ${version}`);
  if (state === "draft") {
    if (value.draft !== true || value.published_at !== null) fail(`Release must remain an unpublished Draft for ${version}`);
  } else if (state === "public") {
    if (value.draft !== false || typeof value.published_at !== "string") fail(`Release must be public for ${version}`);
    validateCanonicalUtc(value.published_at.replace(/\.\d{3}Z$/, "Z"), `Release publication time for ${version}`);
  } else {
    fail(`Unsupported release state: ${state}`);
  }
  if (!Array.isArray(value.assets)) fail(`Release assets are invalid for ${version}`);
  const names = new Set();
  for (const asset of value.assets) {
    assertExactKeys(asset, ["name", "size"], `Release asset for ${version}`);
    if (
      typeof asset.name !== "string"
      || !asset.name
      || !Number.isSafeInteger(asset.size)
      || asset.size <= 0
      || names.has(asset.name)
    ) fail(`Release asset is invalid or duplicated for ${version}`);
    names.add(asset.name);
  }
  return value;
}

function ensureDirectoryContents(directory, expectedNames, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} is not a regular directory`);
  const entries = fs.readdirSync(directory).sort();
  if (!isDeepStrictEqual(entries, [...expectedNames].sort())) {
    fail(`${label} does not contain the exact expected asset set`);
  }
  return Object.fromEntries(entries.map((name) => [name, fileRecord(path.join(directory, name), `${label} asset`)]));
}

function matchReleaseAssets(release, records, expectedNames, version) {
  const releaseAssets = new Map(release.assets.map((asset) => [asset.name, asset]));
  if (releaseAssets.size !== expectedNames.length || expectedNames.some((name) => !releaseAssets.has(name))) {
    fail(`Release asset names do not match the exact expected set for ${version}`);
  }
  for (const name of expectedNames) {
    if (releaseAssets.get(name).size !== records[name].size_bytes) {
      fail(`Release asset size does not match downloaded bytes for ${name}`);
    }
  }
}

function expectedPlatformEvidenceNames(version, platform) {
  if (platform === "windows_x86_64") {
    return {
      artifact: `Rho_${version}_x64-setup.exe`,
      checksum: `Rho_${version}_x64-setup.exe.sha256`,
      evidence: `rho-${version}-windows-x86_64-evidence.json`,
      signature: `Rho_${version}_x64-setup.exe.sig`,
    };
  }
  if (platform === "macos_aarch64") {
    return {
      artifact: `Rho_${version}_aarch64.dmg`,
      checksum: `Rho_${version}_aarch64.dmg.sha256`,
      evidence: `rho-${version}-macos-aarch64-evidence.json`,
      updaterArtifact: `Rho_${version}_aarch64.app.tar.gz`,
      signature: `Rho_${version}_aarch64.app.tar.gz.sig`,
    };
  }
  fail(`Unsupported candidate platform: ${platform}`);
}

function validateCandidateBundle({ release, directory, version, state, expectedName, includeMarker = false }) {
  validateReleaseRecord(release, { version, state, expectedName });
  const expectedNames = releaseAssetNames(version, includeMarker);
  const records = ensureDirectoryContents(directory, expectedNames, `${version} downloaded release directory`);
  matchReleaseAssets(release, records, expectedNames, version);

  const candidatePath = path.join(directory, candidateEvidenceName(version));
  const candidate = validateAggregateEvidence(readJson(candidatePath, `${version} candidate evidence`));
  if (candidate.version !== version || candidate.release_tag !== `v${version}` || candidate.commit !== release.target_commitish) {
    fail(`${version} candidate evidence identity is stale`);
  }
  for (const platform of ACCEPTANCE_CANDIDATE_PLATFORMS) {
    const names = expectedPlatformEvidenceNames(version, platform);
    const platformEvidence = validatePublishedPlatformEvidence(
      readJson(path.join(directory, names.evidence), `${version} ${platform} platform evidence`),
      {
        version,
        release_tag: `v${version}`,
        commit: release.target_commitish,
        platform,
        require_windows_signing: platform === "windows_x86_64",
      },
    );
    const aggregate = candidate.platforms[platform];
    for (const [kind, record] of Object.entries(aggregate)) {
      const actual = records[record.name];
      if (!actual || actual.size_bytes !== record.size_bytes || actual.sha256 !== record.sha256) {
        fail(`${version} ${platform} candidate ${kind} does not match its downloaded asset`);
      }
    }
    const artifactRecord = records[names.artifact];
    if (
      platformEvidence.artifact.name !== artifactRecord.name
      || platformEvidence.artifact.size_bytes !== artifactRecord.size_bytes
      || platformEvidence.artifact.sha256 !== artifactRecord.sha256
    ) fail(`${version} ${platform} platform evidence is not bound to final artifact bytes`);
  }

  const nativePath = path.join(directory, nativeEvidenceName(version));
  const nativeEvidence = validateNativeUpdaterEvidence(readJson(nativePath, `${version} native updater evidence`), {
    version,
    release_tag: `v${version}`,
    commit: release.target_commitish,
    candidate_evidence: candidate,
  });
  const signatureContents = Object.fromEntries(ACCEPTANCE_NATIVE_PLATFORMS.map((platform) => {
    const signature = nativeEvidence.platforms[platform].signature.name;
    return [platform, readRegularFile(path.join(directory, signature), `${version} ${platform} updater signature`, MAX_SIGNATURE_BYTES).toString("utf8")];
  }));
  validateNativeUpdaterReleaseAssets({
    evidence: nativeEvidence,
    evidenceAsset: records[nativeEvidenceName(version)],
    candidateEvidence: candidate,
    assets: Object.values(records).map((record) => ({ name: record.name, size: record.size_bytes, sha256: record.sha256 })),
    signatureContents,
    expected: { version, release_tag: `v${version}`, commit: release.target_commitish },
  });
  return {
    release,
    records,
    candidate,
    candidate_evidence_asset: records[candidateEvidenceName(version)],
    native_updater_evidence: nativeEvidence,
    native_updater_evidence_asset: records[nativeEvidenceName(version)],
    signature_contents: signatureContents,
  };
}

function validateBoundEvidenceRecord(value, version, kind) {
  const name = kind === "candidate"
    ? candidateEvidenceName(version)
    : nativeEvidenceName(version);
  return validateRecord(value, name, `${version} ${kind} evidence`, MAX_ACCEPTANCE_MARKER_BYTES);
}

function validateMarkerSide(value, { version, expectedName }) {
  const expected = ["version", "release_tag", "commit", "release_name", "release_body_sha256", "candidate_evidence", "native_updater_evidence"];
  assertExactKeys(value, expected, `${version} marker side`);
  if (value.version !== version || value.release_tag !== `v${version}` || !SHA.test(value.commit)) {
    fail(`${version} marker identity is invalid`);
  }
  if (value.release_name !== expectedName || !HEX64.test(value.release_body_sha256)) {
    fail(`${version} marker body binding is invalid`);
  }
  validateBoundEvidenceRecord(value.candidate_evidence, version, "candidate");
  validateBoundEvidenceRecord(value.native_updater_evidence, version, "native updater");
  return value;
}

export function validateAcceptanceTargetMarker(value) {
  assertExactKeys(
    value,
    ["schema_version", "type", "status", "purpose", "platforms", "source", "target"],
    "native updater acceptance target marker",
  );
  if (
    value.schema_version !== 1
    || value.type !== RELEASE_MARKER_TYPE
    || value.status !== "prepared"
    || value.purpose !== FIXTURE_PURPOSE
    || !isDeepStrictEqual(value.platforms, ACCEPTANCE_NATIVE_PLATFORMS)
  ) fail("Native updater acceptance target marker header is invalid");
  validateMarkerSide(value.source, {
    version: ACCEPTANCE_SOURCE_VERSION,
    expectedName: `Rho ${ACCEPTANCE_SOURCE_VERSION}`,
  });
  if (value.source.commit !== ACCEPTANCE_SOURCE_COMMIT) {
    fail("Native updater acceptance source commit is not the immutable dev.40 candidate");
  }
  validateMarkerSide(value.target, {
    version: ACCEPTANCE_TARGET_VERSION,
    expectedName: ACCEPTANCE_TARGET_RELEASE_NAME,
  });
  return value;
}

function markerFromBundles(source, target) {
  const marker = {
    schema_version: 1,
    type: RELEASE_MARKER_TYPE,
    status: "prepared",
    purpose: FIXTURE_PURPOSE,
    platforms: [...ACCEPTANCE_NATIVE_PLATFORMS],
    source: {
      version: source.candidate.version,
      release_tag: source.candidate.release_tag,
      commit: source.candidate.commit,
      release_name: source.release.name,
      release_body_sha256: sha256(Buffer.from(source.release.body, "utf8")),
      candidate_evidence: source.candidate_evidence_asset,
      native_updater_evidence: source.native_updater_evidence_asset,
    },
    target: {
      version: target.candidate.version,
      release_tag: target.candidate.release_tag,
      commit: target.candidate.commit,
      release_name: target.release.name,
      release_body_sha256: sha256(Buffer.from(target.release.body, "utf8")),
      candidate_evidence: target.candidate_evidence_asset,
      native_updater_evidence: target.native_updater_evidence_asset,
    },
  };
  validateAcceptanceTargetMarker(marker);
  return marker;
}

export function createAcceptanceTargetMarker({ sourceRelease, sourceDirectory, targetRelease, targetDirectory, targetReleaseNotes }) {
  const source = validateCandidateBundle({
    release: sourceRelease,
    directory: sourceDirectory,
    version: ACCEPTANCE_SOURCE_VERSION,
    state: "draft",
    expectedName: `Rho ${ACCEPTANCE_SOURCE_VERSION}`,
  });
  const target = validateCandidateBundle({
    release: targetRelease,
    directory: targetDirectory,
    version: ACCEPTANCE_TARGET_VERSION,
    state: "draft",
    expectedName: ACCEPTANCE_TARGET_RELEASE_NAME,
  });
  if (source.release.target_commitish !== ACCEPTANCE_SOURCE_COMMIT) {
    fail("Source Draft is not the immutable dev.40 candidate commit");
  }
  validateReleaseNotesRecord(targetReleaseNotes, {
    version: ACCEPTANCE_TARGET_VERSION,
    release_tag: ACCEPTANCE_TARGET_TAG,
  });
  requireExactReleaseBody(targetReleaseNotes, target.release.body);
  return markerFromBundles(source, target);
}

export function validatePublicAcceptanceTarget({ release, directory }) {
  const target = validateCandidateBundle({
    release,
    directory,
    version: ACCEPTANCE_TARGET_VERSION,
    state: "public",
    expectedName: ACCEPTANCE_TARGET_RELEASE_NAME,
    includeMarker: true,
  });
  const markerPath = path.join(directory, ACCEPTANCE_TARGET_MARKER_NAME);
  const markerBytes = readRegularFile(markerPath, "native updater acceptance target marker", MAX_ACCEPTANCE_MARKER_BYTES);
  const marker = validateAcceptanceTargetMarker(JSON.parse(markerBytes.toString("utf8")));
  if (
    marker.target.commit !== target.release.target_commitish
    || marker.target.release_body_sha256 !== sha256(Buffer.from(target.release.body, "utf8"))
    || marker.target.candidate_evidence.size_bytes !== target.candidate_evidence_asset.size_bytes
    || marker.target.candidate_evidence.sha256 !== target.candidate_evidence_asset.sha256
    || marker.target.native_updater_evidence.size_bytes !== target.native_updater_evidence_asset.size_bytes
    || marker.target.native_updater_evidence.sha256 !== target.native_updater_evidence_asset.sha256
  ) fail("Public acceptance target marker is stale or not bound to the exact target Release");
  return { marker, marker_asset: fileRecord(markerPath, "native updater acceptance target marker", MAX_ACCEPTANCE_MARKER_BYTES), target };
}

export function validateAcceptanceSourceDraft({ release, directory, marker }) {
  const expectedMarker = validateAcceptanceTargetMarker(marker);
  const source = validateCandidateBundle({
    release,
    directory,
    version: ACCEPTANCE_SOURCE_VERSION,
    state: "draft",
    expectedName: `Rho ${ACCEPTANCE_SOURCE_VERSION}`,
  });
  if (
    source.release.target_commitish !== ACCEPTANCE_SOURCE_COMMIT
    || expectedMarker.source.commit !== source.release.target_commitish
    || expectedMarker.source.release_name !== source.release.name
    || expectedMarker.source.release_body_sha256 !== sha256(Buffer.from(source.release.body, "utf8"))
    || expectedMarker.source.candidate_evidence.size_bytes !== source.candidate_evidence_asset.size_bytes
    || expectedMarker.source.candidate_evidence.sha256 !== source.candidate_evidence_asset.sha256
    || expectedMarker.source.native_updater_evidence.size_bytes !== source.native_updater_evidence_asset.size_bytes
    || expectedMarker.source.native_updater_evidence.sha256 !== source.native_updater_evidence_asset.sha256
  ) fail("The immutable dev.40 Draft no longer matches the public acceptance target marker");
  return source;
}

export function validateAcceptancePair({ sourceRelease, sourceDirectory, targetRelease, targetDirectory }) {
  const publicTarget = validatePublicAcceptanceTarget({ release: targetRelease, directory: targetDirectory });
  const source = validateAcceptanceSourceDraft({
    release: sourceRelease,
    directory: sourceDirectory,
    marker: publicTarget.marker,
  });
  return { source, target: publicTarget };
}

function signatureText(value, label) {
  const encoded = String(value || "").trim();
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_SIGNATURE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail(`${label} is not bounded base64 text`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) fail(`${label} is not canonical base64`);
  const text = bytes.toString("utf8");
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length !== 4 || lines.some((line) => !line || line.includes("\r")) || !body.startsWith("untrusted comment:")) {
    fail(`${label} is not a four-line Tauri/minisign signature`);
  }
  return { encoded, text, lines, trailingNewline };
}

export function mutatedNativeUpdaterSignature(value) {
  const parsed = signatureText(value, "Native updater signature");
  const signatureBytes = Buffer.from(parsed.lines[1], "base64");
  if (signatureBytes.length < 8) fail("Native updater signature payload is too short to mutate safely");
  signatureBytes[signatureBytes.length - 1] ^= 0x01;
  const mutatedLines = [...parsed.lines];
  mutatedLines[1] = signatureBytes.toString("base64");
  const mutatedText = `${mutatedLines.join("\n")}${parsed.trailingNewline ? "\n" : ""}`;
  const mutated = Buffer.from(mutatedText, "utf8").toString("base64");
  const reparsed = signatureText(mutated, "Mutated native updater signature");
  if (
    reparsed.encoded === parsed.encoded
    || reparsed.trailingNewline !== parsed.trailingNewline
    || reparsed.lines[0] !== parsed.lines[0]
    || reparsed.lines[2] !== parsed.lines[2]
    || reparsed.lines[3] !== parsed.lines[3]
  ) {
    fail("Native updater signature mutation is not isolated to the signature payload");
  }
  return mutated;
}

function firstSummaryLine(body) {
  const line = String(body || "").split("\n").find((value) => value.trim());
  if (!line || line.length > 400) fail("Acceptance target release body has no bounded summary line");
  return line.trim();
}

function fixtureNotes(summary, expiresAt) {
  const notes = `${summary} Temporary UPDATER-1C acceptance fixture; expires ${expiresAt}.`;
  if (notes.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(notes)) {
    fail("Acceptance fixture notes exceed the native updater bounds");
  }
  return notes;
}

function validateFixtureSeed(value) {
  assertExactKeys(
    value,
    ["schema_version", "type", "status", "mode", "source", "target", "manifest_sha256", "expires_at"],
    "native updater fixture seed",
  );
  if (
    value.schema_version !== 1
    || value.type !== FIXTURE_TYPE
    || value.status !== "prepared"
    || !ACCEPTANCE_FIXTURE_MODES.includes(value.mode)
    || !HEX64.test(value.manifest_sha256)
  ) fail("Native updater fixture seed header is invalid");
  validateMarkerSide(value.source, {
    version: ACCEPTANCE_SOURCE_VERSION,
    expectedName: `Rho ${ACCEPTANCE_SOURCE_VERSION}`,
  });
  validateMarkerSide(value.target, {
    version: ACCEPTANCE_TARGET_VERSION,
    expectedName: ACCEPTANCE_TARGET_RELEASE_NAME,
  });
  validateCanonicalUtc(value.expires_at, "Fixture expiry");
  return value;
}

function validateBaseline(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) fail("Fixture baseline is invalid");
  const required = ["index.html", "updates/development.json"];
  const allowed = [...required, "updates/stable.json"];
  const paths = new Set();
  for (const item of value) {
    assertExactKeys(item, ["path", "sha256"], "Fixture baseline entry");
    if (!allowed.includes(item.path) || !HEX64.test(item.sha256) || paths.has(item.path)) {
      fail("Fixture baseline entry is invalid or duplicated");
    }
    paths.add(item.path);
  }
  if (!required.every((item) => paths.has(item))) fail("Fixture baseline omits a required V1/page file");
  return value;
}

export function validateActiveFixture(value) {
  assertExactKeys(
    value,
    ["schema_version", "type", "status", "mode", "source", "target", "manifest_sha256", "deployed_at", "expires_at", "baseline"],
    "active native updater fixture",
  );
  if (
    value.schema_version !== 1
    || value.type !== FIXTURE_TYPE
    || value.status !== "active"
    || !ACCEPTANCE_FIXTURE_MODES.includes(value.mode)
    || !HEX64.test(value.manifest_sha256)
  ) fail("Active native updater fixture header is invalid");
  validateMarkerSide(value.source, {
    version: ACCEPTANCE_SOURCE_VERSION,
    expectedName: `Rho ${ACCEPTANCE_SOURCE_VERSION}`,
  });
  validateMarkerSide(value.target, {
    version: ACCEPTANCE_TARGET_VERSION,
    expectedName: ACCEPTANCE_TARGET_RELEASE_NAME,
  });
  const deployed = validateCanonicalUtc(value.deployed_at, "Fixture deployment time");
  const expires = validateCanonicalUtc(value.expires_at, "Fixture expiry");
  if (expires <= deployed || expires - deployed > MAX_ACCEPTANCE_WINDOW_MINUTES * 60 * 1000) {
    fail("Fixture window is not positive and bounded to 45 minutes");
  }
  validateBaseline(value.baseline);
  return value;
}

export function createFixtureSeed({ release, directory, mode, expiresAt }) {
  if (!ACCEPTANCE_FIXTURE_MODES.includes(mode)) fail(`Unsupported fixture mode: ${mode}`);
  const { marker, target } = validatePublicAcceptanceTarget({ release, directory });
  const manifest = tauriManifestFromEvidence({
    release: {
      version: target.candidate.version,
      release_tag: target.candidate.release_tag,
      commit: target.candidate.commit,
      published_at: target.release.published_at,
      summary: firstSummaryLine(target.release.body),
    },
    evidence: target.native_updater_evidence,
    signatureContents: target.signature_contents,
    channel: "development",
  });
  manifest.notes = fixtureNotes(manifest.notes, expiresAt);
  if (mode === "signature_rejection") {
    for (const platform of Object.keys(manifest.platforms)) {
      manifest.platforms[platform].signature = mutatedNativeUpdaterSignature(manifest.platforms[platform].signature);
    }
  }
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  const seed = {
    schema_version: 1,
    type: FIXTURE_TYPE,
    status: "prepared",
    mode,
    source: marker.source,
    target: marker.target,
    manifest_sha256: sha256(manifestBytes),
    expires_at: expiresAt,
  };
  validateFixtureSeed(seed);
  return { seed, manifest, manifestBytes };
}

function regularDirectory(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} is not a regular directory`);
}

function siteFileRecord(siteDirectory, relativePath) {
  if (path.posix.normalize(relativePath) !== relativePath || relativePath.startsWith("/") || relativePath.includes("..")) {
    fail(`Unsafe site path: ${relativePath}`);
  }
  const filePath = path.join(siteDirectory, ...relativePath.split("/"));
  const bytes = readRegularFile(filePath, `Fixture baseline ${relativePath}`, MAX_RELEASE_BODY_BYTES * 8);
  return { path: relativePath, sha256: sha256(bytes) };
}

function fixtureDirectory(siteDirectory) {
  return path.join(siteDirectory, "updates", "tauri");
}

function fixturePaths(siteDirectory) {
  const directory = fixtureDirectory(siteDirectory);
  return {
    directory,
    manifest: path.join(directory, "development.json"),
    marker: path.join(directory, PAGES_FIXTURE_MARKER_NAME),
    stable: path.join(directory, "stable.json"),
  };
}

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function baselineForSite(siteDirectory) {
  const files = ["index.html", "updates/development.json"];
  if (pathEntryExists(path.join(siteDirectory, "updates", "stable.json"))) files.push("updates/stable.json");
  return files.map((file) => siteFileRecord(siteDirectory, file));
}

function assertFixtureDirectoryVacant(siteDirectory) {
  const paths = fixturePaths(siteDirectory);
  if (!pathEntryExists(paths.directory)) return paths;
  regularDirectory(paths.directory, "Native updater fixture directory");
  const entries = fs.readdirSync(paths.directory);
  if (entries.length) fail("Native updater fixture directory is not empty before activation");
  return paths;
}

export function stageFixture({ siteDirectory, seed, manifestBytes, deployedAt }) {
  regularDirectory(siteDirectory, "GitHub Pages checkout");
  validateFixtureSeed(seed);
  const deployed = validateCanonicalUtc(deployedAt, "Fixture deployment time");
  const expires = validateCanonicalUtc(seed.expires_at, "Fixture expiry");
  if (expires <= deployed || expires - deployed > MAX_ACCEPTANCE_WINDOW_MINUTES * 60 * 1000) {
    fail("Fixture expiry must be after deployment and within 45 minutes");
  }
  if (sha256(manifestBytes) !== seed.manifest_sha256) fail("Fixture manifest bytes do not match the prepared seed");
  const paths = assertFixtureDirectoryVacant(siteDirectory);
  const baseline = baselineForSite(siteDirectory);
  fs.mkdirSync(paths.directory, { recursive: true });
  const active = {
    schema_version: 1,
    type: FIXTURE_TYPE,
    status: "active",
    mode: seed.mode,
    source: seed.source,
    target: seed.target,
    manifest_sha256: seed.manifest_sha256,
    deployed_at: deployedAt,
    expires_at: seed.expires_at,
    baseline,
  };
  validateActiveFixture(active);
  fs.writeFileSync(paths.manifest, manifestBytes, { flag: "wx" });
  fs.writeFileSync(paths.marker, canonicalJson(active), { flag: "wx" });
  return active;
}

function assertBaselineUnchanged(siteDirectory, baseline) {
  validateBaseline(baseline);
  for (const record of baseline) {
    const actual = siteFileRecord(siteDirectory, record.path);
    if (actual.sha256 !== record.sha256) fail(`Fixture baseline changed unexpectedly: ${record.path}`);
  }
}

export function removeFixture({ siteDirectory, expectedFixture }) {
  regularDirectory(siteDirectory, "GitHub Pages checkout");
  const expected = validateActiveFixture(expectedFixture);
  const paths = fixturePaths(siteDirectory);
  const actualBytes = readRegularFile(paths.marker, "Active native updater fixture marker", MAX_ACCEPTANCE_MARKER_BYTES);
  const actual = validateActiveFixture(JSON.parse(actualBytes.toString("utf8")));
  if (!isDeepStrictEqual(actual, expected)) fail("Active fixture marker does not match the expected cleanup record");
  const manifestBytes = readRegularFile(paths.manifest, "Active native updater fixture manifest", MAX_RELEASE_BODY_BYTES);
  if (sha256(manifestBytes) !== actual.manifest_sha256) fail("Active fixture manifest hash does not match its marker");
  assertBaselineUnchanged(siteDirectory, actual.baseline);
  fs.unlinkSync(paths.manifest);
  fs.unlinkSync(paths.marker);
  const remaining = fs.readdirSync(paths.directory);
  if (remaining.length === 0) fs.rmdirSync(paths.directory);
  return actual;
}

export function removeFixtureOrAssertAbsent({ siteDirectory, expectedFixture }) {
  regularDirectory(siteDirectory, "GitHub Pages checkout");
  const paths = fixturePaths(siteDirectory);
  const markerExists = pathEntryExists(paths.marker);
  const manifestExists = pathEntryExists(paths.manifest);
  if (!markerExists && !manifestExists) return { removed: false };
  if (!markerExists || !manifestExists) {
    fail("Acceptance fixture is partial or unexpected; cleanup refuses to delete it");
  }
  return { removed: true, fixture: removeFixture({ siteDirectory, expectedFixture }) };
}

export function assertNoActiveFixture({ siteDirectory }) {
  regularDirectory(siteDirectory, "GitHub Pages checkout");
  const paths = fixturePaths(siteDirectory);
  if (!pathEntryExists(paths.directory)) return;
  regularDirectory(paths.directory, "Native updater fixture directory");
  const entries = fs.readdirSync(paths.directory).sort();
  if (!entries.length) return;
  if (!pathEntryExists(paths.marker)) {
    const permanentDevelopment = ["development.json"];
    const permanentStableAndDevelopment = ["development.json", "stable.json"];
    if (
      isDeepStrictEqual(entries, permanentDevelopment)
      || isDeepStrictEqual(entries, permanentStableAndDevelopment)
    ) return;
    fail("Unexpected native updater fixture files remain; normal Pages publication is blocked");
  }
  const expectedEntries = ["development.json", PAGES_FIXTURE_MARKER_NAME].sort();
  if (!isDeepStrictEqual(entries, expectedEntries)) {
    fail("Unexpected native updater fixture files remain; normal Pages publication is blocked");
  }
  const bytes = readRegularFile(paths.marker, "Active native updater fixture marker", MAX_ACCEPTANCE_MARKER_BYTES);
  const active = validateActiveFixture(JSON.parse(bytes.toString("utf8")));
  const manifestBytes = readRegularFile(paths.manifest, "Active native updater fixture manifest", MAX_RELEASE_BODY_BYTES);
  if (sha256(manifestBytes) !== active.manifest_sha256) {
    fail("Active native updater fixture manifest hash is invalid; normal Pages publication is blocked");
  }
  assertBaselineUnchanged(siteDirectory, active.baseline);
  fail(`A native updater acceptance fixture remains active until ${active.expires_at}; normal Pages publication is blocked`);
}

export function recoverExpiredFixture({ siteDirectory, now }) {
  regularDirectory(siteDirectory, "GitHub Pages checkout");
  const current = validateCanonicalUtc(now, "Recovery cleanup time");
  const { marker } = fixturePaths(siteDirectory);
  const bytes = readRegularFile(marker, "Active native updater fixture marker", MAX_ACCEPTANCE_MARKER_BYTES);
  const active = validateActiveFixture(JSON.parse(bytes.toString("utf8")));
  if (current < validateCanonicalUtc(active.expires_at, "Fixture expiry")) {
    fail("Recovery cleanup refuses to remove a fixture before its recorded expiry");
  }
  return removeFixture({ siteDirectory, expectedFixture: active });
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.test === "true") return selfTest();
  if (args.mode === "create-target-marker") {
    requireArgs(args, ["source_release", "source_directory", "target_release", "target_directory", "target_release_notes", "output"]);
    const sourceRelease = readJson(args.source_release, "source release record");
    const targetRelease = readJson(args.target_release, "target release record");
    const targetNotes = readJson(args.target_release_notes, "target release notes record");
    const marker = createAcceptanceTargetMarker({
      sourceRelease,
      sourceDirectory: args.source_directory,
      targetRelease,
      targetDirectory: args.target_directory,
      targetReleaseNotes: targetNotes,
    });
    if (path.basename(args.output) !== ACCEPTANCE_TARGET_MARKER_NAME) fail(`Expected target marker output ${ACCEPTANCE_TARGET_MARKER_NAME}`);
    writeExclusiveJson(args.output, marker);
    process.stdout.write(`${JSON.stringify({ marker: path.basename(args.output), sha256: sha256(fs.readFileSync(args.output)) })}\n`);
    return;
  }
  if (args.mode === "validate-public-target") {
    requireArgs(args, ["release", "directory"]);
    const release = readJson(args.release, "public acceptance target release record");
    const result = validatePublicAcceptanceTarget({ release, directory: args.directory });
    process.stdout.write(`${JSON.stringify({ version: result.target.candidate.version, marker_sha256: result.marker_asset.sha256 })}\n`);
    return;
  }
  if (args.mode === "validate-acceptance-pair") {
    requireArgs(args, ["source_release", "source_directory", "target_release", "target_directory"]);
    const sourceRelease = readJson(args.source_release, "source acceptance Draft release record");
    const targetRelease = readJson(args.target_release, "public acceptance target release record");
    const result = validateAcceptancePair({
      sourceRelease,
      sourceDirectory: args.source_directory,
      targetRelease,
      targetDirectory: args.target_directory,
    });
    process.stdout.write(`${JSON.stringify({ source_version: result.source.candidate.version, target_version: result.target.target.candidate.version })}\n`);
    return;
  }
  if (args.mode === "fixture") {
    requireArgs(args, ["release", "directory", "fixture_mode", "expires_at", "output", "manifest_output"]);
    const release = readJson(args.release, "public acceptance target release record");
    const { seed, manifestBytes, manifest } = createFixtureSeed({
      release,
      directory: args.directory,
      mode: args.fixture_mode,
      expiresAt: args.expires_at,
    });
    writeExclusiveJson(args.output, seed);
    fs.mkdirSync(path.dirname(args.manifest_output), { recursive: true });
    fs.writeFileSync(args.manifest_output, manifestBytes, { flag: "wx" });
    if (args.signature_directory) {
      fs.mkdirSync(args.signature_directory, { recursive: true });
      for (const [platform, details] of Object.entries(manifest.platforms)) {
        fs.writeFileSync(path.join(args.signature_directory, `${platform}.sig`), `${details.signature}\n`, { flag: "wx" });
      }
    }
    process.stdout.write(`${JSON.stringify({ manifest_sha256: seed.manifest_sha256, mode: seed.mode })}\n`);
    return;
  }
  if (args.mode === "stage-fixture") {
    requireArgs(args, ["fixture", "manifest", "site", "deployed_at", "output"]);
    const seed = validateFixtureSeed(readJson(args.fixture, "fixture seed"));
    const manifestBytes = readRegularFile(args.manifest, "fixture manifest", MAX_RELEASE_BODY_BYTES);
    const active = stageFixture({ siteDirectory: args.site, seed, manifestBytes, deployedAt: args.deployed_at });
    writeExclusiveJson(args.output, active);
    process.stdout.write(`${JSON.stringify({ manifest_sha256: active.manifest_sha256, expires_at: active.expires_at })}\n`);
    return;
  }
  if (args.mode === "remove-fixture") {
    requireArgs(args, ["fixture", "site"]);
    const fixture = validateActiveFixture(readJson(args.fixture, "active fixture record"));
    const removed = removeFixture({ siteDirectory: args.site, expectedFixture: fixture });
    process.stdout.write(`${JSON.stringify({ removed: true, manifest_sha256: removed.manifest_sha256 })}\n`);
    return;
  }
  if (args.mode === "remove-fixture-or-assert-absent") {
    requireArgs(args, ["fixture", "site"]);
    const fixture = validateActiveFixture(readJson(args.fixture, "active fixture record"));
    const result = removeFixtureOrAssertAbsent({ siteDirectory: args.site, expectedFixture: fixture });
    process.stdout.write(`${JSON.stringify({ removed: result.removed, manifest_sha256: result.fixture?.manifest_sha256 || null })}\n`);
    return;
  }
  if (args.mode === "assert-no-active-fixture") {
    requireArgs(args, ["site"]);
    assertNoActiveFixture({ siteDirectory: args.site });
    process.stdout.write("{\"fixture\":\"absent\"}\n");
    return;
  }
  if (args.mode === "recover-expired-fixture") {
    requireArgs(args, ["site", "now"]);
    const removed = recoverExpiredFixture({ siteDirectory: args.site, now: args.now });
    process.stdout.write(`${JSON.stringify({ recovered: true, manifest_sha256: removed.manifest_sha256 })}\n`);
    return;
  }
  fail("Use --test true or --mode create-target-marker|validate-public-target|validate-acceptance-pair|fixture|stage-fixture|remove-fixture|remove-fixture-or-assert-absent|assert-no-active-fixture|recover-expired-fixture with the required arguments");
}

function fakeSignature() {
  return Buffer.from(
    "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
    "utf8",
  ).toString("base64");
}

function signingEvidence(artifactPath) {
  return {
    provider: "signpath",
    profile: "free_trial_self_signed",
    request_id: "12345678-1234-1234-1234-123456789abc",
    module_version: "4.4.6",
    module_sha256: "4a732624a7214dc8290dbf81ed2714d6b509be319427c2d55fd0c679d13ab5ae",
    signer_thumbprint: "1".repeat(40),
    self_signed: true,
    signature_status: "UnknownError",
    unsigned_sha256: "e".repeat(64),
    signed_sha256: sha256File(artifactPath),
  };
}

function createTestBundle(root, version, commit, { releaseName, releaseBody, draft, publishedAt, includeMarker = false, marker } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const signature = fakeSignature();
  const evidencePaths = {};
  for (const platform of ACCEPTANCE_CANDIDATE_PLATFORMS) {
    const names = expectedPlatformEvidenceNames(version, platform);
    const artifact = path.join(root, names.artifact);
    fs.writeFileSync(artifact, `${platform} ${version} artifact`);
    if (platform === "macos_aarch64") {
      fs.writeFileSync(path.join(root, names.updaterArtifact), `${platform} ${version} updater archive`);
    }
    fs.writeFileSync(path.join(root, names.signature), signature);
    evidencePaths[platform] = path.join(root, names.evidence);
    createPlatformEvidence({
      version,
      releaseTag: `v${version}`,
      commit,
      platform,
      artifactPath: artifact,
      outputPath: evidencePaths[platform],
      checks: platform === "windows_x86_64"
        ? ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke", "authenticode", "signpath_request_binding", "free_trial_self_signed"]
        : ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke", "arm64", "codesign", "entitlements", "notarization", "notary_binding", "staple", "gatekeeper", "license_boundary", "native_updater_archive"],
      signingEvidence: platform === "windows_x86_64" ? signingEvidence(artifact) : undefined,
    });
  }
  const candidatePath = path.join(root, candidateEvidenceName(version));
  createAggregateEvidence({
    version,
    releaseTag: `v${version}`,
    commit,
    directory: root,
    windowsEvidencePath: evidencePaths.windows_x86_64,
    macosEvidencePath: evidencePaths.macos_aarch64,
    outputPath: candidatePath,
    requireWindowsSigning: true,
  });
  createNativeUpdaterEvidence({
    version,
    releaseTag: `v${version}`,
    commit,
    directory: root,
    outputPath: path.join(root, nativeEvidenceName(version)),
  });
  if (includeMarker) fs.writeFileSync(path.join(root, ACCEPTANCE_TARGET_MARKER_NAME), canonicalJson(marker));
  const assets = fs.readdirSync(root).sort().map((name) => ({ name, size: fs.statSync(path.join(root, name)).size }));
  return {
    release_id: version === ACCEPTANCE_SOURCE_VERSION ? "1" : "2",
    tag_name: `v${version}`,
    target_commitish: commit,
    draft,
    prerelease: true,
    name: releaseName || `Rho ${version}`,
    body: releaseBody || `Rho ${version} test release.\n\n## Test\n\n- Fixture.\n`,
    published_at: publishedAt || null,
    html_url: `${REPOSITORY}/releases/tag/v${version}`,
    assets,
  };
}

function expectFailure(action, pattern) {
  assert.throws(action, pattern);
}

export function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-native-updater-acceptance-"));
  try {
    const sourceDirectory = path.join(root, "source");
    const targetDirectory = path.join(root, "target");
    const sourceCommit = ACCEPTANCE_SOURCE_COMMIT;
    const targetCommit = "b".repeat(40);
    const sourceRelease = createTestBundle(sourceDirectory, ACCEPTANCE_SOURCE_VERSION, sourceCommit, {
      releaseName: `Rho ${ACCEPTANCE_SOURCE_VERSION}`,
      releaseBody: "Rho dev.40 source candidate.\n\n## Test\n\n- Source.\n",
      draft: true,
    });
    const targetBody = "Rho dev.41 is an acceptance-only native updater target.\n\n## Acceptance scope\n\n- It is not a normal product release.\n";
    const targetRelease = createTestBundle(targetDirectory, ACCEPTANCE_TARGET_VERSION, targetCommit, {
      releaseName: ACCEPTANCE_TARGET_RELEASE_NAME,
      releaseBody: targetBody,
      draft: true,
    });
    const notesRoot = path.join(root, "notes-root");
    const notesDirectory = path.join(notesRoot, ".github", "release-notes");
    fs.mkdirSync(notesDirectory, { recursive: true });
    fs.writeFileSync(path.join(notesDirectory, `${ACCEPTANCE_TARGET_TAG}.md`), targetBody);
    const targetNotes = loadReleaseNotes({ repositoryRoot: notesRoot, version: ACCEPTANCE_TARGET_VERSION, releaseTag: ACCEPTANCE_TARGET_TAG });
    const marker = createAcceptanceTargetMarker({
      sourceRelease,
      sourceDirectory,
      targetRelease,
      targetDirectory,
      targetReleaseNotes: targetNotes,
    });
    validateAcceptanceTargetMarker(marker);
    fs.writeFileSync(path.join(targetDirectory, ACCEPTANCE_TARGET_MARKER_NAME), canonicalJson(marker));
    const publicTarget = {
      ...targetRelease,
      draft: false,
      published_at: "2026-08-15T12:00:00Z",
      assets: fs.readdirSync(targetDirectory).sort().map((name) => ({ name, size: fs.statSync(path.join(targetDirectory, name)).size })),
    };
    const validatedTarget = validatePublicAcceptanceTarget({ release: publicTarget, directory: targetDirectory });
    assert.equal(validatedTarget.marker.target.commit, targetCommit);
    const validatedPair = validateAcceptancePair({
      sourceRelease,
      sourceDirectory,
      targetRelease: publicTarget,
      targetDirectory,
    });
    assert.equal(validatedPair.source.candidate.commit, sourceCommit);
    expectFailure(
      () => validatePublicAcceptanceTarget({ release: { ...publicTarget, body: `${targetBody}changed` }, directory: targetDirectory }),
      /stale|body binding/,
    );
    expectFailure(
      () => validateAcceptanceTargetMarker({ ...marker, source: { ...marker.source, commit: "a".repeat(40) } }),
      /immutable dev\.40/,
    );
    expectFailure(
      () => validateAcceptancePair({
        sourceRelease: { ...sourceRelease, body: `${sourceRelease.body}changed` },
        sourceDirectory,
        targetRelease: publicTarget,
        targetDirectory,
      }),
      /immutable dev\.40 Draft no longer matches/,
    );

    const expiry = "2026-08-15T12:30:00Z";
    const validFixture = createFixtureSeed({ release: publicTarget, directory: targetDirectory, mode: "valid", expiresAt: expiry });
    assert.ok(validFixture.manifest.platforms["windows-x86_64"]);
    const rejectedFixture = createFixtureSeed({ release: publicTarget, directory: targetDirectory, mode: "signature_rejection", expiresAt: expiry });
    assert.notEqual(
      rejectedFixture.manifest.platforms["windows-x86_64"].signature,
      validFixture.manifest.platforms["windows-x86_64"].signature,
    );
    assert.equal(signatureText(rejectedFixture.manifest.platforms["windows-x86_64"].signature, "fixture rejection signature").lines.length, 4);

    const signatureWithoutTerminalLf = Buffer.from(fakeSignature(), "base64").toString("utf8");
    const signatureWithTerminalLf = Buffer.from(`${signatureWithoutTerminalLf}\n`, "utf8").toString("base64");
    const mutatedTerminalLfSignature = mutatedNativeUpdaterSignature(signatureWithTerminalLf);
    const parsedTerminalLfSignature = signatureText(mutatedTerminalLfSignature, "terminal-LF fixture rejection signature");
    assert.equal(parsedTerminalLfSignature.trailingNewline, true);
    assert.equal(Buffer.from(mutatedTerminalLfSignature, "base64").toString("utf8").endsWith("\n"), true);
    expectFailure(
      () => mutatedNativeUpdaterSignature(Buffer.from(`${signatureWithoutTerminalLf}\n\n`, "utf8").toString("base64")),
      /four-line Tauri\/minisign signature/,
    );

    const site = path.join(root, "site");
    fs.mkdirSync(path.join(site, "updates"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<html>normal page</html>\n");
    fs.writeFileSync(path.join(site, "updates", "development.json"), "{\"schema_version\":1}\n");
    const active = stageFixture({
      siteDirectory: site,
      seed: validFixture.seed,
      manifestBytes: validFixture.manifestBytes,
      deployedAt: "2026-08-15T12:00:00Z",
    });
    assert.ok(fs.existsSync(path.join(site, "updates", "tauri", "development.json")));
    assert.equal(fs.readFileSync(path.join(site, "updates", "development.json"), "utf8"), "{\"schema_version\":1}\n");
    removeFixture({ siteDirectory: site, expectedFixture: active });
    assert.equal(fs.existsSync(path.join(site, "updates", "tauri", "development.json")), false);
    expectFailure(
      () => stageFixture({
        siteDirectory: site,
        seed: validFixture.seed,
        manifestBytes: validFixture.manifestBytes,
        deployedAt: "2026-08-15T11:00:00Z",
      }),
      /expiry/,
    );

    const second = stageFixture({
      siteDirectory: site,
      seed: validFixture.seed,
      manifestBytes: validFixture.manifestBytes,
      deployedAt: "2026-08-15T12:00:00Z",
    });
    fs.writeFileSync(path.join(site, "updates", "development.json"), "changed\n");
    expectFailure(() => removeFixture({ siteDirectory: site, expectedFixture: second }), /baseline changed/);
    fs.writeFileSync(path.join(site, "updates", "development.json"), "{\"schema_version\":1}\n");
    expectFailure(() => recoverExpiredFixture({ siteDirectory: site, now: "2026-08-15T12:15:00Z" }), /before its recorded expiry/);
    recoverExpiredFixture({ siteDirectory: site, now: "2026-08-15T12:30:00Z" });
    assertNoActiveFixture({ siteDirectory: site });
    assert.deepEqual(removeFixtureOrAssertAbsent({ siteDirectory: site, expectedFixture: second }), { removed: false });
    fs.mkdirSync(path.join(site, "updates", "tauri"));
    fs.writeFileSync(path.join(site, "updates", "tauri", "development.json"), "permanent development manifest\n");
    assertNoActiveFixture({ siteDirectory: site });
    fs.writeFileSync(path.join(site, "updates", "tauri", "stable.json"), "permanent stable manifest\n");
    assertNoActiveFixture({ siteDirectory: site });
    fs.writeFileSync(path.join(site, "updates", "tauri", "unexpected.json"), "unexpected\n");
    expectFailure(
      () => assertNoActiveFixture({ siteDirectory: site }),
      /Unexpected native updater fixture files remain/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write("Native updater acceptance transport tests passed.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
