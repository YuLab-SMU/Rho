import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(root, "scripts/generate-evidence-graph-bindings.mjs");
const checkedIn = path.join(root, "desktop/ui/src/transport/generated/evidence-graph.ts");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-evidence-graph-bindings-test-"));

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
  for (const command of [
    "evidence_graph_health",
    "evidence_list_claims",
    "evidence_get_claim_trace",
    "evidence_get_subgraph",
    "evidence_list_gaps",
    "evidence_create_draft_claim",
    "evidence_create_draft_link",
    "evidence_promote_draft",
    "evidence_refresh",
  ]) {
    assert.equal(generated.split(`"${command}"`).length - 1, 1, command);
  }
  assert.match(generated, /createEvidenceGraphCommands/);
  assert.match(generated, /EvidenceGraphHealthViewV1/);
  assert.match(generated, /ClaimTraceViewV1/);
  assert.match(generated, /import type \{ AuthorityReferenceViewV1 \} from "\.\/authority"/);
  assert.match(generated, /import type \{ ProjectId \} from "\.\/surface-studio"/);
  assert.doesNotMatch(generated, /AuthorityObservationViewV1|AuthorityReceiptSummaryV1/u);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("Evidence Graph generated binding contract passed");
