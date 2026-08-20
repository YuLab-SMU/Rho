#!/usr/bin/env bash
set -euo pipefail

# LIN2: copy the verified Ark runtime resources from .rho/runtime into the
# Tauri resource tree before a Linux build, mirroring
# prepare-runtime-resources.ps1. The ark sidecar itself is consumed through
# Tauri externalBin (binaries/ark-x86_64-unknown-linux-gnu or
# binaries/ark-aarch64-unknown-linux-gnu), so only the license resources are
# copied here; the sidecar is verified to exist.

RHO_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_REPOSITORY_ROOT="$(cd "$RHO_SCRIPT_ROOT/.." && pwd)"
RHO_RUNTIME_ROOT="${RHO_RUNTIME_ROOT:-$RHO_REPOSITORY_ROOT/.rho/runtime}"
RHO_DESTINATION="${RHO_RUNTIME_RESOURCES_DESTINATION:-$RHO_REPOSITORY_ROOT/desktop/resources/runtime}"
RHO_MANIFEST="$RHO_REPOSITORY_ROOT/runtime/ark.json"

read_manifest() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], manifest);
    if (typeof value !== "string" || value.length === 0) process.exit(2);
    process.stdout.write(value);
  ' "$RHO_MANIFEST" "$1"
}

RHO_UNAME_M="${RHO_UNAME_M:-$(uname -m 2>/dev/null || echo unknown)}"
case "$RHO_UNAME_M" in
  x86_64)
    RHO_ARK_MANIFEST_KEY="linux-x64"
    RHO_ARK_SIDECAR_NAME="ark-x86_64-unknown-linux-gnu"
    ;;
  aarch64|arm64)
    RHO_ARK_MANIFEST_KEY="linux-arm64"
    RHO_ARK_SIDECAR_NAME="ark-aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "prepare-runtime-resources.sh supports linux x86-64 and aarch64 only (got $RHO_UNAME_M)" >&2
    exit 1
    ;;
esac

RHO_ARK_VERSION="$(read_manifest version)"
RHO_RUNTIME_SOURCE="$RHO_RUNTIME_ROOT/ark-$RHO_ARK_VERSION-$RHO_ARK_MANIFEST_KEY"
RHO_REQUIRED_FILES=(LICENSE NOTICE)
RHO_SIDECAR="$RHO_REPOSITORY_ROOT/desktop/src-tauri/binaries/$RHO_ARK_SIDECAR_NAME"

if [[ ! -f "$RHO_SIDECAR" ]]; then
  echo "Required Ark sidecar is missing: $RHO_SIDECAR. Run scripts/bootstrap-ark-linux.sh first." >&2
  exit 1
fi
for RHO_NAME in "${RHO_REQUIRED_FILES[@]}"; do
  if [[ ! -f "$RHO_RUNTIME_SOURCE/$RHO_NAME" ]]; then
    echo "Required Ark runtime file is missing: $RHO_RUNTIME_SOURCE/$RHO_NAME. Run scripts/bootstrap-ark-linux.sh first." >&2
    exit 1
  fi
done

mkdir -p "$RHO_DESTINATION"

# Stage one file into the Tauri resource tree with atomic partial-file
# replacement and a post-copy checksum verification. This is the only way
# files enter the resource tree, so a bundled resource is always the exact
# verified artifact, never a stale ignored file.
stage_file() {
  local source_file="$1"
  local destination_file="$2"
  local source_hash
  source_hash="$(sha256sum "$source_file" | awk '{print $1}')"
  if [[ -f "$destination_file" ]]; then
    local destination_hash
    destination_hash="$(sha256sum "$destination_file" | awk '{print $1}')"
    if [[ "$source_hash" == "$destination_hash" ]]; then
      echo "Runtime resource is current: $destination_file"
      return 0
    fi
  fi
  cp "$source_file" "$destination_file.partial"
  mv "$destination_file.partial" "$destination_file"
  local copied_hash
  copied_hash="$(sha256sum "$destination_file" | awk '{print $1}')"
  if [[ "$copied_hash" != "$source_hash" ]]; then
    echo "Runtime resource checksum mismatch after copying $destination_file." >&2
    exit 1
  fi
  echo "Prepared runtime resource: $destination_file"
}

for RHO_NAME in "${RHO_REQUIRED_FILES[@]}"; do
  stage_file "$RHO_RUNTIME_SOURCE/$RHO_NAME" "$RHO_DESTINATION/$RHO_NAME"
done

# The bundled resources/runtime/ark is the first ark_candidate_paths
# preference for the installed/deb layout, so it must be the checked sidecar
# (staged and ELF-verified by bootstrap-ark-linux.sh), never whatever ignored
# file happens to sit in the runtime directory.
stage_file "$RHO_SIDECAR" "$RHO_DESTINATION/ark"
chmod 755 "$RHO_DESTINATION/ark"
