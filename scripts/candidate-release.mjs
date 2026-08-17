import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  NATIVE_UPDATER_PLATFORMS,
  createNativeUpdaterEvidence,
  validateNativeUpdaterReleaseAssets,
} from "./tauri-native-updater.mjs";

export const CANDIDATE_PLATFORMS = ["windows_x86_64", "macos_aarch64"];
export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const REHEARSAL_REPOSITORY = "YuLab-SMU/Rho_for_mac";
export const CANDIDATE_REPOSITORY = "YuLab-SMU/Rho";

const MAX_CHECKSUM_BYTES = 1024;
const MAX_SIGNING_EVIDENCE_BYTES = 16 * 1024;
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const CANDIDATE_VERSION_PATTERN = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-(${PRERELEASE_IDENTIFIER})(?:\\.${PRERELEASE_IDENTIFIER})*$`);
const LEGACY_WINDOWS_SIGNING_CHECKS = ["authenticode", "signpath_request_binding", "free_trial_self_signed"];
const TWO_STAGE_WINDOWS_SIGNING_CHECKS = [
  "authenticode_binary",
  "authenticode_installer",
  "installed_payload_signature",
  "signpath_binary_request_binding",
  "signpath_installer_request_binding",
  "free_trial_self_signed",
];
const TWO_STAGE_SIGNING_VERSIONS = new Set(["0.4.0-dev.42"]);
const SIGNPATH_FREE_TRIAL_MODULE_VERSION = "4.4.6";
const SIGNPATH_FREE_TRIAL_MODULE_SHA256 = "4a732624a7214dc8290dbf81ed2714d6b509be319427c2d55fd0c679d13ab5ae";
const UNSIGNED_CANDIDATE_COMPATIBILITY = new Set(["0.4.0-dev.27"]);
const UNSIGNED_PUBLISHED_COMPATIBILITY = new Set(["0.4.0-dev.24"]);
const CONDITIONAL_ACCEPTANCE_VERSIONS = new Set(["0.4.0-dev.39"]);
const NATIVE_UPDATER_REQUIRED_VERSIONS = new Set(["0.4.0-dev.40", "0.4.0-dev.42"]);
const CONDITIONAL_ACCEPTANCE_RISKS = [
  "macos_gatekeeper_human_launch_not_run",
  "windows_human_install_not_run",
];
const CONDITIONAL_ACCEPTANCE_LIMITATIONS = [
  {
    id: "macos_gatekeeper_human_launch_not_run",
    status: "not_run",
    reason_code: "gatekeeper_assessments_disabled",
  },
  {
    id: "windows_human_install_not_run",
    status: "not_run",
    reason_code: "no_windows_device",
  },
];

const REQUIRED_CHECKS = {
  windows_x86_64: [
    "release_metadata",
    "rust_workspace",
    "rho_bridge",
    "rho_agent",
    "frontend",
    "workspace_smoke",
  ],
  macos_aarch64: [
    "release_metadata",
    "rust_workspace",
    "rho_bridge",
    "rho_agent",
    "frontend",
    "workspace_smoke",
    "arm64",
    "codesign",
    "entitlements",
    "notarization",
    "notary_binding",
    "staple",
    "gatekeeper",
    "license_boundary",
  ],
};

const PUBLISHED_EVIDENCE_CHECK_EXCEPTIONS = {
  macos_aarch64: {
    "0.4.0-dev.24": new Set(["license_boundary"]),
  },
};

function windowsSigningChecksForVersion(version) {
  return TWO_STAGE_SIGNING_VERSIONS.has(version)
    ? TWO_STAGE_WINDOWS_SIGNING_CHECKS
    : LEGACY_WINDOWS_SIGNING_CHECKS;
}

function fail(message) {
  throw new Error(message);
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

export function validateCandidateIdentity(version, releaseTag, commit) {
  if (!CANDIDATE_VERSION_PATTERN.test(version)) {
    fail(`Candidate version is not prerelease SemVer: ${version}`);
  }
  if (releaseTag !== `v${version}`) fail(`Release tag ${releaseTag} does not match version ${version}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("Candidate commit must be a full lowercase Git SHA");
  return { version, release_tag: releaseTag, commit };
}

export function validateBuildAdmission(buildMode, repository, workflowRef, defaultBranch) {
  if (defaultBranch !== "main" || workflowRef !== `refs/heads/${defaultBranch}`) {
    fail(`Candidate workflow must run from the default main branch, received ${workflowRef || "<empty>"}`);
  }
  if (buildMode === "rehearsal" && repository === REHEARSAL_REPOSITORY) {
    return { build_mode: buildMode, repository, workflow_ref: workflowRef, default_branch: defaultBranch };
  }
  if (buildMode === "candidate" && repository === CANDIDATE_REPOSITORY) {
    return { build_mode: buildMode, repository, workflow_ref: workflowRef, default_branch: defaultBranch };
  }
  fail(`Build mode ${buildMode || "<empty>"} is not authorized for repository ${repository || "<empty>"}`);
}

export function expectedPlatformNames(version, platform) {
  if (!CANDIDATE_PLATFORMS.includes(platform)) fail(`Unsupported candidate platform: ${platform}`);
  const artifactName = platform === "windows_x86_64"
    ? `Rho_${version}_x64-setup.exe`
    : `Rho_${version}_aarch64.dmg`;
  const evidenceName = platform === "windows_x86_64"
    ? `rho-${version}-windows-x86_64-evidence.json`
    : `rho-${version}-macos-aarch64-evidence.json`;
  return { artifactName, hashName: `${artifactName}.sha256`, evidenceName };
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function fileRecord(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    fail(`Candidate file is missing, empty, or a symlink: ${path.basename(filePath)}`);
  }
  return { name: path.basename(filePath), size_bytes: stat.size, sha256: sha256File(filePath) };
}

function validateChecks(platform, checks, version, publishedCompatibility = false, hasSigning = false) {
  if (!Array.isArray(checks) || !checks.length || checks.length > 32) fail(`${platform} checks are missing or unbounded`);
  const names = new Set();
  for (const check of checks) {
    assertExactKeys(check, ["name", "status"], `${platform} check`);
    if (!/^[a-z0-9_]+$/.test(check.name) || check.status !== "passed" || names.has(check.name)) {
      fail(`${platform} check is invalid or duplicated: ${check.name}`);
    }
    names.add(check.name);
  }
  for (const required of REQUIRED_CHECKS[platform]) {
    if (names.has(required)) continue;
    const allowedHistoricalOmission = publishedCompatibility
      && PUBLISHED_EVIDENCE_CHECK_EXCEPTIONS[platform]?.[version]?.has(required);
    if (!allowedHistoricalOmission) fail(`${platform} evidence is missing required check ${required}`);
  }
  if (platform === "windows_x86_64") {
    for (const required of windowsSigningChecksForVersion(version)) {
      if (hasSigning && !names.has(required)) fail(`${platform} evidence is missing required check ${required}`);
      if (!hasSigning && names.has(required)) fail(`${platform} evidence has signing check ${required} without signing evidence`);
    }
    const requiredChecks = windowsSigningChecksForVersion(version);
    const foreignChecks = TWO_STAGE_SIGNING_VERSIONS.has(version)
      ? LEGACY_WINDOWS_SIGNING_CHECKS
      : TWO_STAGE_WINDOWS_SIGNING_CHECKS;
    for (const foreign of foreignChecks) {
      if (!requiredChecks.includes(foreign) && names.has(foreign)) {
        fail(`${platform} evidence has signing check ${foreign} from the wrong schema generation`);
      }
    }
  }
}

