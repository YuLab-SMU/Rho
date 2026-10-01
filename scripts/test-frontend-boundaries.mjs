import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFrontendBoundaries } from "./check-frontend-boundaries.mjs";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/frontend-boundaries/cases.json", import.meta.url), "utf8"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-frontend-boundaries-"));
try {
  // Resolve the same pinned packages as production while keeping fixture sources isolated.
  fs.symlinkSync(fileURLToPath(new URL("../ui/node_modules", import.meta.url)), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const [index, test] of cases.entries()) {
    const source = path.join(directory, String(index));
    fs.mkdirSync(source, { recursive: true });
    for (const [file, text] of Object.entries(test.files)) {
      const target = path.join(source, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    const issues = checkFrontendBoundaries(source);
    assert.deepEqual([...new Set(issues.map((issue) => issue.rule))].sort(), [...test.rules].sort(), `${test.name}\n${JSON.stringify(issues, null, 2)}`);
    console.log(`PASS ${test.name}`);
  }
  console.log(`${cases.length} frontend dependency and state-ownership fixtures passed.`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
