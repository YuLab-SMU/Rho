import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(
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
const normalized = `${generated.trimEnd()}\n`;
mkdirSync(dirname(destination), { recursive: true });
let current = "";
try {
  current = readFileSync(destination, "utf8");
} catch {
  // The first generation creates the checked-in fixture.
}
if (current !== normalized) writeFileSync(destination, normalized, "utf8");
process.stdout.write(`Generated ${destination}\n`);