function validateLegacyWindowsSigning(signing, artifact) {
  assertExactKeys(
    signing,
    [
      "provider",
      "profile",
      "request_id",
      "module_version",
      "module_sha256",
      "signer_thumbprint",
      "self_signed",
      "signature_status",
      "unsigned_sha256",
      "signed_sha256",
    ],
    "Windows signing evidence",
  );
  if (signing.provider !== "signpath" || signing.profile !== "free_trial_self_signed") {
    fail("Windows signing evidence profile is invalid");
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(signing.request_id)) {
    fail("Windows signing request ID is invalid");
  }
  if (
    signing.module_version !== SIGNPATH_FREE_TRIAL_MODULE_VERSION
    || signing.module_sha256 !== SIGNPATH_FREE_TRIAL_MODULE_SHA256
  ) fail("Windows signing module identity is invalid");
  if (!/^[0-9a-f]{40}$/.test(signing.signer_thumbprint)) fail("Windows signer thumbprint is invalid");
  if (signing.self_signed !== true || signing.signature_status !== "UnknownError") {
    fail("Windows Free Trial signature trust state is invalid");
  }
  if (
    !/^[0-9a-f]{64}$/.test(signing.unsigned_sha256)
    || !/^[0-9a-f]{64}$/.test(signing.signed_sha256)
    || signing.unsigned_sha256 === signing.signed_sha256
  ) fail("Windows signing hashes are invalid or unchanged");
  if (signing.signed_sha256 !== artifact.sha256) fail("Windows signed hash does not match the candidate artifact");
  return signing;
}

function validateTwoStageWindowsSigning(signing, artifact) {
  assertExactKeys(
    signing,
    [
      "schema_version",
      "provider",
      "profile",
      "module_version",
      "module_sha256",
      "signer_thumbprint",
      "self_signed",
      "binary_request_id",
      "binary_signature_status",
      "binary_unsigned_sha256",
      "binary_signed_sha256",
      "binary_bundled_sha256",
      "installer_request_id",
      "installer_signature_status",
      "installer_unsigned_sha256",
      "installer_signed_sha256",
      "installed_binary_sha256",
      "installed_signature_status",
      "installed_signer_thumbprint",
      "installed_outside_workspace",
      "cleanup_verified",
    ],
    "Windows two-stage signing evidence",
  );
  if (
    signing.schema_version !== 2
    || signing.provider !== "signpath"
    || signing.profile !== "free_trial_self_signed_two_stage"
  ) fail("Windows two-stage signing evidence profile is invalid");
  if (
    signing.module_version !== SIGNPATH_FREE_TRIAL_MODULE_VERSION
    || signing.module_sha256 !== SIGNPATH_FREE_TRIAL_MODULE_SHA256
  ) fail("Windows signing module identity is invalid");
  if (!/^[0-9a-f]{40}$/.test(signing.signer_thumbprint)) fail("Windows signer thumbprint is invalid");
  if (signing.self_signed !== true) fail("Windows Free Trial signer must be self-signed");
  for (const field of ["binary_request_id", "installer_request_id"]) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(signing[field])) {
      fail(`Windows ${field.replaceAll("_", " ")} is invalid`);
    }
  }
  if (signing.binary_request_id === signing.installer_request_id) {
    fail("Windows SignPath request IDs must be distinct");
  }
  for (const field of ["binary_signature_status", "installer_signature_status", "installed_signature_status"]) {
    if (signing[field] !== "UnknownError") fail(`Windows ${field.replaceAll("_", " ")} is invalid`);
  }
  for (const field of [
    "binary_unsigned_sha256",
    "binary_signed_sha256",
    "binary_bundled_sha256",
    "installer_unsigned_sha256",
    "installer_signed_sha256",
    "installed_binary_sha256",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(signing[field])) fail(`Windows ${field.replaceAll("_", " ")} is invalid`);
  }
  if (signing.binary_unsigned_sha256 === signing.binary_signed_sha256) {
    fail("Windows binary signing hashes are invalid or unchanged");
  }
  if (signing.binary_bundled_sha256 !== signing.binary_signed_sha256) {
    fail("Windows binary hash changed during bundling");
  }
  if (signing.installer_unsigned_sha256 === signing.installer_signed_sha256) {
    fail("Windows installer signing hashes are invalid or unchanged");
  }
  if (signing.installer_signed_sha256 !== artifact.sha256) {
    fail("Windows signed installer hash does not match the candidate artifact");
  }
  if (signing.installed_binary_sha256 !== signing.binary_signed_sha256) {
    fail("Windows installed binary hash does not match the signed binary");
  }
  if (signing.installed_signer_thumbprint !== signing.signer_thumbprint) {
    fail("Windows installed signer thumbprint does not match the signed binary");
  }
  if (signing.installed_outside_workspace !== true) {
    fail("Windows installed binary was not proven outside the workspace");
  }
  if (signing.cleanup_verified !== true) fail("Windows installed-candidate cleanup was not verified");
  return signing;
}

function validateWindowsSigning(signing, artifact, version) {
  if (TWO_STAGE_SIGNING_VERSIONS.has(version)) {
    return validateTwoStageWindowsSigning(signing, artifact);
  }
  return validateLegacyWindowsSigning(signing, artifact);
}

function validatePlatformEvidenceWithPolicy(value, expected, publishedCompatibility) {
  const baseKeys = ["schema_version", "type", "status", "version", "release_tag", "commit", "platform", "artifact", "checks"];
  const hasSigning = value?.signing != null;
  assertExactKeys(
    value,
    hasSigning ? [...baseKeys, "signing"] : baseKeys,
    "platform evidence",
  );
  if (value.schema_version !== 1 || value.type !== "rho_platform_candidate_evidence" || value.status !== "passed") {
    fail("Platform evidence header is invalid");
  }
  validateCandidateIdentity(value.version, value.release_tag, value.commit);
  if (expected.version && value.version !== expected.version) fail("Platform evidence version mismatch");
  if (expected.release_tag && value.release_tag !== expected.release_tag) fail("Platform evidence tag mismatch");
  if (expected.commit && value.commit !== expected.commit) fail("Platform evidence commit mismatch");
  if (expected.platform && value.platform !== expected.platform) fail("Platform evidence platform mismatch");
  const names = expectedPlatformNames(value.version, value.platform);
  assertExactKeys(value.artifact, ["name", "hash_name", "size_bytes", "sha256"], `${value.platform} artifact`);
  if (value.artifact.name !== names.artifactName || value.artifact.hash_name !== names.hashName) {
    fail(`${value.platform} artifact filename is invalid`);
  }
  if (!Number.isSafeInteger(value.artifact.size_bytes) || value.artifact.size_bytes <= 0) {
    fail(`${value.platform} artifact size is invalid`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.artifact.sha256)) fail(`${value.platform} artifact SHA-256 is invalid`);
  if (hasSigning) {
    if (value.platform !== "windows_x86_64") fail("Only Windows platform evidence may contain a signing record");
    validateWindowsSigning(value.signing, value.artifact, value.version);
  }
  const requireWindowsSigning = expected.require_windows_signing === true
    || (publishedCompatibility && value.platform === "windows_x86_64" && !UNSIGNED_PUBLISHED_COMPATIBILITY.has(value.version));
  if (requireWindowsSigning && !hasSigning) fail("Windows candidate evidence is missing required signing evidence");
  validateChecks(value.platform, value.checks, value.version, publishedCompatibility, hasSigning);
  return value;
}

export function validatePlatformEvidence(value, expected = {}) {
  return validatePlatformEvidenceWithPolicy(value, expected, false);
}

export function validatePublishedPlatformEvidence(value, expected = {}) {
  return validatePlatformEvidenceWithPolicy(value, expected, true);
}

export function createPlatformEvidence({ version, releaseTag, commit, platform, artifactPath, outputPath, checks, signingEvidence }) {
  validateCandidateIdentity(version, releaseTag, commit);
  const names = expectedPlatformNames(version, platform);
  if (path.basename(artifactPath) !== names.artifactName) fail(`Expected artifact ${names.artifactName}`);
  if (path.basename(outputPath) !== names.evidenceName) fail(`Expected evidence ${names.evidenceName}`);
  if (path.resolve(path.dirname(outputPath)) !== path.resolve(path.dirname(artifactPath))) {
    fail("Platform evidence output is outside the artifact directory");
  }
  const artifact = fileRecord(artifactPath);
  const hashPath = path.join(path.dirname(artifactPath), names.hashName);
  fs.writeFileSync(hashPath, `${artifact.sha256} *${artifact.name}\n`, { flag: "wx" });
  const evidence = {
    schema_version: 1,
    type: "rho_platform_candidate_evidence",
    status: "passed",
    version,
    release_tag: releaseTag,
    commit,
    platform,
    artifact: {
      name: artifact.name,
      hash_name: names.hashName,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
    },
    checks: checks.map((name) => ({ name, status: "passed" })),
  };
  if (signingEvidence != null) evidence.signing = signingEvidence;
  validatePlatformEvidence(evidence);
  writeJson(outputPath, evidence);
  return evidence;
}

