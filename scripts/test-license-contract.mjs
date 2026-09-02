import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const canonicalAgplSha256 = "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef";

function normalizedSha256(value) {
  const normalized = value.replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function parseDcf(value) {
  const fields = new Map();
  let current = null;
  for (const line of value.split(/\r?\n/u)) {
    if (/^\s/u.test(line) && current) {
      fields.set(current, `${fields.get(current)}\n${line.trim()}`);
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/u);
    if (match) {
      current = match[1];
      fields.set(current, match[2]);
    }
  }
  return Object.fromEntries(fields);
}

function validateContract(snapshot) {
  assert.equal(snapshot.rootLicenseHash, canonicalAgplSha256, "root LICENSE must be canonical AGPL-3.0 text");
  assert.equal(snapshot.hasAgplTitle, true, "root LICENSE must identify GNU AGPL version 3");
  assert.equal(snapshot.hasNetworkSection, true, "root LICENSE must include AGPL section 13");

  assert.ok(snapshot.cargoLicenses.length > 0, "Cargo workspace packages must be present");
  for (const entry of snapshot.cargoLicenses) {
    assert.equal(entry.license, "AGPL-3.0-only", `${entry.name} must inherit AGPL-3.0-only`);
  }
  assert.equal(snapshot.frontendLicense, "AGPL-3.0-only", "frontend package metadata must use AGPL-3.0-only");
  assert.equal(snapshot.frontendLockLicense, "AGPL-3.0-only", "frontend lock metadata must use AGPL-3.0-only");

  for (const entry of snapshot.rPackages) {
    assert.equal(entry.license, "AGPL-3", `${entry.name} must use R's AGPL-3 identifier`);
    assert.match(entry.authors, /person\("YuLab-SMU", role = "cph"\)/u, `${entry.name} must record YuLab-SMU as copyright holder`);
    assert.match(entry.authors, /"Contributors"[\s\S]*"cph"/u, `${entry.name} must retain contributor copyright`);
  }
  assert.deepEqual(snapshot.packageLocalLicenses, [], "stale package-local MIT license files must be absent");

  assert.match(snapshot.contributing, /same `AGPL-3\.0-only` terms/u);
  assert.match(snapshot.contributing, /right to provide it/u);
  assert.match(snapshot.contributing, /does not transfer your copyright[\s\S]*written assignment/u);

  for (const marker of [
    "vendor/jet/LICENSE",
    "desktop/legal/licenses/monaco/LICENSE",
    "desktop/legal/licenses/dompurify/LICENSE",
    "desktop/legal/licenses/marked/LICENSE",
    "desktop/legal/licenses/papaparse/LICENSE",
    "desktop/legal/licenses/katex/LICENSE",
    "runtime/ark.json",
    "Wasmtime / Cranelift",
    "WAT parser",
  ]) {
    assert.match(snapshot.licensing, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `LICENSES.md must preserve ${marker}`);
  }
  assert.match(snapshot.licensing, /Third-party work is not relicensed/u);
  assert.match(snapshot.licensing, /historical Rho versions[\s\S]*not revoked/u);
  assert.match(snapshot.licensing, /wasmtime 38\.0\.4[\s\S]*Apache-2\.0 WITH LLVM-exception/u);
  assert.match(snapshot.licensing, /test-only `wat 1\.257\.1`[\s\S]*excluded from production dependencies/u);
  assert.match(
    snapshot.cargoManifest,
    /wasmtime = \{ version = "=38\.0\.4", default-features = false, features = \["component-model", "cranelift", "runtime", "std"\] \}/u,
    "Wasmtime must remain exact, no-default, and limited to the reviewed component/runtime feature set",
  );
  assert.match(
    snapshot.cargoManifest,
    /wat = \{ version = "=1\.257\.1", default-features = false, features = \["component-model"\] \}/u,
    "WAT parser must remain exact, no-default, and limited to component-model fixtures",
  );
  assert.match(snapshot.cargoLock, /name = "wasmtime"\nversion = "38\.0\.4"/u);
  assert.match(snapshot.cargoLock, /name = "wat"\nversion = "1\.257\.1"/u);

  assert.deepEqual(snapshot.missingVendorNotices, [], "every checked-in vendor payload must carry its reviewed notice");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runNegativeSelfTests(snapshot) {
  validateContract(snapshot);
  const cases = [
    ["modified canonical text", (value) => { value.rootLicenseHash = "changed"; }],
    ["stale Cargo MIT metadata", (value) => { value.cargoLicenses[0].license = "MIT"; }],
    ["stale frontend metadata", (value) => { value.frontendLicense = "MIT"; }],
    ["stale R metadata", (value) => { value.rPackages[0].license = "MIT"; }],
    ["package-local MIT file", (value) => { value.packageLocalLicenses.push("r/rho.bridge/LICENSE"); }],
    ["missing third-party inventory", (value) => { value.licensing = ""; }],
    ["widened Wasmtime features", (value) => { value.cargoManifest = ""; }],
    ["missing contribution permission", (value) => { value.contributing = ""; }],
    ["missing vendored notice", (value) => { value.missingVendorNotices.push("desktop/legal/licenses/monaco/LICENSE"); }],
  ];

  for (const [name, mutate] of cases) {
    const invalid = clone(snapshot);
    mutate(invalid);
    assert.throws(() => validateContract(invalid), undefined, `validator must reject ${name}`);
  }
}

async function exists(relativePath) {
  try {
    await access(path.join(repositoryRoot, relativePath), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function read(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function loadRepositorySnapshot() {
  const cargo = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--locked", "--offline"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(cargo.status, 0, `cargo metadata failed:\n${cargo.stderr}`);
  const metadata = JSON.parse(cargo.stdout);
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));

  const rootLicense = await read("LICENSE");
  const frontend = JSON.parse(await read("desktop/package.json"));
  const frontendLock = JSON.parse(await read("desktop/package-lock.json"));
  const rPackagePaths = ["r/rho.bridge/DESCRIPTION"];
  const rPackages = [];
  for (const relativePath of rPackagePaths) {
    const fields = parseDcf(await read(relativePath));
    rPackages.push({ name: fields.Package, license: fields.License, authors: fields["Authors@R"] });
  }

  const packageLocalLicenseCandidates = ["r/rho.bridge/LICENSE"];
  const vendorNoticePaths = [
    "vendor/jet/LICENSE",
    "desktop/legal/licenses/monaco/LICENSE",
    "desktop/legal/licenses/dompurify/LICENSE",
    "desktop/legal/licenses/marked/LICENSE",
    "desktop/legal/licenses/papaparse/LICENSE",
    "desktop/legal/licenses/katex/LICENSE",
  ];

  return {
    rootLicenseHash: normalizedSha256(rootLicense),
    hasAgplTitle: /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/u.test(rootLicense),
    hasNetworkSection: /13\. Remote Network Interaction; Use with the GNU General Public License\./u.test(rootLicense),
    cargoLicenses: metadata.workspace_members.map((id) => ({
      name: packages.get(id)?.name ?? id,
      license: packages.get(id)?.license ?? null,
    })),
    frontendLicense: frontend.license,
    frontendLockLicense: frontendLock.packages?.[""]?.license,
    rPackages,
    packageLocalLicenses: (await Promise.all(packageLocalLicenseCandidates.map(async (entry) => [entry, await exists(entry)])))
      .filter(([, present]) => present)
      .map(([entry]) => entry),
    contributing: await read("CONTRIBUTING.md"),
    licensing: await read("LICENSES.md"),
    cargoManifest: await read("Cargo.toml"),
    cargoLock: await read("Cargo.lock"),
    missingVendorNotices: (await Promise.all(vendorNoticePaths.map(async (entry) => [entry, await exists(entry)])))
      .filter(([, present]) => !present)
      .map(([entry]) => entry),
  };
}

const current = await loadRepositorySnapshot();
runNegativeSelfTests(current);

if (process.argv.includes("--self-test")) {
  console.log("license contract negative self-tests passed");
} else {
  console.log("repository AGPL license contract is valid");
}
