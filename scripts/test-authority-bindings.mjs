import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(root, "scripts/generate-authority-bindings.mjs");
const checkedIn = path.join(root, "desktop/ui/src/transport/generated/authority.ts");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-authority-bindings-test-"));

function generate(output) {
  execFileSync(process.execPath, [generator, "--output", output], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

try {
  const first = path.join(temporary, "first.ts");
  const second = path.join(temporary, "second.ts");
  generate(first);
  generate(second);
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(checkedIn));
  const generated = fs.readFileSync(checkedIn, "utf8");
  for (const command of ["authority_resolve_refs", "authority_list_receipts"]) {
    assert.equal(generated.split(`"${command}"`).length - 1, 1, command);
  }
  assert.match(generated, /createAuthorityCommands/);
  assert.match(generated, /AuthorityObservationViewV1/);
  assert.match(generated, /AuthorityReceiptSummaryV1/);
  assert.doesNotMatch(generated, /EvidenceNodeViewV1|EvidenceGapViewV1|EvidencePromotion/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("Authority generated binding contract passed");
