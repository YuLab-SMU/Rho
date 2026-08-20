#!/usr/bin/env bash
set -euo pipefail

# S1 fixture tests for scripts/install-from-source.sh.
#
# Scope: diagnostics phase (platform/distro detection, dependency report,
# distro package maps, --json schema, exit codes, argument parsing) plus a
# source-level assertion for the BSD map (uname -s cannot be faked on this
# host). No network, no root, no real build: the fixture runs the script with
# a PATH restricted to a shim directory that contains only the tools the
# script itself needs, so every checked requirement (cargo, node, curl,
# unzip, file, Rscript, pkg-config libraries) is reported missing.
#
# The full build/install orchestration is verified separately by the S1-B
# real-system gate (the script reaches the build phase when the host is
# complete, and the official AppImage lane proves the compile).

RHO_TEST_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_SOURCE="$RHO_TEST_SCRIPT_ROOT/install-from-source.sh"
RHO_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rho-install-from-source.XXXXXX")"
trap 'rm -rf -- "$RHO_TEST_ROOT"' EXIT

if [[ ! -x "$RHO_SOURCE" ]]; then
  echo "install-from-source.sh is not executable" >&2
  exit 1
fi

# --- shim PATH: tools the script itself needs, none of the checked ones ----
RHO_SHIM="$RHO_TEST_ROOT/shim"
mkdir -p "$RHO_SHIM"
for tool in bash sed tr grep head uname dirname; do
  RHO_TOOL_PATH="$(command -v "$tool")"
  if [[ -z "$RHO_TOOL_PATH" ]]; then
    echo "fixture host is missing $tool" >&2
    exit 1
  fi
  ln -s "$RHO_TOOL_PATH" "$RHO_SHIM/$tool"
done
# Fake pkg-config: every module is reported missing (library checks).
printf '#!/bin/sh\nexit 1\n' >"$RHO_SHIM/pkg-config"
chmod +x "$RHO_SHIM/pkg-config"

write_os_release() {
  local name="$1"
  local id="$2"
  printf 'NAME=Fake %s\nID=%s\n' "$name" "$id" >"$RHO_TEST_ROOT/os-release-$name"
}

write_os_release ubuntu 'ubuntu'
write_os_release fedora 'fedora'
write_os_release arch '"arch"'
write_os_release opensuse 'opensuse-tumbleweed'
write_os_release alpine 'alpine'
write_os_release slackware 'slackware'

fail() {
  local label="$1"
  local detail="$2"
  echo "FAIL [$label]: $detail" >&2
  exit 1
}

# run_expect <label> <expected-rc> <os-release-file> [args...] -- asserts the
# exit code and that stdout+stderr contains every string given after '--'.
# Optional caller-set RHO_FIXTURE_UNAME_S/RHO_FIXTURE_UNAME_M override the
# uname hooks; empty values fall back to the real uname.
run_expect() {
  local label="$1"
  local expected_rc="$2"
  local os_release="$3"
  shift 3
  local args=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    args+=("$1")
    shift
  done
  shift # the "--"
  local output rc
  output="$(RHO_OS_RELEASE="$os_release" \
    RHO_UNAME_S="${RHO_FIXTURE_UNAME_S:-}" \
    RHO_UNAME_M="${RHO_FIXTURE_UNAME_M:-}" \
    PATH="$RHO_SHIM" "$RHO_SOURCE" "${args[@]}" 2>&1)" && rc=0 || rc=$?
  if [[ "$rc" -ne "$expected_rc" ]]; then
    fail "$label" "expected exit $expected_rc, got $rc"
  fi
  local expected
  for expected in "$@"; do
    if ! grep -qF "$expected" <<<"$output"; then
      fail "$label" "output missing: $expected (output below)\n$output"
    fi
  done
}

# --- usage / help --------------------------------------------------------------
output="$(PATH="$RHO_SHIM" "$RHO_SOURCE" --nope 2>&1)" && rc=0 || rc=$?
[[ "$rc" -eq 1 ]] || fail usage-error "expected exit 1, got $rc"
grep -qF "unknown argument: --nope" <<<"$output" || fail usage-error "missing unknown-argument message"
grep -qF "Usage:" <<<"$output" || fail usage-error "missing usage text"

output="$(PATH="$RHO_SHIM" "$RHO_SOURCE" --help 2>&1)" && rc=0 || rc=$?
[[ "$rc" -eq 0 ]] || fail help "expected exit 0, got $rc"
grep -qF "install-from-source.sh" <<<"$output" || fail help "missing usage text"

