import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CANDIDATE_PLATFORMS,
  validateAggregateEvidence,
  validatePublishedPlatformEvidence,
} from "./candidate-release.mjs";

const WEBSITE = "https://yulab-smu.top/Rho/";
const REPOSITORY = "https://github.com/YuLab-SMU/Rho";
const PRIVACY_POLICY = `${REPOSITORY}/blob/main/PRIVACY.md`;
const SECURITY_POLICY = `${REPOSITORY}/blob/main/SECURITY.md`;
const CODE_SIGNING_POLICY = `${REPOSITORY}/blob/main/CODE_SIGNING_POLICY.md`;
const LICENSE_URL = `${REPOSITORY}/blob/main/LICENSE`;
const SIGNPATH_IO = "https://about.signpath.io";
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
    windows_x86_64: { url: asset.browser_download_url, sha256: artifact.sha256, size: artifact.size_bytes },
  };
}

function validatedCandidateArtifacts(record, evidence, version) {
  validateAggregateEvidence(evidence);
  if (evidence.version !== version || evidence.release_tag !== `v${version}`) {
    throw new Error(`Candidate evidence identity mismatch for ${version}`);
  }
  if (record.target_commitish !== evidence.commit) throw new Error(`Candidate commit mismatch for ${version}`);
  const suppliedPlatformEvidence = record.platform_evidence;
  if (!suppliedPlatformEvidence || JSON.stringify(Object.keys(suppliedPlatformEvidence).sort()) !== JSON.stringify([...CANDIDATE_PLATFORMS].sort())) {
    throw new Error(`Complete platform evidence is missing for ${version}`);
  }
  const artifacts = {};
  for (const platform of CANDIDATE_PLATFORMS) {
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
    for (const value of Object.values(platformEvidence)) releaseAsset(record, value.name, value.size_bytes, version);
    const artifact = platformEvidence.artifact;
    assertArtifactHash(artifact.sha256, version);
    const asset = releaseAsset(record, artifact.name, artifact.size_bytes, version);
    artifacts[platform] = { url: asset.browser_download_url, sha256: artifact.sha256, size: artifact.size_bytes };
  }
  return artifacts;
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
  let artifacts;
  if (evidence.type === "rho_candidate_evidence") {
    artifacts = validatedCandidateArtifacts(record, evidence, version);
  } else if ((!evidence.type || evidence.type === "rho_0_2_release_evidence") && evidence.artifact) {
    artifacts = validatedLegacyArtifacts(record, evidence, version);
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
    summary,
    github_release_url: record.html_url,
    artifacts,
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
  const label = platform === "windows_x86_64" ? "Download for Windows x64" : "Download for macOS (Apple Silicon)";
  return `<div class="artifact"><a class="download" href="${escapeHtml(artifact.url)}">${label}</a><details><summary>Verify download</summary><code>SHA-256 ${escapeHtml(artifact.sha256)}</code></details></div>`;
}

function releaseBlock(title, release) {
  if (!release) return `<section><h2>${title}</h2><p>Not available yet.</p></section>`;
  const downloads = Object.entries(release.artifacts).map(([platform, artifact]) => artifactDownload(platform, artifact)).join("");
  return `<section><h2>${title}</h2><p class="version">Rho ${escapeHtml(release.version)}</p><p>${escapeHtml(release.summary)}</p><p>Published ${escapeHtml(release.published_at.slice(0, 10))}</p>${downloads}</section>`;
}

function page(stable, development) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rho Downloads</title><style>body{margin:0;color:#203033;background:#f5f7f7;font:15px/1.55 system-ui,sans-serif}header,main,footer{max-width:760px;margin:auto;padding:28px 22px}header{padding-top:64px}h1{margin:0;font:700 42px Georgia,serif}header p{color:#526568}section{padding:24px 0;border-top:1px solid #cbd4d5}h2{font-size:18px}.version{font-size:24px;font-weight:700}.artifact{margin:16px 0}.download{display:inline-block;padding:9px 13px;border-radius:5px;color:white;background:#167568;text-decoration:none}details{margin-top:8px;color:#526568}code{display:block;margin-top:8px;overflow-wrap:anywhere}footer{color:#657679;font-size:13px}a{color:#126b61}</style></head><body><header><h1>Rho</h1><p>An agent-native scientific workbench for R.</p></header><main>${releaseBlock("Stable", stable)}${releaseBlock("Development", development)}<p>Installers are hosted by GitHub Releases. In some networks a download may be unavailable even when this page is reachable.</p><section><h2>Windows code-signing status</h2><p>Historical Windows downloads are unsigned. Rho's upstream workflow is configured to sign a future final NSIS installer with the self-signed <strong>Rho Test Signing</strong> certificate managed through <a href="${SIGNPATH_IO}">SignPath.io</a>. A self-signed certificate is not trusted by Windows or Microsoft SmartScreen, so a signature alone does not make a download public-release-ready. Consult exact release evidence and the <a href="${CODE_SIGNING_POLICY}">Code signing policy</a>.</p></section><section><h2>Uninstall Rho</h2><p>On Windows, open <strong>Settings &gt; Apps &gt; Installed apps</strong>, choose <strong>Rho</strong>, then choose <strong>Uninstall</strong>. On macOS, quit Rho and move <strong>Rho.app</strong> from <strong>Applications</strong> to the Trash.</p><p>Uninstalling does not automatically delete project files, local application data, logs, or operating-system credential-store entries. Review the <a href="${PRIVACY_POLICY}">Privacy policy</a> before removing retained data.</p></section></main><footer><p>Listed macOS builds are Developer ID signed and notarized. Verify every Windows download with its exact release evidence and SHA-256 checksum; a self-signed Windows certificate is not public trust.</p><p><a href="${REPOSITORY}">Source repository</a> · <a href="${LICENSE_URL}">License</a> · <a href="${PRIVACY_POLICY}">Privacy policy</a> · <a href="${SECURITY_POLICY}">Security</a> · <a href="${CODE_SIGNING_POLICY}">Code signing policy</a></p></footer></body></html>`;
}

export function generate(records, outputDirectory) {
  const releases = records.map(validatedRelease).sort((left, right) => compareVersions(right.parsed, left.parsed));
  const stable = releases.find((release) => !release.prerelease) || null;
  const development = releases[0] || null;
  if (!development) throw new Error("At least one validated release is required");
  fs.mkdirSync(path.join(outputDirectory, "updates"), { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "index.html"), page(stable, development));
  fs.writeFileSync(path.join(outputDirectory, "updates", "development.json"), `${JSON.stringify(manifest(development, "development"), null, 2)}\n`);
  const stablePath = path.join(outputDirectory, "updates", "stable.json");
  if (stable) fs.writeFileSync(stablePath, `${JSON.stringify(manifest(stable, "stable"), null, 2)}\n`);
  else if (fs.existsSync(stablePath)) fs.unlinkSync(stablePath);
  return { stable: stable?.version || null, development: development.version };
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
  const platforms = {};
  const details = {
    windows_x86_64: [`Rho_${version}_x64-setup.exe`, `rho-${version}-windows-x86_64-evidence.json`],
    macos_aarch64: [`Rho_${version}_aarch64.dmg`, `rho-${version}-macos-aarch64-evidence.json`],
  };
  record.assets = [];
  for (const platform of CANDIDATE_PLATFORMS) {
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
  const checks = {
    windows_x86_64: ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke"],
    macos_aarch64: ["release_metadata", "rust_workspace", "rho_bridge", "rho_agent", "frontend", "workspace_smoke", "arm64", "codesign", "entitlements", "notarization", "notary_binding", "staple", "gatekeeper", "license_boundary"],
  };
  record.platform_evidence = Object.fromEntries(CANDIDATE_PLATFORMS.map((platform) => [platform, {
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
    },
  }]));
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
    if (!candidatePage.includes("<h2>Windows code-signing status</h2>")) throw new Error("generated page omitted Windows signing status");
    if (!candidatePage.includes(`href="${SIGNPATH_IO}">SignPath.io</a>`)) throw new Error("generated page omitted SignPath.io attribution link");
    if (!candidatePage.includes("self-signed <strong>Rho Test Signing</strong>")) throw new Error("generated page omitted trial certificate status");
    if (!candidatePage.includes("not trusted by Windows or Microsoft SmartScreen")) throw new Error("generated page overstated self-signed Windows trust");
    if (!candidatePage.includes("<h2>Uninstall Rho</h2>")) throw new Error("generated page omitted uninstall instructions");
    if (!candidatePage.includes("Settings &gt; Apps &gt; Installed apps")) throw new Error("generated page omitted Windows uninstall instructions");
    if (!candidatePage.includes("move <strong>Rho.app</strong> from <strong>Applications</strong> to the Trash")) throw new Error("generated page omitted macOS uninstall instructions");
    if (!candidatePage.includes("a self-signed Windows certificate is not public trust")) throw new Error("generated page overstated Windows signing");
    const historical = fakeCandidateRecord("0.4.0-dev.24");
    historical.platform_evidence.macos_aarch64.content.checks =
      historical.platform_evidence.macos_aarch64.content.checks.filter((check) => check.name !== "license_boundary");
    generate([historical], temp);
    const strictCandidate = fakeCandidateRecord("0.4.0-dev.33");
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
