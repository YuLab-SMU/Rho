import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP23ContributionContract(value) {
  for (const marker of [
    "MIN_MANIFEST_SCHEMA_VERSION: u64 = 1",
    "MANIFEST_SCHEMA_VERSION: u64 = 2",
    "pub contributions: Vec<ContributionDeclaration>",
    "Manifest V1 cannot declare live contributions",
    "MAX_CONTRIBUTIONS_PER_PACKAGE",
    "must match exactly one provides entry and contract major",
  ]) assert.ok(value.manifest.includes(marker), `Manifest V2 lost ${marker}`);

  for (const marker of [
    "MAX_CONTRIBUTIONS_PER_PACKAGE: usize = 32",
    "MAX_CONTRIBUTIONS_PER_PROJECT: usize = 256",
    "MAX_CONTRIBUTION_LABEL_BYTES: usize = 128",
    "MAX_CONTRIBUTION_PURPOSE_BYTES: usize = 1024",
    "Source",
    "Panel",
    "PLUGIN_DETAILS_PANEL_SLOT",
    "reserved trusted-surface terminology",
    "inputSchema and outputSchema must be declared together",
  ]) assert.ok(value.contribution.includes(marker), `contribution contract lost ${marker}`);

  for (const marker of [
    "MAX_CONTRIBUTION_SCHEMA_BYTES: usize = 64 * 1024",
    "MAX_CONTRIBUTION_SCHEMA_DEPTH: usize = 8",
    "MAX_CONTRIBUTION_SCHEMA_PROPERTIES: usize = 128",
    "MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES: usize = 128",
    "unsupported schema keyword",
    "contains undeclared property",
  ]) assert.ok(value.schema.includes(marker), `bounded schema contract lost ${marker}`);
  assert.doesNotMatch(
    value.schema.split("#[cfg(test)]")[0],
    /\$ref|regex::|reqwest|std::fs|Command::new|eval\(/,
    "schema contract gained remote, filesystem, process, or evaluation authority",
  );

  for (const marker of [
    "contribution.skill_path.as_deref()",
    "regular non-symlink file",
    "keys.sort()",
    "keys.dedup()",
  ]) assert.ok(value.discovery.includes(marker), `V2 asset discovery lost ${marker}`);
}

function fixture() {
  return {
    manifest: "MIN_MANIFEST_SCHEMA_VERSION: u64 = 1\nMANIFEST_SCHEMA_VERSION: u64 = 2\npub contributions: Vec<ContributionDeclaration>\nManifest V1 cannot declare live contributions\nMAX_CONTRIBUTIONS_PER_PACKAGE\nmust match exactly one provides entry and contract major",
    contribution: "MAX_CONTRIBUTIONS_PER_PACKAGE: usize = 32\nMAX_CONTRIBUTIONS_PER_PROJECT: usize = 256\nMAX_CONTRIBUTION_LABEL_BYTES: usize = 128\nMAX_CONTRIBUTION_PURPOSE_BYTES: usize = 1024\nSource\nPanel\nPLUGIN_DETAILS_PANEL_SLOT\nreserved trusted-surface terminology\ninputSchema and outputSchema must be declared together",
    schema: "MAX_CONTRIBUTION_SCHEMA_BYTES: usize = 64 * 1024\nMAX_CONTRIBUTION_SCHEMA_DEPTH: usize = 8\nMAX_CONTRIBUTION_SCHEMA_PROPERTIES: usize = 128\nMAX_CONTRIBUTION_SCHEMA_ENUM_VALUES: usize = 128\nunsupported schema keyword\ncontains undeclared property\n#[cfg(test)]",
    discovery: "contribution.skill_path.as_deref()\nregular non-symlink file\nkeys.sort()\nkeys.dedup()",
  };
}

if (process.argv.includes("--test")) {
  validateP23ContributionContract(fixture());
  for (const [name, mutate] of [
    ["V1 compatibility", (value) => { value.manifest = value.manifest.replace("MIN_MANIFEST_SCHEMA_VERSION: u64 = 1", ""); }],
    ["project bound", (value) => { value.contribution = value.contribution.replace("MAX_CONTRIBUTIONS_PER_PROJECT: usize = 256", ""); }],
    ["remote schema", (value) => { value.schema = `$ref\n${value.schema}`; }],
    ["asset containment", (value) => { value.discovery = value.discovery.replace("regular non-symlink file", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP23ContributionContract(value), undefined, name);
  }
} else {
  validateP23ContributionContract({
    manifest: read("crates/rho-extension-runtime/src/manifest.rs"),
    contribution: read("crates/rho-extension-runtime/src/contribution.rs"),
    schema: read("crates/rho-extension-runtime/src/json_schema.rs"),
    discovery: read("crates/rho-extension-runtime/src/discovery.rs"),
  });
}

console.log("extension P2-3 contribution contract passed");
