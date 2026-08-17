import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  candidatePlatformsForVersion,
  validateAcceptanceEvidence,
  validateAggregateEvidence,
  validatePublishedPlatformEvidence,
} from "./candidate-release.mjs";
import {
  nativeUpdaterPlatformsForVersion,
  tauriManifestFromEvidence,
  validateNativeUpdaterEvidence,
} from "./tauri-native-updater.mjs";

const WEBSITE = "https://yulab-smu.top/Rho/";
const REPOSITORY = "https://github.com/YuLab-SMU/Rho";
const PRIVACY_POLICY = `${REPOSITORY}/blob/main/PRIVACY.md`;
const SECURITY_POLICY = `${REPOSITORY}/blob/main/SECURITY.md`;
const CODE_SIGNING_POLICY = `${REPOSITORY}/blob/main/CODE_SIGNING_POLICY.md`;
const LICENSE_URL = `${REPOSITORY}/blob/main/LICENSE`;
const SIGNPATH_IO = "https://about.signpath.io";
const SIGNPATH_FOUNDATION = "https://signpath.org";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION_PATTERN = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] == null) throw new Error(`Invalid argument at ${key || "end of input"}`);
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid SemVer: ${value}`);
  return { raw: value, core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") || [] };
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber != null && rightNumber != null) return leftNumber - rightNumber;
  if (leftNumber != null) return -1;
  if (rightNumber != null) return 1;
  return left.localeCompare(right, "en");
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (!left.pre.length && right.pre.length) return 1;
  if (left.pre.length && !right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] == null) return -1;
    if (right.pre[index] == null) return 1;
    const compared = compareIdentifier(left.pre[index], right.pre[index]);
    if (compared) return compared;
  }
  return 0;
}

function assertArtifactHash(hash, version) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Artifact SHA-256 is invalid for ${version}`);
}

