#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Ark macOS bootstrap fixture tests require Apple Silicon macOS" >&2
  exit 1
fi

RHO_TEST_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_TEST_BOOTSTRAP_SOURCE="$RHO_TEST_SCRIPT_ROOT/bootstrap-ark-macos.sh"
RHO_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rho-ark-bootstrap.XXXXXX")"
RHO_TEST_ROOT="$(cd "$RHO_TEST_ROOT" && pwd)"
trap 'rm -rf -- "$RHO_TEST_ROOT"' EXIT

write_manifest() {
  local manifest="$1"
  local sha256="$2"
  node -e '
    const fs = require("node:fs");
    const [path, sha256] = process.argv.slice(1);
    fs.writeFileSync(path, JSON.stringify({
      version: "test",
      "macos-arm64": {url: "https://example.invalid/ark.zip", sha256}
    }));
  ' "$manifest" "$sha256"
}

expect_failure() {
  local label="$1"
  local expected="$2"
  local sha256="$3"
  local archive="$4"
  local case_root="$RHO_TEST_ROOT/$label"
  local output="$case_root/output.log"
  local case_repository="$case_root/repository"
  mkdir -p "$case_repository/scripts" "$case_repository/runtime"
  cp "$RHO_TEST_BOOTSTRAP_SOURCE" "$case_repository/scripts/bootstrap-ark-macos.sh"
  write_manifest "$case_repository/runtime/ark.json" "$sha256"
  if RHO_ARK_ARCHIVE="$archive" \
    RHO_ARK_RUNTIME_ROOT="$case_root/runtime" \
    RHO_ARK_SIDECAR="$case_root/staged/ark-aarch64-apple-darwin" \
    RHO_ARK_LICENSE_ROOT="$case_root/licenses" \
    "$case_repository/scripts/bootstrap-ark-macos.sh" >"$output" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$output"; then
    echo "$label did not report the expected failure: $expected" >&2
    sed -n '1,80p' "$output" >&2
    exit 1
  fi
}

RHO_BAD_ARCH_DIR="$RHO_TEST_ROOT/bad-arch-archive"
mkdir -p "$RHO_BAD_ARCH_DIR"
printf '#!/bin/sh\nexit 0\n' >"$RHO_BAD_ARCH_DIR/ark"
printf 'license fixture\n' >"$RHO_BAD_ARCH_DIR/LICENSE"
printf 'notice fixture\n' >"$RHO_BAD_ARCH_DIR/NOTICE"
chmod 755 "$RHO_BAD_ARCH_DIR/ark"
(cd "$RHO_BAD_ARCH_DIR" && zip -q "$RHO_TEST_ROOT/bad-arch.zip" ark LICENSE NOTICE)
RHO_BAD_ARCH_SHA="$(shasum -a 256 "$RHO_TEST_ROOT/bad-arch.zip" | awk '{print tolower($1)}')"

RHO_MISSING_ARK_DIR="$RHO_TEST_ROOT/missing-ark-archive"
mkdir -p "$RHO_MISSING_ARK_DIR"
printf 'license fixture\n' >"$RHO_MISSING_ARK_DIR/LICENSE"
printf 'notice fixture\n' >"$RHO_MISSING_ARK_DIR/NOTICE"
(cd "$RHO_MISSING_ARK_DIR" && zip -q "$RHO_TEST_ROOT/missing-ark.zip" LICENSE NOTICE)
RHO_MISSING_ARK_SHA="$(shasum -a 256 "$RHO_TEST_ROOT/missing-ark.zip" | awk '{print tolower($1)}')"

expect_failure \
  checksum \
  "Ark archive checksum mismatch" \
  "$(printf '0%.0s' {1..64})" \
  "$RHO_TEST_ROOT/bad-arch.zip"
expect_failure \
  missing-ark \
  "Ark archive did not contain the expected ark executable" \
  "$RHO_MISSING_ARK_SHA" \
  "$RHO_TEST_ROOT/missing-ark.zip"
expect_failure \
  architecture \
  "Ark executable is not a Mach-O binary" \
  "$RHO_BAD_ARCH_SHA" \
  "$RHO_TEST_ROOT/bad-arch.zip"

echo "Ark macOS bootstrap failure fixtures passed"

# Native executable fixture: validates staging paths, not Ark/R behavior.
RHO_SUCCESS_DIR="$RHO_TEST_ROOT/success-archive"
mkdir -p "$RHO_SUCCESS_DIR"
printf 'int main(void) { return 0; }\n' | clang -arch arm64 -x c - -o "$RHO_SUCCESS_DIR/ark"
printf 'license fixture\n' >"$RHO_SUCCESS_DIR/LICENSE"
printf 'notice fixture\n' >"$RHO_SUCCESS_DIR/NOTICE"
(cd "$RHO_SUCCESS_DIR" && zip -q "$RHO_TEST_ROOT/success.zip" ark LICENSE NOTICE)
RHO_SUCCESS_SHA="$(shasum -a 256 "$RHO_TEST_ROOT/success.zip" | awk '{print tolower($1)}')"
RHO_SUCCESS_REPOSITORY="$RHO_TEST_ROOT/success/repository"
mkdir -p "$RHO_SUCCESS_REPOSITORY/scripts" "$RHO_SUCCESS_REPOSITORY/runtime"
cp "$RHO_TEST_BOOTSTRAP_SOURCE" "$RHO_SUCCESS_REPOSITORY/scripts/bootstrap-ark-macos.sh"
write_manifest "$RHO_SUCCESS_REPOSITORY/runtime/ark.json" "$RHO_SUCCESS_SHA"
RHO_SUCCESS_OUTPUT="$(RHO_ARK_ARCHIVE="$RHO_TEST_ROOT/success.zip" "$RHO_SUCCESS_REPOSITORY/scripts/bootstrap-ark-macos.sh")"
test "$RHO_SUCCESS_OUTPUT" = "$RHO_SUCCESS_REPOSITORY/target/runtime/bin/ark"
test -x "$RHO_SUCCESS_OUTPUT"
test -f "$RHO_SUCCESS_REPOSITORY/target/runtime/notices/ark/LICENSE"
test -f "$RHO_SUCCESS_REPOSITORY/target/runtime/notices/ark/NOTICE"
test ! -e "$RHO_SUCCESS_REPOSITORY/desktop"
test ! -e "$RHO_SUCCESS_REPOSITORY/target/runtime/ark-test-macos-arm64/kernel.json"
echo "Ark macOS standalone staging fixture passed"
