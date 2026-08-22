import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(
  repositoryRoot,
  "desktop",
  "ui",
  "src",
  "contracts",
  "generated",
  "rsr-contract-fixtures.json",
);
const generated = execFileSync(
  "cargo",
  ["run", "--quiet", "--locked", "-p", "rho-ui-contract", "--example", "emit_contract_fixture"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
const expected = `${generated.trimEnd()}\n`;
let checkedIn;
try {
  checkedIn = readFileSync(fixturePath, "utf8");
} catch {
  throw new Error("RSR contract fixture is missing; run node scripts/generate-rsr-contract-fixtures.mjs");
}
if (checkedIn !== expected) {
  throw new Error("RSR Rust/TypeScript contract fixture drifted; regenerate and review it");
}
const parsed = JSON.parse(checkedIn);
if (parsed.contract !== "rho.ui.contract.fixture.v1" || parsed.contract_major !== 1) {
  throw new Error("RSR checked-in contract fixture has an unsupported identity");
}
process.stdout.write("RSR Rust/TypeScript contract fixture matches exactly\n");
