#!/usr/bin/env bash
set -euo pipefail

# LIN1: download, verify, and stage the pinned Ark Linux sidecar for the
# current architecture (linux-x64 or linux-arm64).
#
# Authority: runtime/ark.json (linux-x64, linux-arm64), the same manifest
# discipline used on Windows and macOS. This script:
#   - downloads the pinned archive with checksum verification (or reuses
#     RHO_ARK_ARCHIVE when provided);
#   - rejects non-matching ELF binaries (x86-64 / aarch64), missing
#     LICENSE/NOTICE, checksum mismatch, and alternate versions;
#   - stages the sidecar as desktop/src-tauri/binaries/ark-x86_64-unknown-linux-gnu
#     or ark-aarch64-unknown-linux-gnu (Tauri externalBin naming); LICENSE/NOTICE
#     stay in the runtime root and are copied into the Tauri resource tree by
#     prepare-runtime-resources.sh before a build;
#   - writes a Linux kernelspec with the resolved R home/bin/libraries and a
#     controlled PATH (no user/site/project startup files), matching the
#     Windows/Mac controlled-startup policy.
#
# The generated sidecar and runtime files remain ignored by git; the manifest,
# this script, and its fixture tests are tracked.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "bootstrap-ark-linux.sh supports Linux only" >&2
  exit 1
fi

# Test override hook (same style as the install-from-source fixture):
# uname -m cannot be faked on the fixture host, so arm64 branches are tested
# by injecting RHO_UNAME_M.
RHO_UNAME_M="${RHO_UNAME_M:-$(uname -m 2>/dev/null || echo unknown)}"
case "$RHO_UNAME_M" in
  x86_64)
    RHO_ARK_MANIFEST_KEY="linux-x64"
    RHO_ARK_SIDECAR_NAME="ark-x86_64-unknown-linux-gnu"
    RHO_ARK_ELF_PATTERN='ELF 64-bit LSB (executable|pie executable|shared object), x86-64'
    RHO_ARCH_DISPLAY="an x86-64"
    ;;
  aarch64|arm64)
    RHO_ARK_MANIFEST_KEY="linux-arm64"
    RHO_ARK_SIDECAR_NAME="ark-aarch64-unknown-linux-gnu"
    RHO_ARK_ELF_PATTERN='ELF 64-bit LSB (executable|pie executable|shared object), ARM aarch64'
    RHO_ARCH_DISPLAY="a aarch64"
    ;;
  *)
    echo "bootstrap-ark-linux.sh supports linux x86-64 and aarch64 only (got $RHO_UNAME_M)" >&2
    exit 1
    ;;
esac

RHO_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_REPOSITORY_ROOT="$(cd "$RHO_SCRIPT_ROOT/.." && pwd)"
RHO_MANIFEST="$RHO_REPOSITORY_ROOT/runtime/ark.json"
RHO_RUNTIME_ROOT="${RHO_ARK_RUNTIME_ROOT:-$RHO_REPOSITORY_ROOT/.rho/runtime}"
RHO_SIDECAR="${RHO_ARK_SIDECAR:-$RHO_REPOSITORY_ROOT/desktop/src-tauri/binaries/$RHO_ARK_SIDECAR_NAME}"

read_manifest() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], manifest);
    if (typeof value !== "string" || value.length === 0) process.exit(2);
    process.stdout.write(value);
  ' "$RHO_MANIFEST" "$1"
}

RHO_ARK_VERSION="$(read_manifest version)"
RHO_ARK_URL="$(read_manifest "$RHO_ARK_MANIFEST_KEY.url")"
RHO_EXPECTED_SHA256="$(read_manifest "$RHO_ARK_MANIFEST_KEY.sha256" | tr '[:upper:]' '[:lower:]')"
RHO_INSTALL_ROOT="$RHO_RUNTIME_ROOT/ark-$RHO_ARK_VERSION-$RHO_ARK_MANIFEST_KEY"
RHO_ARCHIVE_DEFAULT="$RHO_RUNTIME_ROOT/ark-$RHO_ARK_VERSION-$RHO_ARK_MANIFEST_KEY.zip"
RHO_ARCHIVE="${RHO_ARK_ARCHIVE:-$RHO_ARCHIVE_DEFAULT}"
RHO_ARK_BINARY="$RHO_INSTALL_ROOT/ark"
RHO_KERNEL_SPEC="$RHO_INSTALL_ROOT/kernel.json"
RHO_EMPTY_RENVIRON="$RHO_INSTALL_ROOT/empty.Renviron"
RHO_ARK_LOG="$RHO_INSTALL_ROOT/ark.log"

mkdir -p "$RHO_RUNTIME_ROOT" "$(dirname "$RHO_SIDECAR")"