function releaseAsset(record, name, size, version) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Artifact size is invalid for ${version}`);
  const asset = record.assets?.find((item) => item.name === name);
  if (!asset || asset.size !== size) throw new Error(`Release asset ${name} does not match evidence for ${version}`);
  const expectedUrl = `${REPOSITORY}/releases/download/v${version}/${name}`;
  if (asset.browser_download_url !== expectedUrl) throw new Error(`Release asset URL is not allowlisted for ${version}`);
  return asset;
}

function validatedLegacyArtifacts(record, evidence, version) {
  const artifact = evidence.artifact;
  if (!artifact?.installer_name || !artifact?.sha256 || !artifact?.size_bytes) {
    throw new Error(`Artifact evidence is incomplete for ${version}`);
  }
  assertArtifactHash(artifact.sha256, version);
  const asset = releaseAsset(record, artifact.installer_name, artifact.size_bytes, version);
  return {
    artifacts: {
      windows_x86_64: { url: asset.browser_download_url, sha256: artifact.sha256, size: artifact.size_bytes },
    },
    windows_signing_profile: "unsigned",
    acceptance_decision: "GO",
  };
}

function validatedCandidateArtifacts(record, evidence, version) {
  validateAggregateEvidence(evidence);
  if (evidence.version !== version || evidence.release_tag !== `v${version}`) {
    throw new Error(`Candidate evidence identity mismatch for ${version}`);
  }
  if (record.target_commitish !== evidence.commit) throw new Error(`Candidate commit mismatch for ${version}`);
  const acceptance = validateAcceptanceEvidence(record.acceptance_evidence, {
    candidate: evidence,
    candidateEvidenceSha256: record.evidence_sha256,
  });
  const suppliedPlatformEvidence = record.platform_evidence;
  const candidatePlatforms = candidatePlatformsForVersion(version);
  if (!suppliedPlatformEvidence || JSON.stringify(Object.keys(suppliedPlatformEvidence).sort()) !== JSON.stringify([...candidatePlatforms].sort())) {
    throw new Error(`Complete platform evidence is missing for ${version}`);
  }
  const artifacts = {};
  let windowsSigningProfile = "unsigned";
  for (const platform of candidatePlatforms) {
    const platformEvidence = evidence.platforms[platform];
    const supplied = suppliedPlatformEvidence[platform];
    if (
      !supplied
      || supplied.size_bytes !== platformEvidence.evidence.size_bytes
      || supplied.sha256 !== platformEvidence.evidence.sha256
    ) throw new Error(`Platform evidence content mismatch for ${platform}`);
    validatePublishedPlatformEvidence(supplied.content, {
      version: evidence.version,
      release_tag: evidence.release_tag,
      commit: evidence.commit,
      platform,
    });
    if (platform === "windows_x86_64" && supplied.content.signing) {
      windowsSigningProfile = supplied.content.signing.profile;
    }
    for (const value of Object.values(platformEvidence)) releaseAsset(record, value.name, value.size_bytes, version);
    const artifact = platformEvidence.artifact;
    assertArtifactHash(artifact.sha256, version);
    const asset = releaseAsset(record, artifact.name, artifact.size_bytes, version);
    artifacts[platform] = { url: asset.browser_download_url, sha256: artifact.sha256, size: artifact.size_bytes };
  }
  return {
    artifacts,
    windows_signing_profile: windowsSigningProfile,
    acceptance_decision: acceptance.decision,
  };
}

function validatedNativeUpdater(record, candidateEvidence, version) {
  if (record.native_updater_evidence == null) return null;
  const nativeEvidence = record.native_updater_evidence;
  const nativeEvidenceAsset = record.native_updater_evidence_asset;
  if (!nativeEvidenceAsset || typeof nativeEvidenceAsset !== "object") {
    throw new Error(`Native updater evidence asset is missing for ${version}`);
  }
  const evidenceName = `rho-${version}-tauri-native-updater-evidence.json`;
  if (
    nativeEvidenceAsset.name !== evidenceName
    || !Number.isSafeInteger(nativeEvidenceAsset.size_bytes)
    || nativeEvidenceAsset.size_bytes <= 0
    || nativeEvidenceAsset.size_bytes > 256 * 1024
    || !/^[0-9a-f]{64}$/.test(nativeEvidenceAsset.sha256)
  ) throw new Error(`Native updater evidence asset is invalid for ${version}`);
  releaseAsset(record, nativeEvidenceAsset.name, nativeEvidenceAsset.size_bytes, version);
  validateNativeUpdaterEvidence(nativeEvidence, {
    version,
    release_tag: `v${version}`,
    commit: record.target_commitish,
    candidate_evidence: candidateEvidence,
  });
  if (!record.native_updater_signatures || typeof record.native_updater_signatures !== "object") {
    throw new Error(`Native updater signatures are missing for ${version}`);
  }
  for (const platform of nativeUpdaterPlatformsForVersion(version)) {
    const platformEvidence = nativeEvidence.platforms[platform];
    releaseAsset(record, platformEvidence.artifact.name, platformEvidence.artifact.size_bytes, version);
    releaseAsset(record, platformEvidence.signature.name, platformEvidence.signature.size_bytes, version);
    if (typeof record.native_updater_signatures[platform] !== "string") {
      throw new Error(`Native updater signature contents are missing for ${version} ${platform}`);
    }
  }
  return {
    evidence: nativeEvidence,
    signature_contents: record.native_updater_signatures,
  };
}

function validatedRelease(record) {
  if (record.draft) throw new Error(`Draft release is not publishable: ${record.tag_name}`);
  if (!String(record.tag_name || "").startsWith("v")) throw new Error(`Release tag must start with v: ${record.tag_name}`);
  const version = record.tag_name.slice(1);
  const parsed = parseVersion(version);
  if (record.tag_name !== `v${version}`) throw new Error(`Release tag is invalid for ${version}`);
  if (Boolean(record.prerelease) !== (parsed.pre.length > 0)) throw new Error(`Release channel metadata mismatch for ${version}`);
  if (record.html_url !== `${REPOSITORY}/releases/tag/v${version}`) throw new Error(`Release URL is not allowlisted for ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.published_at) || !Number.isFinite(Date.parse(record.published_at))) {
    throw new Error(`Release publication time is invalid for ${version}`);
  }
  const evidence = record.evidence;
  if (!evidence || evidence.status !== "passed") throw new Error(`Passed release evidence is missing for ${version}`);
  if (evidence.version !== version || evidence.release_tag !== `v${version}`) throw new Error(`Evidence identity mismatch for ${version}`);
  let validatedArtifacts;
  let nativeUpdater = null;
  if (evidence.type === "rho_candidate_evidence") {
    validatedArtifacts = validatedCandidateArtifacts(record, evidence, version);
    nativeUpdater = validatedNativeUpdater(record, evidence, version);
  } else if ((!evidence.type || evidence.type === "rho_0_2_release_evidence") && evidence.artifact) {
    validatedArtifacts = validatedLegacyArtifacts(record, evidence, version);
  } else {
    throw new Error(`Unsupported release evidence type for ${version}`);
  }
  const summary = [...String(record.summary || `Rho ${version} is available.`)].slice(0, 500).join("");
  if ([...summary].some((character) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(character))) {
    throw new Error(`Release summary contains control characters for ${version}`);
  }
  return {
    parsed,
    version,
    prerelease: parsed.pre.length > 0,
    published_at: record.published_at,
    commit: record.target_commitish,
    summary,
    github_release_url: record.html_url,
    artifacts: validatedArtifacts.artifacts,
    windows_signing_profile: validatedArtifacts.windows_signing_profile,
    acceptance_decision: validatedArtifacts.acceptance_decision,
    native_updater: nativeUpdater,
  };
}

