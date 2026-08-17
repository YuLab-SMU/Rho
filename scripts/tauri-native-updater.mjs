import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_UPDATER_PLATFORMS = ["windows_x86_64", "macos_aarch64", "linux_x86_64"];
const LEGACY_NATIVE_UPDATER_PLATFORMS = ["windows_x86_64", "macos_aarch64"];
const THREE_PLATFORM_NATIVE_VERSIONS = new Set(["0.4.0-dev.43"]);
export const TAURI_PUBLIC_KEY_ID = "173c902c085bfe5f";

const REPOSITORY = "https://github.com/YuLab-SMU/Rho";
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_NOTES_CHARS = 500;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  throw new Error(message);
}

export function nativeUpdaterPlatformsForVersion(version) {
  return THREE_PLATFORM_NATIVE_VERSIONS.has(version)
    ? NATIVE_UPDATER_PLATFORMS
    : LEGACY_NATIVE_UPDATER_PLATFORMS;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] == null) fail(`Invalid argument at ${key || "end of input"}`);
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys are invalid: expected ${wanted.join(", ")}; received ${actual.join(", ")}`);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileRecord(filePath, label, maximum = Number.MAX_SAFE_INTEGER) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maximum) {
    fail(`${label} is missing, empty, a symlink, or exceeds its byte budget: ${path.basename(filePath)}`);
  }
  const bytes = fs.readFileSync(filePath);
  return { name: path.basename(filePath), size_bytes: stat.size, sha256: sha256(bytes) };
}

function requireSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) fail(`Native updater version is not SemVer: ${version}`);
  return { version, prerelease: Boolean(match[4]) };
}

function expectedFiles(version, platform) {
  if (!NATIVE_UPDATER_PLATFORMS.includes(platform)) fail(`Unsupported native updater platform: ${platform}`);
  const artifactName = platform === "windows_x86_64"
    ? `Rho_${version}_x64-setup.exe`
    : platform === "macos_aarch64"
      ? `Rho_${version}_aarch64.app.tar.gz`
      : `Rho_${version}_x86_64.AppImage`;
  const evidenceName = platform === "windows_x86_64"
    ? `rho-${version}-windows-x86_64-evidence.json`
    : platform === "macos_aarch64"
      ? `rho-${version}-macos-aarch64-evidence.json`
      : `rho-${version}-linux-x86_64-evidence.json`;
  return {
    target: platform === "windows_x86_64"
      ? "windows-x86_64"
      : platform === "macos_aarch64" ? "darwin-aarch64" : "linux-x86_64",
    artifactName,
    signatureName: `${artifactName}.sig`,
    evidenceName,
  };
}

function signatureText(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_SIGNATURE_BYTES) {
    fail(`${label} exceeds its byte budget`);
  }
  const value = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(`${label} is not base64 text`);
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value) fail(`${label} is not canonical base64`);
  const decodedText = decoded.toString("utf8");
  if (!decodedText.startsWith("untrusted comment:") || !decodedText.includes("\n")) {
    fail(`${label} is not a Tauri/minisign signature`);
  }
  return value;
}

function sourcePlatformEvidence(filePath, { version, releaseTag, commit, platform }) {
  const record = fileRecord(filePath, "source platform evidence", MAX_EVIDENCE_BYTES);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    value?.type !== "rho_platform_candidate_evidence"
    || value?.status !== "passed"
    || value?.version !== version
    || value?.release_tag !== releaseTag
    || value?.commit !== commit
    || value?.platform !== platform
  ) fail(`Source platform evidence is not an exact passed ${platform} candidate record`);
  if (platform === "macos_aarch64") {
    const checks = value.checks;
    if (
      !Array.isArray(checks)
      || !checks.some((check) => check?.name === "native_updater_archive" && check.status === "passed")
    ) fail("macOS source platform evidence is missing the final native updater archive check");
  }
  if (platform === "linux_x86_64") {
    const names = new Set((value.checks || []).filter((check) => check?.status === "passed").map((check) => check.name));
    for (const required of ["appimage", "apprun", "native_updater_signature"]) {
      if (!names.has(required)) fail(`Linux source platform evidence is missing ${required}`);
    }
  }
  return record;
}

function validateRecord(record, expectedName, label, maximum = Number.MAX_SAFE_INTEGER) {
  assertExactKeys(record, ["name", "size_bytes", "sha256"], label);
  if (
    record.name !== expectedName
    || !Number.isSafeInteger(record.size_bytes)
    || record.size_bytes <= 0
    || record.size_bytes > maximum
    || !/^[0-9a-f]{64}$/.test(record.sha256)
  ) fail(`${label} is invalid`);
  return record;
}

function validatePlatform(value, version, platform) {
  const names = expectedFiles(version, platform);
  assertExactKeys(value, ["target", "artifact", "signature", "platform_evidence"], `${platform} native updater evidence`);
  if (value.target !== names.target) fail(`${platform} native updater target is invalid`);
  validateRecord(value.artifact, names.artifactName, `${platform} updater artifact`, MAX_ARTIFACT_BYTES);
  validateRecord(value.signature, names.signatureName, `${platform} updater signature`, MAX_SIGNATURE_BYTES);
  validateRecord(value.platform_evidence, names.evidenceName, `${platform} source platform evidence`, MAX_EVIDENCE_BYTES);
  return value;
}

export function validateNativeUpdaterEvidence(value, expected = {}) {
  assertExactKeys(
    value,
    ["schema_version", "type", "status", "version", "release_tag", "commit", "public_key_id", "platforms"],
    "native updater evidence",
  );
  if (
    value.schema_version !== 1
    || value.type !== "rho_tauri_native_updater_evidence"
    || value.status !== "passed"
    || value.public_key_id !== TAURI_PUBLIC_KEY_ID
  ) fail("Native updater evidence header is invalid");
  const parsed = requireSemver(value.version);
  if (value.release_tag !== `v${value.version}` || !/^[0-9a-f]{40}$/.test(value.commit)) {
    fail("Native updater evidence identity is invalid");
  }
  if (expected.version && value.version !== expected.version) fail("Native updater evidence version mismatch");
  if (expected.release_tag && value.release_tag !== expected.release_tag) fail("Native updater evidence tag mismatch");
  if (expected.commit && value.commit !== expected.commit) fail("Native updater evidence commit mismatch");
  const nativePlatforms = nativeUpdaterPlatformsForVersion(value.version);
  assertExactKeys(value.platforms, nativePlatforms, "native updater platforms");
  for (const platform of nativePlatforms) {
    validatePlatform(value.platforms[platform], value.version, platform);
    const aggregateEvidence = expected.candidate_evidence?.platforms?.[platform]?.evidence;
    if (
      aggregateEvidence
      && (
        value.platforms[platform].platform_evidence.name !== aggregateEvidence.name
        || value.platforms[platform].platform_evidence.sha256 !== aggregateEvidence.sha256
      )
    ) fail(`${platform} native updater evidence is not bound to the exact candidate platform evidence`);
  }
  if (expected.channel === "stable" && parsed.prerelease) fail("Stable native updater manifest cannot use a prerelease");
  return value;
}

export function createNativeUpdaterEvidence({ version, releaseTag, commit, directory, outputPath }) {
  requireSemver(version);
  if (releaseTag !== `v${version}` || !/^[0-9a-f]{40}$/.test(commit)) fail("Native updater evidence identity is invalid");
  const resolvedDirectory = fs.realpathSync(directory);
  if (fs.realpathSync(path.dirname(outputPath)) !== resolvedDirectory) fail("Native updater evidence output is outside the candidate directory");
  const expectedName = `rho-${version}-tauri-native-updater-evidence.json`;
  if (path.basename(outputPath) !== expectedName) fail(`Expected native updater evidence ${expectedName}`);
  const platforms = {};
  for (const platform of nativeUpdaterPlatformsForVersion(version)) {
    const names = expectedFiles(version, platform);
    const artifactPath = path.join(resolvedDirectory, names.artifactName);
    const signaturePath = path.join(resolvedDirectory, names.signatureName);
    const evidencePath = path.join(resolvedDirectory, names.evidenceName);
    const artifact = fileRecord(artifactPath, `${platform} updater artifact`, MAX_ARTIFACT_BYTES);
    const signature = fileRecord(signaturePath, `${platform} updater signature`, MAX_SIGNATURE_BYTES);
    signatureText(fs.readFileSync(signaturePath), `${platform} updater signature`);
    const platformEvidence = sourcePlatformEvidence(evidencePath, { version, releaseTag, commit, platform });
    platforms[platform] = {
      target: names.target,
      artifact,
      signature,
      platform_evidence: platformEvidence,
    };
  }
  const evidence = {
    schema_version: 1,
    type: "rho_tauri_native_updater_evidence",
    status: "passed",
    version,
    release_tag: releaseTag,
    commit,
    public_key_id: TAURI_PUBLIC_KEY_ID,
    platforms,
  };
  validateNativeUpdaterEvidence(evidence, { version, release_tag: releaseTag, commit });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

function validateReleaseAssetRecord(record, expected, label) {
  assertExactKeys(record, ["name", "size", "sha256"], label);
  if (
    record.name !== expected.name
    || record.size !== expected.size_bytes
    || record.sha256 !== expected.sha256
  ) fail(`${label} does not match native updater evidence`);
  return record;
}

export function validateNativeUpdaterReleaseAssets({
  evidence,
  evidenceAsset,
  candidateEvidence,
  assets,
  signatureContents,
  expected = {},
}) {
  if (!candidateEvidence || typeof candidateEvidence !== "object") {
    fail("Native updater candidate evidence is missing");
  }
  const validated = validateNativeUpdaterEvidence(evidence, {
    ...expected,
    candidate_evidence: candidateEvidence,
  });
  const evidenceName = `rho-${validated.version}-tauri-native-updater-evidence.json`;
  validateRecord(evidenceAsset, evidenceName, "native updater evidence asset", MAX_EVIDENCE_BYTES);
  if (!Array.isArray(assets)) fail("Native updater release assets are missing");
  const assetByName = new Map(assets.map((asset) => [asset?.name, asset]));
  if (assetByName.size !== assets.length) fail("Native updater release assets are duplicated");
  const releasedEvidence = assetByName.get(evidenceAsset.name);
  validateReleaseAssetRecord(releasedEvidence, evidenceAsset, "published native updater evidence");
  const nativePlatforms = nativeUpdaterPlatformsForVersion(validated.version);
  for (const platform of nativePlatforms) {
    const platformEvidence = validated.platforms[platform];
    const candidatePlatform = candidateEvidence.platforms?.[platform];
    if (
      !candidatePlatform
      || platformEvidence.platform_evidence.name !== candidatePlatform.evidence?.name
      || platformEvidence.platform_evidence.sha256 !== candidatePlatform.evidence?.sha256
    ) fail(`${platform} native updater evidence is not bound to the candidate platform evidence`);
    if (platform === "windows_x86_64") {
      if (
        platformEvidence.artifact.name !== candidatePlatform.artifact?.name
        || platformEvidence.artifact.sha256 !== candidatePlatform.artifact?.sha256
      ) fail("Windows native updater artifact is not the exact candidate installer");
    }
    validateReleaseAssetRecord(
      assetByName.get(platformEvidence.artifact.name),
      platformEvidence.artifact,
      `${platform} published updater artifact`,
    );
    validateReleaseAssetRecord(
      assetByName.get(platformEvidence.signature.name),
      platformEvidence.signature,
      `${platform} published updater signature`,
    );
    const signature = signatureText(
      Buffer.from(signatureContents?.[platform] || "", "utf8"),
      `${platform} published updater signature`,
    );
    if (sha256(Buffer.from(signatureContents[platform], "utf8")) !== platformEvidence.signature.sha256) {
      fail(`${platform} published updater signature does not match evidence`);
    }
    if (!signature) fail(`${platform} published updater signature is missing`);
  }
  return validated;
}

export function tauriManifestFromEvidence({ release, evidence, signatureContents, channel }) {
  if (!release || typeof release !== "object") fail("Native updater release record is missing");
  const nativePlatforms = nativeUpdaterPlatformsForVersion(release.version);
  if (!nativePlatforms.every((platform) => typeof signatureContents?.[platform] === "string")) {
    fail("Native updater signature contents are incomplete");
  }
  const parsed = requireSemver(release.version);
  if (
    release.release_tag !== `v${release.version}`
    || !/^[0-9a-f]{40}$/.test(release.commit)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(release.published_at || "")
    || !Number.isFinite(Date.parse(release.published_at))
  ) fail("Native updater release identity is invalid");
  if (channel !== "stable" && channel !== "development") fail("Native updater channel is invalid");
  validateNativeUpdaterEvidence(evidence, {
    version: release.version,
    release_tag: release.release_tag,
    commit: release.commit,
    channel,
  });
  if (channel === "stable" && parsed.prerelease) fail("Stable native updater manifest cannot use a prerelease");
  const notes = String(release.summary || "").trim();
  if (!notes || notes.length > MAX_NOTES_CHARS || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(notes)) {
    fail("Native updater notes are not bounded plain text");
  }
  const platforms = {};
  for (const platform of nativeUpdaterPlatformsForVersion(evidence.version)) {
    const platformEvidence = evidence.platforms[platform];
    const signature = signatureText(Buffer.from(signatureContents[platform], "utf8"), `${platform} published updater signature`);
    if (sha256(Buffer.from(signatureContents[platform], "utf8")) !== platformEvidence.signature.sha256) {
      fail(`${platform} published updater signature does not match evidence`);
    }
    const expectedUrl = `${REPOSITORY}/releases/download/${release.release_tag}/${platformEvidence.artifact.name}`;
    platforms[platformEvidence.target] = { url: expectedUrl, signature };
  }
  return { version: release.version, notes, pub_date: release.published_at, platforms };
}

function expectFailure(action, pattern) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  if (!error || !pattern.test(String(error.message))) fail(`Expected failure matching ${pattern}`);
}

export function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-tauri-updater-"));
  try {
    const version = "0.4.0-dev.40";
    const releaseTag = `v${version}`;
    const commit = "a".repeat(40);
    const testPlatforms = nativeUpdaterPlatformsForVersion(version);
    const signature = Buffer.from("untrusted comment: Rho test signature\nRURvby10ZXN0LXNpZ25hdHVyZQ==\n", "utf8").toString("base64");
    for (const platform of testPlatforms) {
      const names = expectedFiles(version, platform);
      fs.writeFileSync(path.join(root, names.artifactName), `${platform} artifact`);
      fs.writeFileSync(path.join(root, names.signatureName), signature);
      fs.writeFileSync(path.join(root, names.evidenceName), `${JSON.stringify({
        type: "rho_platform_candidate_evidence",
        status: "passed",
        version,
        release_tag: releaseTag,
        commit,
        platform,
        checks: platform === "macos_aarch64" ? [{ name: "native_updater_archive", status: "passed" }] : [],
      })}\n`);
    }
    const evidencePath = path.join(root, `rho-${version}-tauri-native-updater-evidence.json`);
    const evidence = createNativeUpdaterEvidence({ version, releaseTag, commit, directory: root, outputPath: evidencePath });
    const candidateEvidence = {
      platforms: Object.fromEntries(testPlatforms.map((platform) => [platform, {
        artifact: evidence.platforms[platform].artifact,
        evidence: evidence.platforms[platform].platform_evidence,
      }])),
    };
    validateNativeUpdaterEvidence(evidence, { version, release_tag: releaseTag, commit, candidate_evidence: candidateEvidence });
    validateNativeUpdaterReleaseAssets({
      evidence,
      evidenceAsset: fileRecord(evidencePath, "native updater evidence", MAX_EVIDENCE_BYTES),
      candidateEvidence,
      assets: [
        fileRecord(path.join(root, expectedFiles(version, "windows_x86_64").artifactName), "Windows updater artifact"),
        fileRecord(path.join(root, expectedFiles(version, "windows_x86_64").signatureName), "Windows updater signature", MAX_SIGNATURE_BYTES),
        fileRecord(path.join(root, expectedFiles(version, "macos_aarch64").artifactName), "macOS updater artifact"),
        fileRecord(path.join(root, expectedFiles(version, "macos_aarch64").signatureName), "macOS updater signature", MAX_SIGNATURE_BYTES),
        fileRecord(evidencePath, "native updater evidence", MAX_EVIDENCE_BYTES),
      ].map((record) => ({ name: record.name, size: record.size_bytes, sha256: record.sha256 })),
      signatureContents: Object.fromEntries(testPlatforms.map((platform) => [platform, signature])),
      expected: { version, release_tag: releaseTag, commit },
    });
    const manifest = tauriManifestFromEvidence({
      release: {
        version,
        release_tag: releaseTag,
        commit,
        published_at: "2026-08-15T00:00:00Z",
        summary: "Signed native updater test release.",
      },
      evidence,
      signatureContents: Object.fromEntries(testPlatforms.map((platform) => [platform, signature])),
      channel: "development",
    });
    if (Object.keys(manifest.platforms).sort().join(",") !== "darwin-aarch64,windows-x86_64") {
      fail("Native updater manifest platform projection is invalid");
    }
    expectFailure(() => validateNativeUpdaterEvidence({ ...evidence, public_key_id: "0".repeat(16) }), /header/);
    expectFailure(() => tauriManifestFromEvidence({
      release: { version, release_tag: releaseTag, commit, published_at: "2026-08-15T00:00:00Z", summary: "notes" },
      evidence,
      signatureContents: { windows_x86_64: "not a signature", macos_aarch64: signature },
      channel: "development",
    }), /base64/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.test === "true") {
    selfTest();
    process.stdout.write("Tauri native updater contract tests passed.\n");
    return;
  }
  if (args.mode !== "evidence") fail("Usage: node scripts/tauri-native-updater.mjs --mode evidence --version X --tag vX --commit SHA --directory DIR --output FILE, or --test true");
  createNativeUpdaterEvidence({
    version: args.version,
    releaseTag: args.tag,
    commit: args.commit,
    directory: args.directory,
    outputPath: args.output,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
