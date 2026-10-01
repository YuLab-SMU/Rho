#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bootstrap-ark-macos.sh supports macOS only" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This Ark bootstrap supports Apple Silicon only" >&2
  exit 1
fi

RHO_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_REPOSITORY_ROOT="$(cd "$RHO_SCRIPT_ROOT/.." && pwd)"
RHO_MANIFEST="$RHO_REPOSITORY_ROOT/runtime/ark.json"
RHO_RUNTIME_ROOT="${RHO_ARK_RUNTIME_ROOT:-$RHO_REPOSITORY_ROOT/target/runtime}"
RHO_SIDECAR="${RHO_ARK_SIDECAR:-$RHO_RUNTIME_ROOT/bin/ark}"
RHO_LICENSE_ROOT="${RHO_ARK_LICENSE_ROOT:-$RHO_RUNTIME_ROOT/notices/ark}"

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
RHO_ARK_URL="$(read_manifest macos-arm64.url)"
RHO_EXPECTED_SHA256="$(read_manifest macos-arm64.sha256 | tr '[:upper:]' '[:lower:]')"
RHO_INSTALL_ROOT="$RHO_RUNTIME_ROOT/ark-$RHO_ARK_VERSION-macos-arm64"
RHO_ARCHIVE_DEFAULT="$RHO_RUNTIME_ROOT/ark-$RHO_ARK_VERSION-darwin-arm64.zip"
RHO_ARCHIVE="${RHO_ARK_ARCHIVE:-$RHO_ARCHIVE_DEFAULT}"

mkdir -p "$RHO_RUNTIME_ROOT" "$(dirname "$RHO_SIDECAR")" "$RHO_LICENSE_ROOT"

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

RHO_ACTUAL_SHA256="$(shasum -a 256 "$RHO_ARCHIVE" | awk '{print tolower($1)}')"
if [[ "$RHO_ACTUAL_SHA256" != "$RHO_EXPECTED_SHA256" ]]; then
  echo "Ark archive checksum mismatch: expected $RHO_EXPECTED_SHA256, got $RHO_ACTUAL_SHA256" >&2
  exit 1
fi

mkdir -p "$RHO_INSTALL_ROOT"
unzip -q -o "$RHO_ARCHIVE" -d "$RHO_INSTALL_ROOT"
RHO_ARK_BINARY="$RHO_INSTALL_ROOT/ark"
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
if ! RHO_ARCHS="$(lipo -archs "$RHO_ARK_BINARY" 2>/dev/null)"; then
  echo "Ark executable is not a Mach-O binary" >&2
  exit 1
fi
if [[ " $RHO_ARCHS " != *" arm64 "* ]]; then
  echo "Ark executable is not arm64: $RHO_ARCHS" >&2
  exit 1
fi
if ! file "$RHO_ARK_BINARY" | grep -q 'Mach-O 64-bit executable arm64'; then
  echo "Ark executable is not an arm64 Mach-O" >&2
  exit 1
fi

cp "$RHO_ARK_BINARY" "$RHO_SIDECAR.partial"
chmod 755 "$RHO_SIDECAR.partial"
mv "$RHO_SIDECAR.partial" "$RHO_SIDECAR"
for RHO_NOTICE_FILE in LICENSE NOTICE; do
  cp "$RHO_INSTALL_ROOT/$RHO_NOTICE_FILE" "$RHO_LICENSE_ROOT/$RHO_NOTICE_FILE.partial"
  mv "$RHO_LICENSE_ROOT/$RHO_NOTICE_FILE.partial" "$RHO_LICENSE_ROOT/$RHO_NOTICE_FILE"
done

"$RHO_SIDECAR" --version >/dev/null
printf '%s\n' "$RHO_SIDECAR"