function verifyPlatformFiles(evidence, directory, evidencePath) {
  const artifactPath = path.join(directory, evidence.artifact.name);
  const hashPath = path.join(directory, evidence.artifact.hash_name);
  const artifact = fileRecord(artifactPath);
  if (artifact.size_bytes !== evidence.artifact.size_bytes || artifact.sha256 !== evidence.artifact.sha256) {
    fail(`${evidence.platform} artifact does not match evidence`);
  }
  const expectedSidecar = `${artifact.sha256} *${artifact.name}\n`;
  if (fs.readFileSync(hashPath, "utf8") !== expectedSidecar) fail(`${evidence.platform} checksum sidecar mismatch`);
  return {
    artifact,
    checksum: fileRecord(hashPath),
    evidence: fileRecord(evidencePath),
  };
}

export function validateAggregateEvidence(value) {
  assertExactKeys(
    value,
    ["schema_version", "type", "status", "version", "release_tag", "commit", "platforms"],
    "candidate evidence",
  );
  if (value.schema_version !== 1 || value.type !== "rho_candidate_evidence" || value.status !== "passed") {
    fail("Candidate evidence header is invalid");
  }
  validateCandidateIdentity(value.version, value.release_tag, value.commit);
  assertExactKeys(value.platforms, CANDIDATE_PLATFORMS, "candidate platforms");
  for (const platform of CANDIDATE_PLATFORMS) {
    assertExactKeys(value.platforms[platform], ["artifact", "checksum", "evidence"], `${platform} aggregate record`);
    const names = expectedPlatformNames(value.version, platform);
    for (const [kind, record] of Object.entries(value.platforms[platform])) {
      assertExactKeys(record, ["name", "size_bytes", "sha256"], `${platform} ${kind}`);
      if (!Number.isSafeInteger(record.size_bytes) || record.size_bytes <= 0 || !/^[0-9a-f]{64}$/.test(record.sha256)) {
        fail(`${platform} ${kind} record is invalid`);
      }
    }
    if (
      value.platforms[platform].checksum.size_bytes > MAX_CHECKSUM_BYTES
      || value.platforms[platform].evidence.size_bytes > MAX_EVIDENCE_BYTES
    ) fail(`${platform} evidence sidecars exceed their byte budget`);
    if (
      value.platforms[platform].artifact.name !== names.artifactName
      || value.platforms[platform].checksum.name !== names.hashName
      || value.platforms[platform].evidence.name !== names.evidenceName
    ) fail(`${platform} aggregate filenames are invalid`);
  }
  const names = Object.values(value.platforms).flatMap((entry) => Object.values(entry).map((record) => record.name));
  if (new Set(names).size !== names.length) fail("Candidate aggregate contains duplicate asset names");
  return value;
}

export function createAggregateEvidence({ version, releaseTag, commit, directory, windowsEvidencePath, macosEvidencePath, outputPath, requireWindowsSigning = false }) {
  validateCandidateIdentity(version, releaseTag, commit);
  const resolvedDirectory = fs.realpathSync(directory);
  const inputs = {
    windows_x86_64: windowsEvidencePath,
    macos_aarch64: macosEvidencePath,
  };
  const platforms = {};
  for (const platform of CANDIDATE_PLATFORMS) {
    const resolvedEvidencePath = fs.realpathSync(inputs[platform]);
    if (path.dirname(resolvedEvidencePath) !== resolvedDirectory) {
      fail(`${platform} evidence is outside the candidate directory`);
    }
    const evidence = validatePlatformEvidence(JSON.parse(fs.readFileSync(inputs[platform], "utf8")), {
      version,
      release_tag: releaseTag,
      commit,
      platform,
      require_windows_signing: requireWindowsSigning && platform === "windows_x86_64",
    });
    platforms[platform] = verifyPlatformFiles(evidence, directory, inputs[platform]);
  }
  const aggregate = {
    schema_version: 1,
    type: "rho_candidate_evidence",
    status: "passed",
    version,
    release_tag: releaseTag,
    commit,
    platforms,
  };
  validateAggregateEvidence(aggregate);
  const expectedName = `rho-${version}-candidate-evidence.json`;
  if (path.basename(outputPath) !== expectedName) fail(`Expected aggregate evidence ${expectedName}`);
  if (path.resolve(path.dirname(outputPath)) !== path.resolve(directory)) fail("Aggregate evidence output is outside the candidate directory");
  writeJson(outputPath, aggregate);
  return aggregate;
}

export function validateRehearsalEvidence(value, expected = {}) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_EVIDENCE_BYTES) {
    fail("Rehearsal evidence exceeds its byte budget");
  }
  assertExactKeys(
    value,
    [
      "schema_version",
      "type",
      "status",
      "source_repository",
      "version",
      "release_tag",
      "commit",
      "run_id",
      "run_attempt",
      "platforms",
    ],
    "rehearsal evidence",
  );
  if (
    value.schema_version !== 1
    || value.type !== "rho_candidate_rehearsal_evidence"
    || value.status !== "passed"
  ) fail("Rehearsal evidence header is invalid");
  if (value.source_repository !== REHEARSAL_REPOSITORY) fail("Rehearsal source repository is not authorized");
  if (!/^[1-9]\d{0,19}$/.test(value.run_id)) fail("Rehearsal run ID is invalid");
  if (!Number.isSafeInteger(value.run_attempt) || value.run_attempt <= 0 || value.run_attempt > 1000) {
    fail("Rehearsal run attempt is invalid");
  }
  const candidate = validateAggregateEvidence({
    schema_version: value.schema_version,
    type: "rho_candidate_evidence",
    status: value.status,
    version: value.version,
    release_tag: value.release_tag,
    commit: value.commit,
    platforms: value.platforms,
  });
  if (expected.source_repository && value.source_repository !== expected.source_repository) {
    fail("Rehearsal source repository mismatch");
  }
  if (expected.version && value.version !== expected.version) fail("Rehearsal version mismatch");
  if (expected.release_tag && value.release_tag !== expected.release_tag) fail("Rehearsal tag mismatch");
  if (expected.commit && value.commit !== expected.commit) fail("Rehearsal commit mismatch");
  if (expected.run_id && value.run_id !== String(expected.run_id)) fail("Rehearsal run ID mismatch");
  if (expected.run_attempt && value.run_attempt !== Number(expected.run_attempt)) fail("Rehearsal run attempt mismatch");
  return { ...value, platforms: candidate.platforms };
}

export function createRehearsalEvidence({ candidateEvidencePath, sourceRepository, runId, runAttempt, outputPath }) {
  const candidateRecord = fileRecord(candidateEvidencePath);
  if (candidateRecord.size_bytes > MAX_EVIDENCE_BYTES) fail("Candidate evidence exceeds its byte budget");
  const candidate = validateAggregateEvidence(JSON.parse(fs.readFileSync(candidateEvidencePath, "utf8")));
  const expectedName = `rho-${candidate.version}-rehearsal-evidence.json`;
  if (path.basename(outputPath) !== expectedName) fail(`Expected rehearsal evidence ${expectedName}`);
  if (path.resolve(path.dirname(outputPath)) !== path.resolve(path.dirname(candidateEvidencePath))) {
    fail("Rehearsal evidence output is outside the candidate directory");
  }
  const rehearsal = {
    schema_version: 1,
    type: "rho_candidate_rehearsal_evidence",
    status: "passed",
    source_repository: sourceRepository,
    version: candidate.version,
    release_tag: candidate.release_tag,
    commit: candidate.commit,
    run_id: String(runId),
    run_attempt: Number(runAttempt),
    platforms: candidate.platforms,
  };
  validateRehearsalEvidence(rehearsal, {
    source_repository: REHEARSAL_REPOSITORY,
    version: candidate.version,
    release_tag: candidate.release_tag,
    commit: candidate.commit,
    run_id: runId,
    run_attempt: runAttempt,
  });
  writeJson(outputPath, rehearsal);
  return rehearsal;
}