# --- distro package maps --------------------------------------------------------
run_expect ubuntu-map 2 "$RHO_TEST_ROOT/os-release-ubuntu" -- \
  "MISSING COMMAND: cargo" \
  "required for: building the rho-desktop binary" \
  "install rustup" \
  "apt-get install -y cargo" \
  "MISSING COMMAND: node" \
  "apt-get install -y nodejs" \
  "MISSING COMMAND: Rscript" \
  "apt-get install -y r-base" \
  "MISSING LIBRARY: webkit2gtk-4.1" \
  "apt-get install -y libwebkit2gtk-4.1-dev" \
  "MISSING LIBRARY: gtk+-3.0" \
  "apt-get install -y libgtk-3-dev" \
  "8 missing requirement(s)"

run_expect fedora-map 2 "$RHO_TEST_ROOT/os-release-fedora" -- \
  "dnf install -y cargo" \
  "dnf install -y webkit2gtk4.1-devel" \
  "dnf install -y gtk3-devel" \
  "dnf install -y R"

run_expect arch-map 2 "$RHO_TEST_ROOT/os-release-arch" -- \
  "pacman -S --needed" \
  "pacman -S --needed webkit2gtk-4.1" \
  "pacman -S --needed r"

run_expect opensuse-map 2 "$RHO_TEST_ROOT/os-release-opensuse" -- \
  "zypper install -y" \
  "zypper install -y webkit2gtk4-devel" \
  "zypper install -y R-base"

run_expect alpine-map 2 "$RHO_TEST_ROOT/os-release-alpine" -- \
  "apk add" \
  "apk add webkit2gtk-4.1-dev" \
  "apk add R"

run_expect unknown-map 2 "$RHO_TEST_ROOT/os-release-slackware" -- \
  "install rustup" \
  "no package-name map for slackware yet; install the equivalent of curl with your system package manager" \
  "open a PR to scripts/install-from-source.sh to add a map for slackware" \
  "install the equivalent of webkit2gtk-4.1 with your system package manager"

# --- platform support follows the Ark manifest (runtime/ark.json) --------------
# BSD is rejected: Ark has no BSD build.
output="$(RHO_UNAME_S=FreeBSD PATH="$RHO_SHIM" "$RHO_SOURCE" 2>&1)" && rc=0 || rc=$?
[[ "$rc" -eq 1 ]] || fail bsd-rejected "expected exit 1 for FreeBSD, got $rc"
grep -qF "BSD has no Ark build" <<<"$output" || fail bsd-rejected "missing BSD rejection message"
grep -qF "source install is offered on Linux only" <<<"$output" || fail bsd-rejected "missing Linux-only guidance"

# linux-arm64: fully wired through bootstrap-ark-linux.sh, so no Ark warning.
RHO_FIXTURE_UNAME_M=aarch64 run_expect linux-arm64-wired 2 "$RHO_TEST_ROOT/os-release-ubuntu" -- \
  "MISSING COMMAND: cargo"

# Confirm the arm64 branch emits no "no Ark build" / "not wired" warning.
RHO_ARM64_OUTPUT="$(RHO_UNAME_M=aarch64 RHO_OS_RELEASE="$RHO_TEST_ROOT/os-release-ubuntu" PATH="$RHO_SHIM" "$RHO_SOURCE" 2>&1)" && rc=0 || rc=$?
[[ "$rc" -eq 2 ]] || fail linux-arm64-no-warning "expected exit 2, got $rc"
if grep -qE "no Ark build|not wired" <<<"$RHO_ARM64_OUTPUT"; then
  fail linux-arm64-no-warning "arm64 branch must not warn about Ark availability"
fi

# Other Linux architectures: no Ark build in the manifest.
RHO_FIXTURE_UNAME_M=riscv64 run_expect linux-riscv64-no-ark 2 "$RHO_TEST_ROOT/os-release-ubuntu" -- \
  "runtime/ark.json has no Ark build for linux/riscv64"

# --- JSON schema ---------------------------------------------------------------
output="$(RHO_OS_RELEASE="$RHO_TEST_ROOT/os-release-arch" PATH="$RHO_SHIM" "$RHO_SOURCE" --json 2>&1)" && rc=0 || rc=$?
[[ "$rc" -eq 2 ]] || fail json-exit "expected exit 2, got $rc"
RHO_NODE="$(command -v node || true)"
if [[ -n "$RHO_NODE" ]]; then
  "$RHO_NODE" -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const assert = require("node:assert/strict");
    assert.equal(report.os, "linux");
    assert.equal(report.distro, "arch");
    assert.equal(report.ok, false);
    const kinds = Object.fromEntries(report.missing.map((m) => [m.name, m.kind]));
    assert.equal(kinds.cargo, "command");
    assert.equal(kinds["webkit2gtk-4.1"], "library");
    const cargo = report.missing.find((m) => m.name === "cargo");
    assert.match(cargo.suggest, /rustup/);
    const webkit = report.missing.find((m) => m.name === "webkit2gtk-4.1");
    assert.match(webkit.suggest, /pacman/);
    assert.ok(Array.isArray(report.warnings));
  ' <(printf '%s' "$output")
else
  echo "note: node unavailable; JSON schema assertion skipped" >&2
fi

echo "install-from-source fixture tests passed."
