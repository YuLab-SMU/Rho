import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ChangeFragmentError,
  renderNewsSection,
  validateFragments,
} from "./change-fragments.mjs";

function fragment({ id, owner, category, title, body }) {
  return `# ${title}\n\n\`\`\`json\n${JSON.stringify({
    schema_version: 1,
    record_type: "change_fragment",
    id,
    work_package_id: owner,
    category,
    title,
  }, null, 2)}\n\`\`\`\n\n${body}\n`;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-change-fragments-"));
try {
  const changes = path.join(root, ".changes");
  const packages = path.join(root, "docs/architecture/modernization/work-packages");
  fs.mkdirSync(changes, { recursive: true });
  fs.mkdirSync(packages, { recursive: true });
  fs.writeFileSync(path.join(packages, "AM-W1-01.md"), "fixture\n");
  fs.writeFileSync(path.join(packages, "AM-W2-01.md"), "fixture\n");
  fs.writeFileSync(path.join(changes, "AM-C-0002.md"), fragment({
    id: "AM-C-0002",
    owner: "AM-W2-01",
    category: "fixed",
    title: "Recover exact output",
    body: "Late output now returns to the exact project without crossing revisions.",
  }));
  fs.writeFileSync(path.join(changes, "AM-C-0001.md"), fragment({
    id: "AM-C-0001",
    owner: "AM-W1-01",
    category: "added",
    title: "Add typed output",
    body: "Runtime output now uses one generated contract.",
  }));

  const fragments = validateFragments(root);
  assert.deepEqual(fragments.map(({ id }) => id), ["AM-C-0001", "AM-C-0002"]);
  const first = renderNewsSection(fragments, { version: "0.4.2-dev.1", date: "2026-08-25" });
  const second = renderNewsSection(validateFragments(root), {
    version: "0.4.2-dev.1",
    date: "2026-08-25",
  });
  assert.equal(first, second);
  assert.match(first, /^## 0\.4\.2-dev\.1 - 2026-08-25/u);
  assert(first.indexOf("### Added") < first.indexOf("### Fixed"));
  assert(first.indexOf("AM-C-") === -1);

  fs.writeFileSync(path.join(changes, "AM-C-0003.md"), fragment({
    id: "AM-C-0003",
    owner: "AM-W9-99",
    category: "changed",
    title: "Invalid fixture",
    body: "This must fail.",
  }));
  assert.throws(
    () => validateFragments(root),
    (error) => error instanceof ChangeFragmentError &&
      error.errors.some((message) => message.includes("unknown work package AM-W9-99")) &&
      error.errors.some((message) => message.includes("invalid category changed")),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Change fragment validation and deterministic composition passed");