function manifest(release, channel) {
  return {
    schema_version: 1,
    channel,
    version: release.version,
    published_at: release.published_at,
    summary: release.summary,
    release_page_url: WEBSITE,
    github_release_url: release.github_release_url,
    artifacts: release.artifacts,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function artifactDownload(platform, artifact) {
  const label = platform === "windows_x86_64"
    ? "Download for Windows x64"
    : platform === "macos_aarch64" ? "Download for macOS (Apple Silicon)" : "Download for Linux x86-64";
  return `<div class="artifact"><a class="download" href="${escapeHtml(artifact.url)}">${label}</a><details><summary>Verify download</summary><code>SHA-256 ${escapeHtml(artifact.sha256)}</code></details></div>`;
}

function windowsTrustNotice(profile) {
  if (String(profile).startsWith("free_trial_self_signed")) {
    return "Windows trust: Authenticode-signed with a SignPath Free Trial self-signed test certificate. It is not publicly trusted; Windows or SmartScreen may still warn.";
  }
  return "Windows trust: unsigned. Windows or SmartScreen may warn.";
}

function acceptanceNotice(decision) {
  if (decision !== "CONDITIONAL_GO") return "";
  return '<p class="warning"><strong>Conditional prerelease:</strong> Windows human installation and enabled-Gatekeeper macOS human launch were not run. Automated candidate checks passed, but this build is for evaluation only.</p>';
}

function releaseBlock(title, release) {
  if (!release) return `<section><h2>${title}</h2><p>Not available yet.</p></section>`;
  const downloads = Object.entries(release.artifacts).map(([platform, artifact]) => artifactDownload(platform, artifact)).join("");
  const trust = release.artifacts.windows_x86_64
    ? `<p>${escapeHtml(windowsTrustNotice(release.windows_signing_profile))}</p>`
    : "";
  return `<section><h2>${title}</h2><p class="version">Rho ${escapeHtml(release.version)}</p><p>${escapeHtml(release.summary)}</p>${acceptanceNotice(release.acceptance_decision)}<p>Published ${escapeHtml(release.published_at.slice(0, 10))}</p>${downloads}${trust}</section>`;
}

function page(stable, development) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rho Downloads</title><style>body{margin:0;color:#203033;background:#f5f7f7;font:15px/1.55 system-ui,sans-serif}header,main,footer{max-width:760px;margin:auto;padding:28px 22px}header{padding-top:64px}h1{margin:0;font:700 42px Georgia,serif}header p{color:#526568}section{padding:24px 0;border-top:1px solid #cbd4d5}h2{font-size:18px}.version{font-size:24px;font-weight:700}.warning{padding:12px;border:1px solid #b7791f;border-radius:5px;background:#fff8e6;color:#6b4300}.artifact{margin:16px 0}.download{display:inline-block;padding:9px 13px;border-radius:5px;color:white;background:#167568;text-decoration:none}details{margin-top:8px;color:#526568}code{display:block;margin-top:8px;overflow-wrap:anywhere}footer{color:#657679;font-size:13px}a{color:#126b61}</style></head><body><header><h1>Rho</h1><p>An agent-native scientific workbench for R.</p></header><main>${releaseBlock("Stable", stable)}${releaseBlock("Development", development)}<p>Installers are hosted by GitHub Releases. In some networks a download may be unavailable even when this page is reachable.</p><section><h2>Windows code-signing status</h2><p>Rho is applying to SignPath Foundation for publicly trusted Windows code signing. Some development releases may instead carry a SignPath Free Trial self-signed test signature; that does not establish Foundation acceptance, a production publisher, public trust, or SmartScreen reputation. The exact status is shown with each release. If accepted, future production releases will use the attribution: “Free code signing provided by <a href="${SIGNPATH_IO}">SignPath.io</a>, certificate by <a href="${SIGNPATH_FOUNDATION}">SignPath Foundation</a>.” See the <a href="${CODE_SIGNING_POLICY}">Code signing policy</a>.</p></section><section><h2>Uninstall Rho</h2><p>On Windows, open <strong>Settings &gt; Apps &gt; Installed apps</strong>, choose <strong>Rho</strong>, then choose <strong>Uninstall</strong>. On macOS, quit Rho and move <strong>Rho.app</strong> from <strong>Applications</strong> to the Trash. On Linux, quit Rho and delete the downloaded <strong>Rho AppImage</strong>.</p><p>Uninstalling does not automatically delete project files, local application data, logs, or operating-system credential-store entries. Review the <a href="${PRIVACY_POLICY}">Privacy policy</a> before removing retained data.</p></section></main><footer><p>Listed macOS builds are Developer ID signed and notarized. Windows trust status is shown per release. Verify every download with its SHA-256 checksum.</p><p><a href="${REPOSITORY}">Source repository</a> · <a href="${LICENSE_URL}">License</a> · <a href="${PRIVACY_POLICY}">Privacy policy</a> · <a href="${SECURITY_POLICY}">Security</a> · <a href="${CODE_SIGNING_POLICY}">Code signing policy</a></p></footer></body></html>`;
}

export function generate(records, outputDirectory) {
  const releases = records.map(validatedRelease).sort((left, right) => compareVersions(right.parsed, left.parsed));
  const stable = releases.find((release) => !release.prerelease) || null;
  const development = releases[0] || null;
  if (!development) throw new Error("At least one validated release is required");
  const nativeStable = releases.find((release) => !release.prerelease && release.native_updater) || null;
  const nativeDevelopment = releases.find((release) => release.native_updater) || null;
  fs.mkdirSync(path.join(outputDirectory, "updates"), { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "index.html"), page(stable, development));
  fs.writeFileSync(path.join(outputDirectory, "updates", "development.json"), `${JSON.stringify(manifest(development, "development"), null, 2)}\n`);
  const stablePath = path.join(outputDirectory, "updates", "stable.json");
  if (stable) fs.writeFileSync(stablePath, `${JSON.stringify(manifest(stable, "stable"), null, 2)}\n`);
  else if (fs.existsSync(stablePath)) fs.unlinkSync(stablePath);
  const nativeDirectory = path.join(outputDirectory, "updates", "tauri");
  fs.mkdirSync(nativeDirectory, { recursive: true });
  const nativeDevelopmentPath = path.join(nativeDirectory, "development.json");
  if (nativeDevelopment) {
    const nativeManifest = tauriManifestFromEvidence({
      release: {
        version: nativeDevelopment.version,
        release_tag: `v${nativeDevelopment.version}`,
        commit: nativeDevelopment.commit,
        published_at: nativeDevelopment.published_at,
        summary: nativeDevelopment.summary,
      },
      evidence: nativeDevelopment.native_updater.evidence,
      signatureContents: nativeDevelopment.native_updater.signature_contents,
      channel: "development",
    });
    fs.writeFileSync(nativeDevelopmentPath, `${JSON.stringify(nativeManifest, null, 2)}\n`);
  } else if (fs.existsSync(nativeDevelopmentPath)) fs.unlinkSync(nativeDevelopmentPath);
  const nativeStablePath = path.join(nativeDirectory, "stable.json");
  if (nativeStable) {
    const nativeManifest = tauriManifestFromEvidence({
      release: {
        version: nativeStable.version,
        release_tag: `v${nativeStable.version}`,
        commit: nativeStable.commit,
        published_at: nativeStable.published_at,
        summary: nativeStable.summary,
      },
      evidence: nativeStable.native_updater.evidence,
      signatureContents: nativeStable.native_updater.signature_contents,
      channel: "stable",
    });
    fs.writeFileSync(nativeStablePath, `${JSON.stringify(nativeManifest, null, 2)}\n`);
  } else if (fs.existsSync(nativeStablePath)) fs.unlinkSync(nativeStablePath);
  return {
    stable: stable?.version || null,
    development: development.version,
    native_stable: nativeStable?.version || null,
    native_development: nativeDevelopment?.version || null,
  };
}

function fakeRecord(version, prerelease = true) {
  return {
    tag_name: `v${version}`,
    target_commitish: "a".repeat(40),
    draft: false,
    prerelease,
    published_at: "2026-07-25T00:00:00Z",
    html_url: `${REPOSITORY}/releases/tag/v${version}`,
    summary: `Release ${version}`,
    assets: [{ name: `Rho_${version}_x64-setup.exe`, size: 100, browser_download_url: `${REPOSITORY}/releases/download/v${version}/Rho_${version}_x64-setup.exe` }],
    evidence: { type: "rho_0_2_release_evidence", status: "passed", version, release_tag: `v${version}`, artifact: { installer_name: `Rho_${version}_x64-setup.exe`, size_bytes: 100, sha256: "a".repeat(64) } },
  };
}

function fakeCandidateRecord(version) {
  const record = fakeRecord(version);
  const twoStageWindows = version === "0.4.0-dev.43";
  const platforms = {};
  const details = {
    windows_x86_64: [`Rho_${version}_x64-setup.exe`, `rho-${version}-windows-x86_64-evidence.json`],
    macos_aarch64: [`Rho_${version}_aarch64.dmg`, `rho-${version}-macos-aarch64-evidence.json`],
    linux_x86_64: [`Rho_${version}_x86_64.AppImage`, `rho-${version}-linux-x86_64-evidence.json`],
  };
  record.assets = [];
  const candidatePlatforms = candidatePlatformsForVersion(version);
  for (const platform of candidatePlatforms) {
    const [artifactName, evidenceName] = details[platform];
    const entries = {
      artifact: { name: artifactName, size_bytes: 100, sha256: platform === "windows_x86_64" ? "a".repeat(64) : "b".repeat(64) },
      checksum: { name: `${artifactName}.sha256`, size_bytes: 80, sha256: "c".repeat(64) },
      evidence: { name: evidenceName, size_bytes: 200, sha256: "d".repeat(64) },
    };
    platforms[platform] = entries;
    for (const entry of Object.values(entries)) {
      record.assets.push({ name: entry.name, size: entry.size_bytes, browser_download_url: `${REPOSITORY}/releases/download/v${version}/${entry.name}` });
    }
  }
  record.evidence = {
    schema_version: 1,
    type: "rho_candidate_evidence",
    status: "passed",
    version,
    release_tag: `v${version}`,
    commit: record.target_commitish,
    platforms,
  };
  record.evidence_sha256 = crypto.createHash("sha256").update(JSON.stringify(record.evidence)).digest("hex");
  record.acceptance_evidence = {
    schema_version: 1,
    type: "rho_candidate_acceptance",
    status: "passed",
    decision: "GO",
    version,
    release_tag: `v${version}`,
    commit: record.target_commitish,
    candidate_evidence_sha256: record.evidence_sha256,
    platforms,
  };
  record.assets.push({
    name: `rho-${version}-acceptance.json`,
    size: 200,
    browser_download_url: `${REPOSITORY}/releases/download/v${version}/rho-${version}-acceptance.json`,
  });
  const checks = {
    windows_x86_64: ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke", ...(twoStageWindows ? ["authenticode_binary", "authenticode_installer", "installed_payload_signature", "signpath_binary_request_binding", "signpath_installer_request_binding", "free_trial_self_signed"] : ["authenticode", "signpath_request_binding", "free_trial_self_signed"])],
    macos_aarch64: ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke", "arm64", "codesign", "entitlements", "notarization", "notary_binding", "staple", "gatekeeper", "license_boundary"],
    linux_x86_64: ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke", "x86_64", "appimage", "apprun", "license_boundary", "native_updater_signature"],
  };
  record.platform_evidence = Object.fromEntries(candidatePlatforms.map((platform) => [platform, {
    size_bytes: platforms[platform].evidence.size_bytes,
    sha256: platforms[platform].evidence.sha256,
    content: {
      schema_version: 1,
      type: "rho_platform_candidate_evidence",
      status: "passed",
      version,
      release_tag: `v${version}`,
      commit: record.target_commitish,
      platform,
      artifact: {
        name: platforms[platform].artifact.name,
        hash_name: platforms[platform].checksum.name,
        size_bytes: platforms[platform].artifact.size_bytes,
        sha256: platforms[platform].artifact.sha256,
      },
      checks: checks[platform].map((name) => ({ name, status: "passed" })),
      ...(platform === "windows_x86_64" ? {
        signing: twoStageWindows ? {
          schema_version: 2,
          provider: "signpath",
          profile: "free_trial_self_signed_two_stage",
          module_version: "4.4.6",
          module_sha256: "4a732624a7214dc8290dbf81ed2714d6b509be319427c2d55fd0c679d13ab5ae",
          signer_thumbprint: "1".repeat(40),
          self_signed: true,
          binary_request_id: "12345678-1234-1234-1234-123456789abc",
          binary_signature_status: "UnknownError",
          binary_unsigned_sha256: "c".repeat(64),
          binary_signed_sha256: "d".repeat(64),
          binary_bundled_sha256: "d".repeat(64),
          installer_request_id: "abcdef12-abcd-abcd-abcd-abcdef123456",
          installer_signature_status: "UnknownError",
          installer_unsigned_sha256: "e".repeat(64),
          installer_signed_sha256: platforms[platform].artifact.sha256,
          installed_binary_sha256: "d".repeat(64),
          installed_signature_status: "UnknownError",
          installed_signer_thumbprint: "1".repeat(40),
          installed_outside_workspace: true,
          cleanup_verified: true,
        } : {
          provider: "signpath",
          profile: "free_trial_self_signed",
          request_id: "12345678-1234-1234-1234-123456789abc",
          module_version: "4.4.6",
          module_sha256: "4a732624a7214dc8290dbf81ed2714d6b509be319427c2d55fd0c679d13ab5ae",
          signer_thumbprint: "1".repeat(40),
          self_signed: true,
          signature_status: "UnknownError",
          unsigned_sha256: "e".repeat(64),
          signed_sha256: platforms[platform].artifact.sha256,
        },
      } : {}),
    },
  }]));
  return record;
}

function withNativeUpdater(record) {
  const version = record.evidence.version;
  const signature = Buffer.from("untrusted comment: Rho updater test signature\nRURvby10ZXN0LXNpZ25hdHVyZQ==\n", "utf8").toString("base64");
  const signatureRecord = (name) => ({
    name,
    size_bytes: Buffer.byteLength(signature),
    sha256: crypto.createHash("sha256").update(signature).digest("hex"),
  });
  const platforms = {};
  const nativePlatforms = nativeUpdaterPlatformsForVersion(version);
  for (const platform of nativePlatforms) {
    const candidatePlatform = record.evidence.platforms[platform];
    const artifact = platform === "windows_x86_64" || platform === "linux_x86_64"
      ? candidatePlatform.artifact
      : { name: `Rho_${version}_aarch64.app.tar.gz`, size_bytes: 111, sha256: "e".repeat(64) };
    const signatureAsset = signatureRecord(`${artifact.name}.sig`);
    if (!record.assets.some((entry) => entry.name === artifact.name)) {
      record.assets.push({
        name: artifact.name,
        size: artifact.size_bytes,
        browser_download_url: `${REPOSITORY}/releases/download/v${version}/${artifact.name}`,
      });
    }
    record.assets.push({
      name: signatureAsset.name,
      size: signatureAsset.size_bytes,
      browser_download_url: `${REPOSITORY}/releases/download/v${version}/${signatureAsset.name}`,
    });
    platforms[platform] = {
      target: platform === "windows_x86_64"
        ? "windows-x86_64"
        : platform === "macos_aarch64" ? "darwin-aarch64" : "linux-x86_64",
      artifact,
      signature: signatureAsset,
      platform_evidence: candidatePlatform.evidence,
    };
  }
  const evidence = {
    schema_version: 1,
    type: "rho_tauri_native_updater_evidence",
    status: "passed",
    version,
    release_tag: `v${version}`,
    commit: record.target_commitish,
    public_key_id: "173c902c085bfe5f",
    platforms,
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const evidenceAsset = {
    name: `rho-${version}-tauri-native-updater-evidence.json`,
    size_bytes: evidenceBytes.length,
    sha256: crypto.createHash("sha256").update(evidenceBytes).digest("hex"),
  };
  record.assets.push({
    name: evidenceAsset.name,
    size: evidenceAsset.size_bytes,
    browser_download_url: `${REPOSITORY}/releases/download/v${version}/${evidenceAsset.name}`,
  });
  record.native_updater_evidence = evidence;
  record.native_updater_evidence_asset = evidenceAsset;
  record.native_updater_signatures = Object.fromEntries(nativePlatforms.map((platform) => [platform, signature]));
  return record;
}

function expectFailure(action, pattern) {
  let error;
  try { action(); } catch (caught) { error = caught; }
  if (!error || !pattern.test(error.message)) throw new Error(`Expected failure matching ${pattern}`);
}

function selfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rho-update-site-"));
  try {
    const result = generate([fakeRecord("0.2.0-dev.9"), fakeRecord("0.2.0-dev.12")], temp);
    if (result.development !== "0.2.0-dev.12") throw new Error("Prerelease ordering failed");
    const promoted = generate([fakeRecord("0.2.0-dev.12"), fakeRecord("0.2.0", false)], temp);
    if (promoted.stable !== "0.2.0" || promoted.development !== "0.2.0") throw new Error("Stable promotion failed");
    const candidate = fakeCandidateRecord("0.4.0-dev.1");
    generate([candidate], temp);
    if (fs.existsSync(path.join(temp, "updates", "stable.json"))) throw new Error("Stale stable manifest was retained");
    const candidateManifest = JSON.parse(fs.readFileSync(path.join(temp, "updates", "development.json"), "utf8"));
    if (!candidateManifest.artifacts.windows_x86_64 || !candidateManifest.artifacts.macos_aarch64) throw new Error("Candidate manifest omitted a platform");
    const candidatePage = fs.readFileSync(path.join(temp, "index.html"), "utf8");
    if (!candidatePage.includes("Download for macOS (Apple Silicon)")) throw new Error("Candidate page omitted macOS");
    if (!candidatePage.includes(">Code signing policy</a>")) throw new Error("generated page omitted Code signing policy");
    if (!candidatePage.includes(">Privacy policy</a>")) throw new Error("generated page omitted Privacy policy");
    if (!candidatePage.includes(">Security</a>")) throw new Error("generated page omitted Security policy");
    if (!candidatePage.includes(">License</a>")) throw new Error("generated page omitted License");
    if (!candidatePage.includes("<h2>Windows code-signing status</h2>")) throw new Error("generated page omitted SignPath status");
    if (!candidatePage.includes(`href="${SIGNPATH_IO}">SignPath.io</a>`)) throw new Error("generated page omitted SignPath.io attribution link");
    if (!candidatePage.includes(`href="${SIGNPATH_FOUNDATION}">SignPath Foundation</a>`)) throw new Error("generated page omitted SignPath Foundation attribution link");
    if (!candidatePage.includes("SignPath Free Trial self-signed test certificate")) throw new Error("generated page omitted test-signing status");
    if (!candidatePage.includes("not publicly trusted; Windows or SmartScreen may still warn")) throw new Error("generated page overstated test-signing trust");
    if (!candidatePage.includes("does not establish Foundation acceptance")) throw new Error("generated page omitted Foundation boundary");
    if (!candidatePage.includes("<h2>Uninstall Rho</h2>")) throw new Error("generated page omitted uninstall instructions");
    if (!candidatePage.includes("Settings &gt; Apps &gt; Installed apps")) throw new Error("generated page omitted Windows uninstall instructions");
    if (!candidatePage.includes("move <strong>Rho.app</strong> from <strong>Applications</strong> to the Trash")) throw new Error("generated page omitted macOS uninstall instructions");
    if (!candidatePage.includes("Windows trust status is shown per release")) throw new Error("generated page omitted per-release trust boundary");
    if (candidatePage.includes("Conditional prerelease:")) throw new Error("ordinary GO release inherited a conditional warning");
    const nativeCandidate = withNativeUpdater(fakeCandidateRecord("0.4.0-dev.40"));
    generate([nativeCandidate], temp);
    const nativeManifest = JSON.parse(fs.readFileSync(path.join(temp, "updates", "tauri", "development.json"), "utf8"));
    if (nativeManifest.version !== "0.4.0-dev.40" || !nativeManifest.platforms["windows-x86_64"] || !nativeManifest.platforms["darwin-aarch64"]) {
      throw new Error("Native updater manifest omitted a supported platform");
    }
    const auto3 = withNativeUpdater(fakeCandidateRecord("0.4.0-dev.43"));
    generate([auto3], temp);
    const auto3Manifest = JSON.parse(fs.readFileSync(path.join(temp, "updates", "tauri", "development.json"), "utf8"));
    if (Object.keys(auto3Manifest.platforms).sort().join(",") !== "darwin-aarch64,linux-x86_64,windows-x86_64") {
      throw new Error("Three-platform updater manifest is incomplete");
    }
    const auto3Page = fs.readFileSync(path.join(temp, "index.html"), "utf8");
    if (!auto3Page.includes("Download for Linux x86-64")) throw new Error("Release page omitted Linux");
    const brokenNativeSignature = withNativeUpdater(fakeCandidateRecord("0.4.0-dev.40"));
    brokenNativeSignature.native_updater_signatures.windows_x86_64 = "not a signature";
    expectFailure(() => generate([brokenNativeSignature], temp), /base64/);
    const conditional = fakeCandidateRecord("0.4.0-dev.39");
    conditional.acceptance_evidence = {
      ...conditional.acceptance_evidence,
      schema_version: 2,
      status: "conditional",
      decision: "CONDITIONAL_GO",
      authorization: {
        authorized_by: "xiayh17",
        authorized_at: "2026-08-13T00:00:00Z",
        scope: "public_prerelease_only",
        acknowledged_risks: [
          "macos_gatekeeper_human_launch_not_run",
          "windows_human_install_not_run",
        ],
      },
      limitations: [
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
      ],
    };
    generate([conditional], temp);
    const conditionalPage = fs.readFileSync(path.join(temp, "index.html"), "utf8");
    if (!conditionalPage.includes("Conditional prerelease:")) throw new Error("conditional release warning is missing");
    if (!conditionalPage.includes("Windows human installation and enabled-Gatekeeper macOS human launch were not run")) {
      throw new Error("conditional release limitations are missing");
    }
    const missingAcceptance = fakeCandidateRecord("0.4.0-dev.39");
    delete missingAcceptance.acceptance_evidence;
    expectFailure(() => generate([missingAcceptance], temp), /acceptance evidence/);
    const historical = fakeCandidateRecord("0.4.0-dev.24");
    delete historical.platform_evidence.windows_x86_64.content.signing;
    historical.platform_evidence.windows_x86_64.content.checks =
      historical.platform_evidence.windows_x86_64.content.checks.filter((check) => !["authenticode", "signpath_request_binding", "free_trial_self_signed"].includes(check.name));
    historical.platform_evidence.macos_aarch64.content.checks =
      historical.platform_evidence.macos_aarch64.content.checks.filter((check) => check.name !== "license_boundary");
    generate([historical], temp);
    const strictUnsigned = fakeCandidateRecord("0.4.0-dev.38");
    delete strictUnsigned.platform_evidence.windows_x86_64.content.signing;
    strictUnsigned.platform_evidence.windows_x86_64.content.checks =
      strictUnsigned.platform_evidence.windows_x86_64.content.checks.filter((check) => !["authenticode", "signpath_request_binding", "free_trial_self_signed"].includes(check.name));
    expectFailure(() => generate([strictUnsigned], temp), /missing required signing evidence/);
    const strictCandidate = fakeCandidateRecord("0.4.0-dev.34");
    strictCandidate.platform_evidence.macos_aarch64.content.checks =
      strictCandidate.platform_evidence.macos_aarch64.content.checks.filter((check) => check.name !== "license_boundary");
    expectFailure(() => generate([strictCandidate], temp), /missing required check license_boundary/);
    const unknownHistorical = fakeCandidateRecord("0.4.0-dev.23");
    unknownHistorical.platform_evidence.macos_aarch64.content.checks =
      unknownHistorical.platform_evidence.macos_aarch64.content.checks.filter((check) => check.name !== "license_boundary");
    expectFailure(() => generate([unknownHistorical], temp), /missing required check license_boundary/);
    expectFailure(() => generate([{ ...fakeRecord("0.3.0"), draft: true }], temp), /Draft release/);
    const missingMac = fakeCandidateRecord("0.4.0-dev.1");
    delete missingMac.evidence.platforms.macos_aarch64;
    expectFailure(() => generate([missingMac], temp), /candidate platforms keys/);
    const unknownPlatform = fakeCandidateRecord("0.4.0-dev.1");
    unknownPlatform.evidence.platforms.linux_x86_64 = unknownPlatform.evidence.platforms.windows_x86_64;
    expectFailure(() => generate([unknownPlatform], temp), /candidate platforms keys/);
    const wrongSize = fakeCandidateRecord("0.4.0-dev.1");
    wrongSize.assets.find((asset) => asset.name.endsWith("aarch64.dmg")).size = 99;
    expectFailure(() => generate([wrongSize], temp), /does not match evidence/);
    const wrongHash = fakeCandidateRecord("0.4.0-dev.1");
    wrongHash.evidence.platforms.macos_aarch64.artifact.sha256 = "ABC";
    expectFailure(() => generate([wrongHash], temp), /invalid/);
    const missingNotaryBinding = fakeCandidateRecord("0.4.0-dev.1");
    missingNotaryBinding.platform_evidence.macos_aarch64.content.checks =
      missingNotaryBinding.platform_evidence.macos_aarch64.content.checks.filter((check) => check.name !== "notary_binding");
    expectFailure(() => generate([missingNotaryBinding], temp), /missing required check notary_binding/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  process.stdout.write("Rho update site generator tests passed.\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.test === "true") selfTest();
else if (args.input && args.output) {
  const result = generate(JSON.parse(fs.readFileSync(args.input, "utf8")), args.output);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("Usage: node scripts/generate-update-site.mjs --input releases.json --output site, or --test true");
}