function requiredCandidateAssetRecords(candidateEvidence) {
  return Object.values(candidateEvidence.platforms).flatMap((entry) => [entry.artifact, entry.checksum, entry.evidence]);
}

function nativeUpdaterRequired(version) {
  return NATIVE_UPDATER_REQUIRED_VERSIONS.has(version);
}

function nativeUpdaterEvidenceName(version) {
  return `rho-${version}-tauri-native-updater-evidence.json`;
}

function validGithubLogin(value) {
  return typeof value === "string"
    && value.length <= 39
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value);
}

function validateCanonicalPastUtcTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail("Conditional acceptance authorization time is not canonical UTC");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail("Conditional acceptance authorization time is invalid");
  }
  if (parsed > Date.now() + 5 * 60 * 1000) {
    fail("Conditional acceptance authorization time is in the future");
  }
}

export function validateAcceptanceEvidence(acceptance, {
  candidate,
  candidateEvidenceSha256,
  publisher,
} = {}) {
  if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)) {
    fail("Candidate acceptance evidence is invalid");
  }
  if (!candidate || typeof candidate !== "object") fail("Candidate evidence is required for acceptance validation");
  if (!/^[0-9a-f]{64}$/.test(candidateEvidenceSha256 || "")) {
    fail("Candidate evidence digest is required for acceptance validation");
  }

  const commonKeys = [
    "schema_version",
    "type",
    "status",
    "decision",
    "version",
    "release_tag",
    "commit",
    "candidate_evidence_sha256",
    "platforms",
  ];
  if (acceptance.schema_version === 1) {
    assertExactKeys(acceptance, commonKeys, "acceptance evidence");
    if (
      acceptance.type !== "rho_candidate_acceptance"
      || acceptance.status !== "passed"
      || acceptance.decision !== "GO"
    ) fail("MAC5 acceptance does not contain an explicit passed GO");
  } else if (acceptance.schema_version === 2) {
    assertExactKeys(acceptance, [...commonKeys, "authorization", "limitations"], "acceptance evidence");
    if (
      acceptance.type !== "rho_candidate_acceptance"
      || acceptance.status !== "conditional"
      || acceptance.decision !== "CONDITIONAL_GO"
    ) fail("Conditional acceptance must contain an explicit conditional CONDITIONAL_GO");
    if (!CONDITIONAL_ACCEPTANCE_VERSIONS.has(candidate.version) || !candidate.version.includes("-")) {
      fail("Conditional acceptance is not authorized for this version");
    }
    assertExactKeys(
      acceptance.authorization,
      ["authorized_by", "authorized_at", "scope", "acknowledged_risks"],
      "conditional acceptance authorization",
    );
    if (!validGithubLogin(acceptance.authorization.authorized_by)) {
      fail("Conditional acceptance authorizer is invalid");
    }
    if (publisher !== undefined && acceptance.authorization.authorized_by !== publisher) {
      fail("Conditional acceptance authorizer does not match the publish actor");
    }
    validateCanonicalPastUtcTimestamp(acceptance.authorization.authorized_at);
    if (acceptance.authorization.scope !== "public_prerelease_only") {
      fail("Conditional acceptance scope is invalid");
    }
    if (!isDeepStrictEqual(acceptance.authorization.acknowledged_risks, CONDITIONAL_ACCEPTANCE_RISKS)) {
      fail("Conditional acceptance risks are incomplete or not canonical");
    }
    if (!isDeepStrictEqual(acceptance.limitations, CONDITIONAL_ACCEPTANCE_LIMITATIONS)) {
      fail("Conditional acceptance limitations are incomplete or not canonical");
    }
  } else {
    fail("Candidate acceptance schema version is unsupported");
  }

  if (
    acceptance.version !== candidate.version
    || acceptance.release_tag !== candidate.release_tag
    || acceptance.commit !== candidate.commit
    || acceptance.candidate_evidence_sha256 !== candidateEvidenceSha256
    || !isDeepStrictEqual(acceptance.platforms, candidate.platforms)
  ) fail("MAC5 acceptance is stale or does not match the candidate");
  return acceptance;
}

export function createConditionalAcceptanceEvidence({
  candidateEvidencePath,
  authorizer,
  authorizedAt,
  outputPath,
}) {
  const candidateRecord = fileRecord(candidateEvidencePath);
  if (candidateRecord.size_bytes > MAX_EVIDENCE_BYTES) fail("Candidate evidence exceeds its byte budget");
  const candidate = validateAggregateEvidence(JSON.parse(fs.readFileSync(candidateEvidencePath, "utf8")));
  const expectedCandidateName = `rho-${candidate.version}-candidate-evidence.json`;
  if (candidateRecord.name !== expectedCandidateName) fail(`Expected candidate evidence ${expectedCandidateName}`);
  const expectedOutputName = `rho-${candidate.version}-acceptance.json`;
  if (path.basename(outputPath) !== expectedOutputName) fail(`Expected acceptance evidence ${expectedOutputName}`);
  if (path.resolve(path.dirname(outputPath)) !== path.resolve(path.dirname(candidateEvidencePath))) {
    fail("Acceptance evidence output is outside the candidate directory");
  }
  const acceptance = {
    schema_version: 2,
    type: "rho_candidate_acceptance",
    status: "conditional",
    decision: "CONDITIONAL_GO",
    version: candidate.version,
    release_tag: candidate.release_tag,
    commit: candidate.commit,
    candidate_evidence_sha256: candidateRecord.sha256,
    platforms: candidate.platforms,
    authorization: {
      authorized_by: authorizer,
      authorized_at: authorizedAt,
      scope: "public_prerelease_only",
      acknowledged_risks: [...CONDITIONAL_ACCEPTANCE_RISKS],
    },
    limitations: structuredClone(CONDITIONAL_ACCEPTANCE_LIMITATIONS),
  };
  validateAcceptanceEvidence(acceptance, {
    candidate,
    candidateEvidenceSha256: candidateRecord.sha256,
    publisher: authorizer,
  });
  writeJson(outputPath, acceptance);
  return acceptance;
}