if [[ -z "${RHO_ARK_ARCHIVE:-}" && ! -f "$RHO_ARCHIVE" ]]; then
  RHO_DOWNLOAD_PART="$RHO_ARCHIVE.partial"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$RHO_DOWNLOAD_PART" "$RHO_ARK_URL"
  mv "$RHO_DOWNLOAD_PART" "$RHO_ARCHIVE"
fi
if [[ ! -f "$RHO_ARCHIVE" ]]; then
  echo "Ark archive was not found: $RHO_ARCHIVE" >&2
  exit 1
fi

RHO_ACTUAL_SHA256="$(sha256sum "$RHO_ARCHIVE" | awk '{print tolower($1)}')"
if [[ "$RHO_ACTUAL_SHA256" != "$RHO_EXPECTED_SHA256" ]]; then
  echo "Ark archive checksum mismatch: expected $RHO_EXPECTED_SHA256, got $RHO_ACTUAL_SHA256" >&2
  exit 1
fi

mkdir -p "$RHO_INSTALL_ROOT"
unzip -q -o "$RHO_ARCHIVE" -d "$RHO_INSTALL_ROOT"
if [[ ! -f "$RHO_ARK_BINARY" ]]; then
  echo "Ark archive did not contain the expected ark executable" >&2
  exit 1
fi
for RHO_NOTICE_FILE in LICENSE NOTICE; do
  if [[ ! -f "$RHO_INSTALL_ROOT/$RHO_NOTICE_FILE" ]]; then
    echo "Ark archive did not contain $RHO_NOTICE_FILE" >&2
    exit 1
  fi
done

chmod 755 "$RHO_ARK_BINARY"
if ! file "$RHO_ARK_BINARY" | grep -Eq "$RHO_ARK_ELF_PATTERN"; then
  echo "Ark executable is not $RHO_ARCH_DISPLAY ELF binary" >&2
  exit 1
fi

cp "$RHO_ARK_BINARY" "$RHO_SIDECAR.partial"
chmod 755 "$RHO_SIDECAR.partial"
mv "$RHO_SIDECAR.partial" "$RHO_SIDECAR"

# Kernelspec with controlled startup: resolve R home/bin/libraries through the
# requested Rscript and bind an empty user .Renviron so no user/site/project
# startup file can change the session, matching the Windows/Mac policy.
RHO_RSCRIPT_COMMAND="${RHO_RSCRIPT:-Rscript}"
if ! command -v "$RHO_RSCRIPT_COMMAND" >/dev/null 2>&1; then
  echo "Rscript was not found. Set RHO_RSCRIPT or install R, then retry." >&2
  exit 1
fi
RHO_R_HOME="$("$RHO_RSCRIPT_COMMAND" -e 'cat(normalizePath(R.home(), winslash = "/", mustWork = TRUE))')"
RHO_R_BIN="$("$RHO_RSCRIPT_COMMAND" -e 'cat(normalizePath(R.home("bin"), winslash = "/", mustWork = TRUE))')"
RHO_R_LIBS="$("$RHO_RSCRIPT_COMMAND" -e 'cat(paste(normalizePath(.libPaths(), winslash = "/", mustWork = TRUE), collapse = .Platform$path.sep))')"
if [[ -z "$RHO_R_HOME" || -z "$RHO_R_BIN" || -z "$RHO_R_LIBS" ]]; then
  echo "Unable to resolve R_HOME, the R bin directory and R libraries through $RHO_RSCRIPT_COMMAND" >&2
  exit 1
fi

: > "$RHO_EMPTY_RENVIRON.partial"
mv "$RHO_EMPTY_RENVIRON.partial" "$RHO_EMPTY_RENVIRON"
node -e '
  const fs = require("node:fs");
  const [kernelSpecPath, ark, log, emptyRenviron, version, rHome, rBin, rLibs, pathValue] = process.argv.slice(1);
  const spec = {
    argv: [
      ark,
      "--connection_file",
      "{connection_file}",
      "--session-mode",
      "console",
      "--log",
      log,
      "--",
      "--interactive",
      "--no-environ",
      "--no-init-file",
      "--no-site-file"
    ],
    display_name: `Ark R ${version} (Rho)`,
    language: "R",
    interrupt_mode: "message",
    kernel_protocol_version: "5.4",
    env: {
      R_HOME: rHome,
      R_LIBS: rLibs,
      R_ENVIRON_USER: emptyRenviron,
      PATH: `${rBin}:${pathValue}`
    }
  };
  fs.writeFileSync(kernelSpecPath, JSON.stringify(spec, null, 2) + "\n");
' "$RHO_KERNEL_SPEC" "$RHO_SIDECAR" "$RHO_ARK_LOG" "$RHO_EMPTY_RENVIRON" \
  "$RHO_ARK_VERSION" "$RHO_R_HOME" "$RHO_R_BIN" "$RHO_R_LIBS" "$PATH"

"$RHO_SIDECAR" --version >/dev/null
printf '%s\n' "$RHO_SIDECAR"
