#!/usr/bin/env bash
set -euo pipefail

# LIN1 fixture tests for scripts/bootstrap-ark-linux.sh. Run on Linux x86-64.
# Negative fixtures need no R; the success fixture additionally needs Rscript
# (it probes R to write the kernelspec) and is skipped when R is absent.

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Ark Linux bootstrap fixture tests require Linux x86-64" >&2
  exit 1
fi

RHO_TEST_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_TEST_BOOTSTRAP_SOURCE="$RHO_TEST_SCRIPT_ROOT/bootstrap-ark-linux.sh"
RHO_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rho-ark-bootstrap-linux.XXXXXX")"
trap 'rm -rf -- "$RHO_TEST_ROOT"' EXIT

write_manifest() {
  local manifest="$1"
  local sha256="$2"
  node -e '
    const fs = require("node:fs");
    const [path, sha256] = process.argv.slice(1);
    fs.writeFileSync(path, JSON.stringify({
      version: "test",
      "linux-x64": {url: "https://example.invalid/ark.zip", sha256},
      "linux-arm64": {url: "https://example.invalid/ark-arm64.zip", sha256}
    }));
  ' "$manifest" "$sha256"
}

expect_failure() {
  local label="$1"
  local expected="$2"
  local sha256="$3"
  local archive="$4"
  local uname_m="${5:-}"
  local case_root="$RHO_TEST_ROOT/$label"
  local output="$case_root/output.log"
  local case_repository="$case_root/repository"
  mkdir -p "$case_repository/scripts" "$case_repository/runtime"
  cp "$RHO_TEST_BOOTSTRAP_SOURCE" "$case_repository/scripts/bootstrap-ark-linux.sh"
  write_manifest "$case_repository/runtime/ark.json" "$sha256"
  if RHO_ARK_ARCHIVE="$archive" \
    RHO_ARK_RUNTIME_ROOT="$case_root/runtime" \
    RHO_ARK_SIDECAR="$case_root/staged/ark-x86_64-unknown-linux-gnu" \
    RHO_UNAME_M="$uname_m" \
    "$case_repository/scripts/bootstrap-ark-linux.sh" >"$output" 2>&1; then
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
RHO_BAD_ARCH_SHA="$(sha256sum "$RHO_TEST_ROOT/bad-arch.zip" | awk '{print tolower($1)}')"

RHO_MISSING_ARK_DIR="$RHO_TEST_ROOT/missing-ark-archive"
mkdir -p "$RHO_MISSING_ARK_DIR"
printf 'license fixture\n' >"$RHO_MISSING_ARK_DIR/LICENSE"
printf 'notice fixture\n' >"$RHO_MISSING_ARK_DIR/NOTICE"
(cd "$RHO_MISSING_ARK_DIR" && zip -q "$RHO_TEST_ROOT/missing-ark.zip" LICENSE NOTICE)
RHO_MISSING_ARK_SHA="$(sha256sum "$RHO_TEST_ROOT/missing-ark.zip" | awk '{print tolower($1)}')"

RHO_MISSING_LICENSE_DIR="$RHO_TEST_ROOT/missing-license-archive"
mkdir -p "$RHO_MISSING_LICENSE_DIR"
printf 'notice fixture\n' >"$RHO_MISSING_LICENSE_DIR/NOTICE"
cp /bin/true "$RHO_MISSING_LICENSE_DIR/ark"
chmod 755 "$RHO_MISSING_LICENSE_DIR/ark"
(cd "$RHO_MISSING_LICENSE_DIR" && zip -q "$RHO_TEST_ROOT/missing-license.zip" ark NOTICE)
RHO_MISSING_LICENSE_SHA="$(sha256sum "$RHO_TEST_ROOT/missing-license.zip" | awk '{print tolower($1)}')"

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
  "Ark executable is not an x86-64 ELF binary" \
  "$RHO_BAD_ARCH_SHA" \
  "$RHO_TEST_ROOT/bad-arch.zip"
expect_failure \
  missing-license \
  "Ark archive did not contain LICENSE" \
  "$RHO_MISSING_LICENSE_SHA" \
  "$RHO_TEST_ROOT/missing-license.zip"

# arm64 branch: the same non-matching fixture must be rejected as not-aarch64,
# and the sidecar naming/runtime dir follow the linux-arm64 manifest entry.
expect_failure \
  arm64-architecture \
  "Ark executable is not a aarch64 ELF binary" \
  "$RHO_BAD_ARCH_SHA" \
  "$RHO_TEST_ROOT/bad-arch.zip" \
  aarch64

# Unsupported Linux architectures are rejected before any manifest access.
RHO_UNSUPPORTED_ARCH_OUTPUT="$(RHO_UNAME_M=riscv64 "$RHO_TEST_BOOTSTRAP_SOURCE" 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  echo "unsupported-arch unexpectedly succeeded" >&2
  exit 1
fi
if ! grep -q "supports linux x86-64 and aarch64 only" <<<"$RHO_UNSUPPORTED_ARCH_OUTPUT"; then
  echo "unsupported-arch did not report the expected rejection" >&2
  sed -n '1,40p' <<<"$RHO_UNSUPPORTED_ARCH_OUTPUT" >&2
  exit 1
fi

echo "Ark Linux bootstrap failure fixtures passed"

if command -v Rscript >/dev/null 2>&1; then
  RHO_SUCCESS_DIR="$RHO_TEST_ROOT/success-archive"
  mkdir -p "$RHO_SUCCESS_DIR"
  cp /bin/true "$RHO_SUCCESS_DIR/ark"
  chmod 755 "$RHO_SUCCESS_DIR/ark"
  printf 'license fixture\n' >"$RHO_SUCCESS_DIR/LICENSE"
  printf 'notice fixture\n' >"$RHO_SUCCESS_DIR/NOTICE"
  (cd "$RHO_SUCCESS_DIR" && zip -q "$RHO_TEST_ROOT/success.zip" ark LICENSE NOTICE)
  RHO_SUCCESS_SHA="$(sha256sum "$RHO_TEST_ROOT/success.zip" | awk '{print tolower($1)}')"

  RHO_SUCCESS_CASE="$RHO_TEST_ROOT/success"
  RHO_SUCCESS_REPOSITORY="$RHO_SUCCESS_CASE/repository"
  mkdir -p "$RHO_SUCCESS_REPOSITORY/scripts" "$RHO_SUCCESS_REPOSITORY/runtime"
  cp "$RHO_TEST_BOOTSTRAP_SOURCE" "$RHO_SUCCESS_REPOSITORY/scripts/bootstrap-ark-linux.sh"
  write_manifest "$RHO_SUCCESS_REPOSITORY/runtime/ark.json" "$RHO_SUCCESS_SHA"

  RHO_SUCCESS_OUTPUT="$(RHO_ARK_ARCHIVE="$RHO_TEST_ROOT/success.zip" \
    RHO_ARK_RUNTIME_ROOT="$RHO_SUCCESS_CASE/runtime" \
    RHO_ARK_SIDECAR="$RHO_SUCCESS_CASE/staged/ark-x86_64-unknown-linux-gnu" \
    "$RHO_SUCCESS_REPOSITORY/scripts/bootstrap-ark-linux.sh")"
  if [[ ! -x "$RHO_SUCCESS_CASE/staged/ark-x86_64-unknown-linux-gnu" ]]; then
    echo "success fixture did not stage an executable sidecar" >&2
    exit 1
  fi
  for RHO_EXPECTED_FILE in "$RHO_SUCCESS_CASE/runtime/ark-test-linux-x64/LICENSE" "$RHO_SUCCESS_CASE/runtime/ark-test-linux-x64/NOTICE"; do
    if [[ ! -f "$RHO_EXPECTED_FILE" ]]; then
      echo "success fixture did not retain $RHO_EXPECTED_FILE in the runtime root" >&2
      exit 1
    fi
  done
  RHO_KERNEL_SPEC="$RHO_SUCCESS_CASE/runtime/ark-test-linux-x64/kernel.json"
  if [[ ! -f "$RHO_KERNEL_SPEC" ]]; then
    echo "success fixture did not write a kernelspec" >&2
    exit 1
  fi
  if ! grep -q '"--no-init-file"' "$RHO_KERNEL_SPEC"; then
    echo "success fixture kernelspec is not controlled-startup" >&2
    exit 1
  fi
  if ! grep -q '"R_HOME"' "$RHO_KERNEL_SPEC"; then
    echo "success fixture kernelspec is missing R_HOME" >&2
    exit 1
  fi
  echo "Ark Linux bootstrap success fixture passed"
else
  echo "Rscript is not installed; Ark Linux bootstrap success fixture skipped"
fi