export function validatePublishRecord(record) {
  const baseRecordKeys = [
    "tag_name",
    "draft",
    "prerelease",
    "target_commitish",
    "publisher",
    "assets",
    "platform_evidence",
    "candidate_evidence",
    "candidate_evidence_asset",
    "acceptance_evidence",
  ];
  const nativeRecordKeys = [
    "native_updater_evidence",
    "native_updater_evidence_asset",
    "native_updater_signatures",
  ];
  const hasNativeUpdater = nativeRecordKeys.some((key) => Object.hasOwn(record || {}, key));
  assertExactKeys(
    record,
    hasNativeUpdater ? [...baseRecordKeys, ...nativeRecordKeys] : baseRecordKeys,
    "publish record",
  );
  const candidate = validateAggregateEvidence(record.candidate_evidence);
  if (nativeUpdaterRequired(candidate.version) !== hasNativeUpdater) {
    fail(`Native updater evidence is ${nativeUpdaterRequired(candidate.version) ? "required" : "not authorized"} for ${candidate.version}`);
  }
  if (!record.draft || !record.prerelease) fail("Only a draft prerelease may be published");
  if (record.tag_name !== candidate.release_tag || record.target_commitish !== candidate.commit) {
    fail("Draft release identity does not match candidate evidence");
  }
  assertExactKeys(record.platform_evidence, CANDIDATE_PLATFORMS, "publish platform evidence");
  for (const platform of CANDIDATE_PLATFORMS) {
    validatePlatformEvidence(record.platform_evidence[platform], {
      version: candidate.version,
      release_tag: candidate.release_tag,
      commit: candidate.commit,
      platform,
      require_windows_signing: platform === "windows_x86_64" && !UNSIGNED_CANDIDATE_COMPATIBILITY.has(candidate.version),
    });
  }
  assertExactKeys(record.candidate_evidence_asset, ["name", "size_bytes", "sha256"], "candidate evidence asset");
  if (
    record.candidate_evidence_asset.name !== `rho-${candidate.version}-candidate-evidence.json`
    || !/^[0-9a-f]{64}$/.test(record.candidate_evidence_asset.sha256)
    || !Number.isSafeInteger(record.candidate_evidence_asset.size_bytes)
    || record.candidate_evidence_asset.size_bytes <= 0
    || record.candidate_evidence_asset.size_bytes > MAX_EVIDENCE_BYTES
  ) fail("Candidate evidence asset record is invalid");
  if (!validGithubLogin(record.publisher)) fail("Publish actor is invalid");
  validateAcceptanceEvidence(record.acceptance_evidence, {
    candidate,
    candidateEvidenceSha256: record.candidate_evidence_asset.sha256,
    publisher: record.publisher,
  });
  if (!Array.isArray(record.assets)) fail("Draft release assets are missing");
  const expectedNames = new Set([
    ...requiredCandidateAssetRecords(candidate).map((entry) => entry.name),
    record.candidate_evidence_asset.name,
    `rho-${candidate.version}-acceptance.json`,
  ]);
  if (hasNativeUpdater) {
    assertExactKeys(record.native_updater_signatures, NATIVE_UPDATER_PLATFORMS, "native updater signatures");
    if (record.native_updater_evidence_asset?.name !== nativeUpdaterEvidenceName(candidate.version)) {
      fail("Native updater evidence asset name is invalid");
    }
    const nativeEvidence = validateNativeUpdaterReleaseAssets({
      evidence: record.native_updater_evidence,
      evidenceAsset: record.native_updater_evidence_asset,
      candidateEvidence: candidate,
      assets: record.assets,
      signatureContents: record.native_updater_signatures,
      expected: {
        version: candidate.version,
        release_tag: candidate.release_tag,
        commit: candidate.commit,
      },
    });
    expectedNames.add(record.native_updater_evidence_asset.name);
    for (const platform of NATIVE_UPDATER_PLATFORMS) {
      expectedNames.add(nativeEvidence.platforms[platform].artifact.name);
      expectedNames.add(nativeEvidence.platforms[platform].signature.name);
    }
  }
  const actualNames = record.assets.map((entry) => entry.name);
  if (actualNames.length !== expectedNames.size || new Set(actualNames).size !== actualNames.length) {
    fail("Draft release asset set is incomplete or duplicated");
  }
  for (const asset of record.assets) {
    assertExactKeys(asset, ["name", "size", "sha256"], "draft release asset");
    if (
      !expectedNames.has(asset.name)
      || !Number.isSafeInteger(asset.size)
      || asset.size <= 0
      || !/^[0-9a-f]{64}$/.test(asset.sha256)
    ) {
      fail(`Unexpected or invalid draft release asset: ${asset.name}`);
    }
  }
  for (const expected of requiredCandidateAssetRecords(candidate)) {
    const asset = record.assets.find((entry) => entry.name === expected.name);
    if (!asset || asset.size !== expected.size_bytes || asset.sha256 !== expected.sha256) {
      fail(`Draft asset content mismatch for ${expected.name}`);
    }
  }
  const candidateAsset = record.assets.find((entry) => entry.name === record.candidate_evidence_asset.name);
  if (
    !candidateAsset
    || candidateAsset.size !== record.candidate_evidence_asset.size_bytes
    || candidateAsset.sha256 !== record.candidate_evidence_asset.sha256
  ) {
    fail("Aggregate candidate evidence content mismatch");
  }
  return { version: candidate.version, release_tag: candidate.release_tag, commit: candidate.commit };
}

function expectFailure(action, pattern) {
  let error = null;
  try { action(); } catch (caught) { error = caught; }
  if (!error || !pattern.test(String(error.message))) fail(`Expected failure matching ${pattern}`);
}

