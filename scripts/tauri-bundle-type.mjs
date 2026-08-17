import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const UNKNOWN_BUNDLE_TYPE = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
export const NSIS_BUNDLE_TYPE = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii");
export const MAX_WINDOWS_EXECUTABLE_BYTES = 256 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function occurrences(value, needle) {
  const indexes = [];
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}

export function patchWindowsBundleType(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail("Tauri bundle-type input must be a regular non-symlink file");
  }
  if (stat.size <= 0 || stat.size > MAX_WINDOWS_EXECUTABLE_BYTES) {
    fail("Tauri bundle-type input is empty or exceeds its byte budget");
  }
  if (UNKNOWN_BUNDLE_TYPE.length !== NSIS_BUNDLE_TYPE.length) {
    fail("Tauri bundle-type tokens do not have equal length");
  }

  const before = fs.readFileSync(filePath);
  const unknownIndexes = occurrences(before, UNKNOWN_BUNDLE_TYPE);
  const nsisIndexes = occurrences(before, NSIS_BUNDLE_TYPE);
  if (unknownIndexes.length !== 1 || nsisIndexes.length !== 0) {
    fail("Tauri executable must contain exactly one unknown bundle token and no NSIS token");
  }

  const beforeSha256 = sha256(before);
  const descriptor = fs.openSync(filePath, "r+");
  try {
    const written = fs.writeSync(descriptor, NSIS_BUNDLE_TYPE, 0, NSIS_BUNDLE_TYPE.length, unknownIndexes[0]);
    if (written !== NSIS_BUNDLE_TYPE.length) fail("Tauri bundle-type patch was incomplete");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  const after = fs.readFileSync(filePath);
  if (
    after.length !== before.length
    || occurrences(after, UNKNOWN_BUNDLE_TYPE).length !== 0
    || occurrences(after, NSIS_BUNDLE_TYPE).length !== 1
  ) fail("Tauri bundle-type patch did not produce the exact NSIS token shape");
  const afterSha256 = sha256(after);
  if (afterSha256 === beforeSha256) fail("Tauri bundle-type patch did not change executable bytes");

  return {
    schema_version: 1,
    type: "rho_tauri_bundle_type_patch",
    bundle_type: "nsis",
    offset: unknownIndexes[0],
    size_bytes: after.length,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] == null) fail("Invalid Tauri bundle-type arguments");
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (args.size !== 2 || args.get("mode") !== "patch" || !args.get("file")) {
    fail("Expected --mode patch --file <release executable>");
  }
  const filePath = path.resolve(args.get("file"));
  process.stdout.write(`${JSON.stringify(patchWindowsBundleType(filePath))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
