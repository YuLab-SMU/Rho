import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_WINDOWS_EXECUTABLE_BYTES,
  NSIS_BUNDLE_TYPE,
  UNKNOWN_BUNDLE_TYPE,
  patchWindowsBundleType,
} from "./tauri-bundle-type.mjs";

function expectFailure(action, pattern) {
  assert.throws(action, pattern);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-tauri-bundle-type-"));
try {
  const valid = path.join(root, "rho-desktop.exe");
  const prefix = Buffer.from("MZ-rho-prefix", "ascii");
  const suffix = Buffer.from("-rho-suffix", "ascii");
  fs.writeFileSync(valid, Buffer.concat([prefix, UNKNOWN_BUNDLE_TYPE, suffix]));
  const before = fs.readFileSync(valid);
  const evidence = patchWindowsBundleType(valid);
  const after = fs.readFileSync(valid);
  assert.equal(evidence.bundle_type, "nsis");
  assert.equal(evidence.offset, prefix.length);
  assert.equal(evidence.size_bytes, before.length);
  assert.notEqual(evidence.before_sha256, evidence.after_sha256);
  assert.equal(after.length, before.length);
  assert.equal(after.indexOf(UNKNOWN_BUNDLE_TYPE), -1);
  assert.equal(after.indexOf(NSIS_BUNDLE_TYPE), prefix.length);

  expectFailure(() => patchWindowsBundleType(valid), /exactly one unknown bundle token/);

  const missing = path.join(root, "missing-token.exe");
  fs.writeFileSync(missing, "MZ-no-token");
  expectFailure(() => patchWindowsBundleType(missing), /exactly one unknown bundle token/);

  const duplicated = path.join(root, "duplicate-token.exe");
  fs.writeFileSync(duplicated, Buffer.concat([UNKNOWN_BUNDLE_TYPE, UNKNOWN_BUNDLE_TYPE]));
  expectFailure(() => patchWindowsBundleType(duplicated), /exactly one unknown bundle token/);

  const mixed = path.join(root, "mixed-token.exe");
  fs.writeFileSync(mixed, Buffer.concat([UNKNOWN_BUNDLE_TYPE, NSIS_BUNDLE_TYPE]));
  const mixedEvidence = patchWindowsBundleType(mixed);
  assert.equal(mixedEvidence.preexisting_nsis_tokens, 1);
  const mixedAfter = fs.readFileSync(mixed);
  assert.equal(mixedAfter.indexOf(UNKNOWN_BUNDLE_TYPE), -1);
  assert.equal(mixedAfter.indexOf(NSIS_BUNDLE_TYPE), 0);
  assert.notEqual(mixedAfter.indexOf(NSIS_BUNDLE_TYPE, NSIS_BUNDLE_TYPE.length), -1);

  const empty = path.join(root, "empty.exe");
  fs.writeFileSync(empty, "");
  expectFailure(() => patchWindowsBundleType(empty), /empty or exceeds/);

  const oversized = path.join(root, "oversized.exe");
  fs.writeFileSync(oversized, UNKNOWN_BUNDLE_TYPE);
  fs.truncateSync(oversized, MAX_WINDOWS_EXECUTABLE_BYTES + 1);
  expectFailure(() => patchWindowsBundleType(oversized), /empty or exceeds/);

  const linked = path.join(root, "linked.exe");
  fs.symlinkSync(missing, linked);
  expectFailure(() => patchWindowsBundleType(linked), /regular non-symlink/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Tauri NSIS bundle-type patch tests passed.");