export function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-candidate-contract-"));
  try {
    const version = "0.4.0-dev.39";
    const releaseTag = `v${version}`;
    const commit = "a".repeat(40);
    validateBuildAdmission("rehearsal", REHEARSAL_REPOSITORY, "refs/heads/main", "main");
    validateBuildAdmission("candidate", CANDIDATE_REPOSITORY, "refs/heads/main", "main");
    expectFailure(
      () => validateBuildAdmission("candidate", REHEARSAL_REPOSITORY, "refs/heads/main", "main"),
      /not authorized/,
    );
    expectFailure(
      () => validateBuildAdmission("rehearsal", CANDIDATE_REPOSITORY, "refs/heads/main", "main"),
      /not authorized/,
    );
    expectFailure(
      () => validateBuildAdmission("unknown", REHEARSAL_REPOSITORY, "refs/heads/main", "main"),
      /not authorized/,
    );
    expectFailure(
      () => validateBuildAdmission("rehearsal", REHEARSAL_REPOSITORY, "refs/heads/feature", "main"),
      /default main branch/,
    );
    expectFailure(
      () => validateBuildAdmission("rehearsal", REHEARSAL_REPOSITORY, "refs/heads/main", "trunk"),
      /default main branch/,
    );
    const evidencePaths = {};
    const signingEvidence = {
      provider: "signpath",
      profile: "free_trial_self_signed",
      request_id: "12345678-1234-1234-1234-123456789abc",
      module_version: SIGNPATH_FREE_TRIAL_MODULE_VERSION,
      module_sha256: SIGNPATH_FREE_TRIAL_MODULE_SHA256,
      signer_thumbprint: "1".repeat(40),
      self_signed: true,
      signature_status: "UnknownError",
      unsigned_sha256: "2".repeat(64),
      signed_sha256: null,
    };
    for (const platform of CANDIDATE_PLATFORMS) {
      const names = expectedPlatformNames(version, platform);
      const artifactPath = path.join(root, names.artifactName);
      fs.writeFileSync(artifactPath, `${platform} candidate bytes`);
      const platformSigning = platform === "windows_x86_64"
        ? { ...signingEvidence, signed_sha256: sha256File(artifactPath) }
        : undefined;
      evidencePaths[platform] = path.join(root, names.evidenceName);
      createPlatformEvidence({
        version,
        releaseTag,
        commit,
        platform,
        artifactPath,
        outputPath: evidencePaths[platform],
        checks: platform === "windows_x86_64"
          ? [...REQUIRED_CHECKS[platform], ...LEGACY_WINDOWS_SIGNING_CHECKS]
          : REQUIRED_CHECKS[platform],
        signingEvidence: platformSigning,
      });
    }
    const macosEvidence = JSON.parse(fs.readFileSync(evidencePaths.macos_aarch64, "utf8"));
    const windowsEvidence = JSON.parse(fs.readFileSync(evidencePaths.windows_x86_64, "utf8"));
    const unsignedWindowsEvidence = {
      ...windowsEvidence,
      checks: windowsEvidence.checks.filter((check) => !LEGACY_WINDOWS_SIGNING_CHECKS.includes(check.name)),
    };
    delete unsignedWindowsEvidence.signing;
    validatePlatformEvidence(unsignedWindowsEvidence);
    expectFailure(
      () => validatePlatformEvidence(unsignedWindowsEvidence, { require_windows_signing: true }),
      /missing required signing evidence/,
    );
    expectFailure(
      () => validatePlatformEvidence({
        ...unsignedWindowsEvidence,
        checks: [...unsignedWindowsEvidence.checks, { name: "authenticode", status: "passed" }],
      }),
      /without signing evidence/,
    );
    expectFailure(
      () => validatePlatformEvidence({
        ...windowsEvidence,
        signing: { ...windowsEvidence.signing, signed_sha256: "3".repeat(64) },
      }),
      /does not match/,
    );
    expectFailure(
      () => validatePlatformEvidence({
        ...windowsEvidence,
        signing: { ...windowsEvidence.signing, signature_status: "Valid" },
      }),
      /trust state/,
    );
    for (const [field, value, pattern] of [
      ["request_id", "not-a-uuid", /request ID/],
      ["module_version", "4.4.7", /module identity/],
      ["module_sha256", "0".repeat(64), /module identity/],
      ["signer_thumbprint", "0".repeat(39), /thumbprint/],
      ["self_signed", false, /trust state/],
      ["unsigned_sha256", windowsEvidence.signing.signed_sha256, /invalid or unchanged/],
    ]) {
      expectFailure(
        () => validatePlatformEvidence({
          ...windowsEvidence,
          signing: { ...windowsEvidence.signing, [field]: value },
        }),
        pattern,
      );
    }
    expectFailure(
      () => validatePlatformEvidence({
        ...windowsEvidence,
        checks: windowsEvidence.checks.filter((check) => check.name !== "signpath_request_binding"),
      }),
      /missing required check signpath_request_binding/,
    );
    const twoStageVersion = "0.4.0-dev.42";
    const twoStageInstallerHash = "8".repeat(64);
    const twoStageBinaryHash = "7".repeat(64);
    const twoStageSigning = {
      schema_version: 2,
      provider: "signpath",
      profile: "free_trial_self_signed_two_stage",
      module_version: SIGNPATH_FREE_TRIAL_MODULE_VERSION,
      module_sha256: SIGNPATH_FREE_TRIAL_MODULE_SHA256,
      signer_thumbprint: "1".repeat(40),
      self_signed: true,
      binary_request_id: "12345678-1234-1234-1234-123456789abc",
      binary_signature_status: "UnknownError",
      binary_unsigned_sha256: "6".repeat(64),
      binary_signed_sha256: twoStageBinaryHash,
      binary_bundled_sha256: twoStageBinaryHash,
      installer_request_id: "abcdef12-abcd-abcd-abcd-abcdef123456",
      installer_signature_status: "UnknownError",
      installer_unsigned_sha256: "9".repeat(64),
      installer_signed_sha256: twoStageInstallerHash,
      installed_binary_sha256: twoStageBinaryHash,
      installed_signature_status: "UnknownError",
      installed_signer_thumbprint: "1".repeat(40),
      installed_outside_workspace: true,
      cleanup_verified: true,
    };
    const twoStageEvidence = {
      schema_version: 1,
      type: "rho_platform_candidate_evidence",
      status: "passed",
      version: twoStageVersion,
      release_tag: `v${twoStageVersion}`,
      commit,
      platform: "windows_x86_64",
      artifact: {
        name: `Rho_${twoStageVersion}_x64-setup.exe`,
        hash_name: `Rho_${twoStageVersion}_x64-setup.exe.sha256`,
        size_bytes: 42,
        sha256: twoStageInstallerHash,
      },
      checks: [...REQUIRED_CHECKS.windows_x86_64, ...TWO_STAGE_WINDOWS_SIGNING_CHECKS]
        .map((name) => ({ name, status: "passed" })),
      signing: twoStageSigning,
    };
    validatePlatformEvidence(twoStageEvidence, { require_windows_signing: true });
    for (const [field, value, pattern] of [
      ["binary_bundled_sha256", "5".repeat(64), /changed during bundling/],
      ["installed_binary_sha256", "5".repeat(64), /installed binary hash/],
      ["installer_request_id", twoStageSigning.binary_request_id, /request IDs must be distinct/],
      ["installed_signature_status", "NotSigned", /installed signature status/],
      ["installed_signer_thumbprint", "2".repeat(40), /installed signer thumbprint/],
      ["installed_outside_workspace", false, /outside the workspace/],
      ["cleanup_verified", false, /cleanup/],
    ]) {
      expectFailure(
        () => validatePlatformEvidence({
          ...twoStageEvidence,
          signing: { ...twoStageSigning, [field]: value },
        }),
        pattern,
      );
    }
    expectFailure(
      () => validatePlatformEvidence({
        ...twoStageEvidence,
        checks: twoStageEvidence.checks.map((check) => (
          check.name === "authenticode_binary" ? { ...check, name: "authenticode" } : check
        )),
      }),
      /missing required check authenticode_binary|wrong schema generation/,
    );
    expectFailure(
      () => validatePlatformEvidence({ ...macosEvidence, signing: windowsEvidence.signing }),
      /Only Windows/,
    );
    expectFailure(
      () => validatePlatformEvidence({
        ...macosEvidence,
        checks: macosEvidence.checks.filter((check) => check.name !== "entitlements"),
      }),
      /missing required check entitlements/,
    );
    expectFailure(
      () => validatePlatformEvidence({
        ...macosEvidence,
        checks: macosEvidence.checks.filter((check) => check.name !== "license_boundary"),
      }),
      /missing required check license_boundary/,
    );
    const aggregatePath = path.join(root, `rho-${version}-candidate-evidence.json`);
    const candidate = createAggregateEvidence({
      version,
      releaseTag,
      commit,
      directory: root,
      windowsEvidencePath: evidencePaths.windows_x86_64,
      macosEvidencePath: evidencePaths.macos_aarch64,
      outputPath: aggregatePath,
      requireWindowsSigning: true,
    });
    const rehearsalPath = path.join(root, `rho-${version}-rehearsal-evidence.json`);
    const rehearsal = createRehearsalEvidence({
      candidateEvidencePath: aggregatePath,
      sourceRepository: REHEARSAL_REPOSITORY,
      runId: "123456789",
      runAttempt: 1,
      outputPath: rehearsalPath,
    });
    validateRehearsalEvidence(rehearsal, {
      source_repository: REHEARSAL_REPOSITORY,
      version,
      release_tag: releaseTag,
      commit,
      run_id: "123456789",
      run_attempt: 1,
    });
    const candidateAsset = fileRecord(aggregatePath);
    const acceptance = {
      schema_version: 1,
      type: "rho_candidate_acceptance",
      status: "passed",
      decision: "GO",
      version,
      release_tag: releaseTag,
      commit,
      candidate_evidence_sha256: candidateAsset.sha256,
      platforms: candidate.platforms,
    };
    const assets = [
      ...requiredCandidateAssetRecords(candidate).map((entry) => ({ name: entry.name, size: entry.size_bytes, sha256: entry.sha256 })),
      { name: candidateAsset.name, size: candidateAsset.size_bytes, sha256: candidateAsset.sha256 },
      { name: `rho-${version}-acceptance.json`, size: 100, sha256: "e".repeat(64) },
    ];
    const record = {
      tag_name: releaseTag,
      draft: true,
      prerelease: true,
      target_commitish: commit,
      publisher: "xiayh17",
      assets,
      platform_evidence: Object.fromEntries(CANDIDATE_PLATFORMS.map((platform) => [
        platform,
        JSON.parse(fs.readFileSync(evidencePaths[platform], "utf8")),
      ])),
      candidate_evidence: candidate,
      candidate_evidence_asset: candidateAsset,
      acceptance_evidence: acceptance,
    };
    validatePublishRecord(record);

    const updaterVersion = "0.4.0-dev.40";
    const updaterTag = `v${updaterVersion}`;
    const updaterRoot = path.join(root, "native-updater");
    fs.mkdirSync(updaterRoot);
    const updaterEvidencePaths = {};
    const updaterPlatformEvidence = {};
    for (const platform of CANDIDATE_PLATFORMS) {
      const names = expectedPlatformNames(updaterVersion, platform);
      const artifactPath = path.join(updaterRoot, names.artifactName);
      fs.writeFileSync(artifactPath, `${platform} native updater candidate bytes`);
      const platformSigning = platform === "windows_x86_64"
        ? { ...signingEvidence, signed_sha256: sha256File(artifactPath) }
        : undefined;
      updaterEvidencePaths[platform] = path.join(updaterRoot, names.evidenceName);
      createPlatformEvidence({
        version: updaterVersion,
        releaseTag: updaterTag,
        commit,
        platform,
        artifactPath,
        outputPath: updaterEvidencePaths[platform],
        checks: platform === "windows_x86_64"
          ? [...REQUIRED_CHECKS[platform], ...LEGACY_WINDOWS_SIGNING_CHECKS]
          : [...REQUIRED_CHECKS[platform], "native_updater_archive"],
        signingEvidence: platformSigning,
      });
      updaterPlatformEvidence[platform] = JSON.parse(fs.readFileSync(updaterEvidencePaths[platform], "utf8"));
    }
    const updaterAggregatePath = path.join(updaterRoot, `rho-${updaterVersion}-candidate-evidence.json`);
    const updaterCandidate = createAggregateEvidence({
      version: updaterVersion,
      releaseTag: updaterTag,
      commit,
      directory: updaterRoot,
      windowsEvidencePath: updaterEvidencePaths.windows_x86_64,
      macosEvidencePath: updaterEvidencePaths.macos_aarch64,
      outputPath: updaterAggregatePath,
      requireWindowsSigning: true,
    });
    const updaterSignature = Buffer.from("untrusted comment: Rho test signature\nRURvby10ZXN0LXNpZ25hdHVyZQ==\n", "utf8").toString("base64");
    const macosUpdaterArtifact = path.join(updaterRoot, `Rho_${updaterVersion}_aarch64.app.tar.gz`);
    fs.writeFileSync(macosUpdaterArtifact, "notarized and stapled updater app archive");
    for (const artifactPath of [
      path.join(updaterRoot, `Rho_${updaterVersion}_x64-setup.exe`),
      macosUpdaterArtifact,
    ]) fs.writeFileSync(`${artifactPath}.sig`, updaterSignature);
    const updaterEvidencePath = path.join(updaterRoot, nativeUpdaterEvidenceName(updaterVersion));
    const updaterEvidence = createNativeUpdaterEvidence({
      version: updaterVersion,
      releaseTag: updaterTag,
      commit,
      directory: updaterRoot,
      outputPath: updaterEvidencePath,
    });
    const updaterCandidateAsset = fileRecord(updaterAggregatePath);
    const updaterEvidenceAsset = fileRecord(updaterEvidencePath);
    const updaterAcceptance = {
      schema_version: 1,
      type: "rho_candidate_acceptance",
      status: "passed",
      decision: "GO",
      version: updaterVersion,
      release_tag: updaterTag,
      commit,
      candidate_evidence_sha256: updaterCandidateAsset.sha256,
      platforms: updaterCandidate.platforms,
    };
    const updaterAssets = [...new Map([
      ...requiredCandidateAssetRecords(updaterCandidate).map((entry) => ({ name: entry.name, size: entry.size_bytes, sha256: entry.sha256 })),
      { name: updaterCandidateAsset.name, size: updaterCandidateAsset.size_bytes, sha256: updaterCandidateAsset.sha256 },
      { name: updaterEvidenceAsset.name, size: updaterEvidenceAsset.size_bytes, sha256: updaterEvidenceAsset.sha256 },
      { name: `rho-${updaterVersion}-acceptance.json`, size: 100, sha256: "e".repeat(64) },
      ...NATIVE_UPDATER_PLATFORMS.flatMap((platform) => {
        const native = updaterEvidence.platforms[platform];
        return [native.artifact, native.signature].map((entry) => ({
          name: entry.name,
          size: entry.size_bytes,
          sha256: entry.sha256,
        }));
      }),
    ].map((asset) => [asset.name, asset])).values()];
    const updaterRecord = {
      tag_name: updaterTag,
      draft: true,
      prerelease: true,
      target_commitish: commit,
      publisher: "xiayh17",
      assets: updaterAssets,
      platform_evidence: updaterPlatformEvidence,
      candidate_evidence: updaterCandidate,
      candidate_evidence_asset: updaterCandidateAsset,
      acceptance_evidence: updaterAcceptance,
      native_updater_evidence: updaterEvidence,
      native_updater_evidence_asset: updaterEvidenceAsset,
      native_updater_signatures: Object.fromEntries(NATIVE_UPDATER_PLATFORMS.map((platform) => [platform, updaterSignature])),
    };
    validatePublishRecord(updaterRecord);
    const updaterRecordWithoutEvidence = structuredClone(updaterRecord);
    delete updaterRecordWithoutEvidence.native_updater_evidence;
    delete updaterRecordWithoutEvidence.native_updater_evidence_asset;
    delete updaterRecordWithoutEvidence.native_updater_signatures;
    expectFailure(() => validatePublishRecord(updaterRecordWithoutEvidence), /Native updater evidence is required/);
    expectFailure(
      () => validatePublishRecord({
        ...updaterRecord,
        native_updater_signatures: { ...updaterRecord.native_updater_signatures, windows_x86_64: updaterSignature.replace(/.$/, "A") },
      }),
      /signature/,
    );
    const conditionalAcceptance = {
      ...acceptance,
      schema_version: 2,
      status: "conditional",
      decision: "CONDITIONAL_GO",
      authorization: {
        authorized_by: "xiayh17",
        authorized_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z"),
        scope: "public_prerelease_only",
        acknowledged_risks: [...CONDITIONAL_ACCEPTANCE_RISKS],
      },
      limitations: structuredClone(CONDITIONAL_ACCEPTANCE_LIMITATIONS),
    };
    validatePublishRecord({ ...record, acceptance_evidence: conditionalAcceptance });
    const generatedAcceptancePath = path.join(root, `rho-${version}-acceptance.json`);
    const generatedAcceptance = createConditionalAcceptanceEvidence({
      candidateEvidencePath: aggregatePath,
      authorizer: "xiayh17",
      authorizedAt: conditionalAcceptance.authorization.authorized_at,
      outputPath: generatedAcceptancePath,
    });
    assertExactKeys(
      generatedAcceptance,
      [
        "schema_version",
        "type",
        "status",
        "decision",
        "version",
        "release_tag",
        "commit",
        "candidate_evidence_sha256",
        "platforms",
        "authorization",
        "limitations",
      ],
      "generated conditional acceptance",
    );
    if (!isDeepStrictEqual(generatedAcceptance, conditionalAcceptance)) {
      fail("Generated conditional acceptance is not canonical");
    }
    expectFailure(
      () => createConditionalAcceptanceEvidence({
        candidateEvidencePath: aggregatePath,
        authorizer: "xiayh17",
        authorizedAt: conditionalAcceptance.authorization.authorized_at,
        outputPath: generatedAcceptancePath,
      }),
      /EEXIST|file already exists/,
    );
    const foreignAcceptanceDirectory = path.join(root, "foreign-acceptance");
    fs.mkdirSync(foreignAcceptanceDirectory);
    expectFailure(
      () => createConditionalAcceptanceEvidence({
        candidateEvidencePath: aggregatePath,
        authorizer: "xiayh17",
        authorizedAt: conditionalAcceptance.authorization.authorized_at,
        outputPath: path.join(foreignAcceptanceDirectory, `rho-${version}-acceptance.json`),
      }),
      /outside the candidate directory/,
    );
    expectFailure(
      () => validateRehearsalEvidence({ ...rehearsal, source_repository: "YuLab-SMU/Rho" }),
      /not authorized/,
    );
    expectFailure(
      () => validateRehearsalEvidence(rehearsal, { commit: "b".repeat(40) }),
      /commit mismatch/,
    );
    expectFailure(
      () => validateRehearsalEvidence({ ...rehearsal, run_id: "0" }),
      /run ID is invalid/,
    );
    expectFailure(
      () => validateRehearsalEvidence({ ...rehearsal, run_attempt: 0 }),
      /run attempt is invalid/,
    );
    expectFailure(
      () => validateRehearsalEvidence({ ...rehearsal, padding: "x".repeat(MAX_EVIDENCE_BYTES) }),
      /byte budget/,
    );
    expectFailure(
      () => createRehearsalEvidence({
        candidateEvidencePath: aggregatePath,
        sourceRepository: "YuLab-SMU/Rho",
        runId: "123456789",
        runAttempt: 1,
        outputPath: path.join(root, `rho-${version}-rehearsal-evidence-foreign.json`),
      }),
      /Expected rehearsal evidence/,
    );
    const foreignRehearsalDirectory = path.join(root, "foreign-rehearsal");
    fs.mkdirSync(foreignRehearsalDirectory);
    expectFailure(
      () => createRehearsalEvidence({
        candidateEvidencePath: aggregatePath,
        sourceRepository: REHEARSAL_REPOSITORY,
        runId: "123456789",
        runAttempt: 1,
        outputPath: path.join(foreignRehearsalDirectory, `rho-${version}-rehearsal-evidence.json`),
      }),
      /outside the candidate directory/,
    );
    expectFailure(() => validateAggregateEvidence(rehearsal), /candidate evidence keys are invalid/);
    expectFailure(
      () => validatePublishRecord({ ...record, candidate_evidence: rehearsal }),
      /candidate evidence keys are invalid/,
    );
    expectFailure(() => validateCandidateIdentity("0.4.0-dev..1", "v0.4.0-dev..1", commit), /not prerelease SemVer/);
    expectFailure(() => validateCandidateIdentity("0.4.0-dev.01", "v0.4.0-dev.01", commit), /not prerelease SemVer/);
    expectFailure(() => validatePublishRecord({ ...record, draft: false }), /draft prerelease/);
    expectFailure(
      () => validatePublishRecord({ ...record, acceptance_evidence: { ...acceptance, decision: "NO-GO" } }),
      /passed GO/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: { ...conditionalAcceptance, status: "passed" },
      }),
      /conditional CONDITIONAL_GO/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        publisher: "other-owner",
        acceptance_evidence: conditionalAcceptance,
      }),
      /publish actor/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          authorization: {
            ...conditionalAcceptance.authorization,
            authorized_at: "2999-01-01T00:00:00Z",
          },
        },
      }),
      /future/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          authorization: {
            ...conditionalAcceptance.authorization,
            authorized_at: "2026-08-13T12:34:56.000Z",
          },
        },
      }),
      /canonical UTC/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          authorization: {
            ...conditionalAcceptance.authorization,
            unexpected: true,
          },
        },
      }),
      /authorization keys are invalid/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          authorization: {
            ...conditionalAcceptance.authorization,
            acknowledged_risks: [...CONDITIONAL_ACCEPTANCE_RISKS].reverse(),
          },
        },
      }),
      /risks/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          authorization: {
            ...conditionalAcceptance.authorization,
            acknowledged_risks: CONDITIONAL_ACCEPTANCE_RISKS.slice(0, 1),
          },
        },
      }),
      /risks/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          limitations: structuredClone(CONDITIONAL_ACCEPTANCE_LIMITATIONS).reverse(),
        },
      }),
      /limitations/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          limitations: CONDITIONAL_ACCEPTANCE_LIMITATIONS.slice(0, 1),
        },
      }),
      /limitations/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: {
          ...conditionalAcceptance,
          limitations: CONDITIONAL_ACCEPTANCE_LIMITATIONS.map((entry, index) => (
            index === 0 ? { ...entry, reason_code: "manual_test_failed" } : entry
          )),
        },
      }),
      /limitations/,
    );
    expectFailure(
      () => validateAcceptanceEvidence(
        { ...conditionalAcceptance, version: "0.4.0-dev.40", release_tag: "v0.4.0-dev.40" },
        {
          candidate: { ...candidate, version: "0.4.0-dev.40", release_tag: "v0.4.0-dev.40" },
          candidateEvidenceSha256: candidateAsset.sha256,
          publisher: "xiayh17",
        },
      ),
      /not authorized/,
    );
    expectFailure(
      () => validateAcceptanceEvidence(
        { ...conditionalAcceptance, version: "0.4.0", release_tag: "v0.4.0" },
        {
          candidate: { ...candidate, version: "0.4.0", release_tag: "v0.4.0" },
          candidateEvidenceSha256: candidateAsset.sha256,
          publisher: "xiayh17",
        },
      ),
      /not authorized/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: { ...acceptance, limitations: [] },
      }),
      /acceptance evidence keys are invalid/,
    );
    expectFailure(
      () => validatePublishRecord({
        ...record,
        acceptance_evidence: { ...conditionalAcceptance, unexpected: true },
      }),
      /acceptance evidence keys are invalid/,
    );
    const mismatchedAsset = JSON.parse(JSON.stringify(record));
    mismatchedAsset.assets[0].sha256 = "f".repeat(64);
    expectFailure(() => validatePublishRecord(mismatchedAsset), /content mismatch/);
    expectFailure(
      () => validatePublishRecord({
        ...record,
        candidate_evidence_asset: { ...candidateAsset, size_bytes: MAX_EVIDENCE_BYTES + 1 },
      }),
      /invalid/,
    );
    expectFailure(() => validateAggregateEvidence({ ...candidate, platforms: { windows_x86_64: candidate.platforms.windows_x86_64 } }), /candidate platforms keys/);
    const tampered = JSON.parse(JSON.stringify(record));
    tampered.acceptance_evidence.commit = "b".repeat(40);
    expectFailure(() => validatePublishRecord(tampered), /stale/);
    const foreignDirectory = path.join(root, "foreign");
    fs.mkdirSync(foreignDirectory);
    const foreignEvidence = path.join(foreignDirectory, path.basename(evidencePaths.windows_x86_64));
    fs.copyFileSync(evidencePaths.windows_x86_64, foreignEvidence);
    expectFailure(
      () => createAggregateEvidence({
        version,
        releaseTag,
        commit,
        directory: root,
        windowsEvidencePath: foreignEvidence,
        macosEvidencePath: evidencePaths.macos_aarch64,
        outputPath: aggregatePath,
      }),
      /outside the candidate directory/,
    );
    fs.appendFileSync(path.join(root, expectedPlatformNames(version, "macos_aarch64").artifactName), "tampered");
    expectFailure(
      () => createAggregateEvidence({
        version,
        releaseTag,
        commit,
        directory: root,
        windowsEvidencePath: evidencePaths.windows_x86_64,
        macosEvidencePath: evidencePaths.macos_aarch64,
        outputPath: aggregatePath,
      }),
      /does not match evidence/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write("Rho candidate release contract tests passed.\n");
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.test === "true") return selfTest();
  if (args.mode === "admission") {
    process.stdout.write(`${JSON.stringify(validateBuildAdmission(
      args.build_mode,
      args.repository,
      args.workflow_ref,
      args.default_branch,
    ))}\n`);
    return;
  }
  if (args.mode === "identity") {
    process.stdout.write(`${JSON.stringify(validateCandidateIdentity(args.version, args.tag, args.commit))}\n`);
    return;
  }
  if (args.mode === "platform") {
    let signingEvidence;
    if (args.signing) {
      if (path.resolve(path.dirname(args.signing)) !== path.resolve(path.dirname(args.artifact))) {
        fail("Windows signing evidence input is outside the artifact directory");
      }
      const signingStat = fs.lstatSync(args.signing);
      if (signingStat.isSymbolicLink() || !signingStat.isFile() || signingStat.size <= 0 || signingStat.size > MAX_SIGNING_EVIDENCE_BYTES) {
        fail("Windows signing evidence input is missing, invalid, or exceeds its byte budget");
      }
      signingEvidence = JSON.parse(fs.readFileSync(args.signing, "utf8"));
    }
    createPlatformEvidence({
      version: args.version,
      releaseTag: args.tag,
      commit: args.commit,
      platform: args.platform,
      artifactPath: args.artifact,
      outputPath: args.output,
      checks: String(args.checks || "").split(",").filter(Boolean),
      signingEvidence,
    });
    return;
  }
  if (args.mode === "aggregate") {
    createAggregateEvidence({
      version: args.version,
      releaseTag: args.tag,
      commit: args.commit,
      directory: args.directory,
      windowsEvidencePath: args.windows_evidence,
      macosEvidencePath: args.macos_evidence,
      outputPath: args.output,
      requireWindowsSigning: args.require_windows_signing === "true",
    });
    return;
  }
  if (args.mode === "rehearsal") {
    createRehearsalEvidence({
      candidateEvidencePath: args.input,
      sourceRepository: args.repository,
      runId: args.run_id,
      runAttempt: args.run_attempt,
      outputPath: args.output,
    });
    return;
  }
  if (args.mode === "conditional-acceptance") {
    createConditionalAcceptanceEvidence({
      candidateEvidencePath: args.input,
      authorizer: args.authorizer,
      authorizedAt: args.authorized_at,
      outputPath: args.output,
    });
    return;
  }
  if (args.mode === "publish") {
    const result = validatePublishRecord(JSON.parse(fs.readFileSync(args.input, "utf8")));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  fail("Use --test true or --mode admission|identity|platform|aggregate|rehearsal|conditional-acceptance|publish with the required arguments");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
