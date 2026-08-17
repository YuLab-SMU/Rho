#!/usr/bin/env bash
set -euo pipefail

# LIN2: local Linux build lane, mirroring build-windows-installer.ps1.
#
# Preconditions:
#   - Linux x86-64;
#   - Rust (cargo) on PATH; the repository rust-toolchain.toml pins 1.97.0;
#   - npx (Node.js) on PATH;
#   - libwebkit2gtk-4.1-dev installed (build-time WebKitGTK headers);
#   - scripts/bootstrap-ark-linux.sh already run (staged sidecar + runtime).
#
# Produces target/release/bundle/appimage/Rho_<version>_x86_64.AppImage,
# replaces its AppRun with the LIN3 dependency-check wrapper, records the
# artifact SHA-256, and prints the same required artifact facts as the
# Windows build report.

RHO_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_REPOSITORY_ROOT="$(cd "$RHO_SCRIPT_ROOT/.." && pwd)"
RHO_TAURI_CLI_VERSION="${RHO_TAURI_CLI_VERSION:-2.11.4}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "build-linux.sh supports Linux x86-64 only" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found on PATH. Install the Rust toolchain pinned in rust-toolchain.toml (1.97.0)." >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "npx was not found on PATH. Install Node.js 18 or later." >&2
  exit 1
fi
if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists webkit2gtk-4.1; then
  echo "webkit2gtk-4.1 development files were not found." >&2
  echo "On Debian/Ubuntu install them with: sudo apt install libwebkit2gtk-4.1-dev" >&2
  exit 1
fi

# CARGO_HOME is only used for a reproducible source remap, matching the
# Windows script. Default to ~/.cargo when unset.
RHO_CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RHO_SOURCE_REMAP="--remap-path-prefix=$RHO_CARGO_HOME=/cargo --remap-path-prefix=$RHO_REPOSITORY_ROOT=/rho"
export RUSTFLAGS="${RHO_SOURCE_REMAP}${RUSTFLAGS:+ $RUSTFLAGS}"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  RHO_EPHEMERAL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rho-linux-updater-key.XXXXXX")"
  RHO_EPHEMERAL_KEY="$RHO_EPHEMERAL_DIR/private.key"
  npx -y "@tauri-apps/cli@$RHO_TAURI_CLI_VERSION" signer generate --ci --write-keys "$RHO_EPHEMERAL_KEY"
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$RHO_EPHEMERAL_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi

# Verify the Ark sidecar and runtime resources are in place before building.
"$RHO_SCRIPT_ROOT/prepare-runtime-resources.sh"

RHO_TAURI_CONFIG="$RHO_REPOSITORY_ROOT/desktop/src-tauri/tauri.conf.json"
RHO_PRODUCT_NAME="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).productName)' "$RHO_TAURI_CONFIG")"
RHO_VERSION="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$RHO_TAURI_CONFIG")"
RHO_BUNDLE_DIR="$RHO_REPOSITORY_ROOT/target/release/bundle/appimage"
RHO_EXPECTED_NAME="${RHO_PRODUCT_NAME}_${RHO_VERSION}_x86_64.AppImage"

(
  cd "$RHO_REPOSITORY_ROOT/desktop/src-tauri"
  npx -y "@tauri-apps/cli@$RHO_TAURI_CLI_VERSION" build
)

if [[ ! -d "$RHO_BUNDLE_DIR" ]]; then
  echo "Tauri did not produce $RHO_BUNDLE_DIR." >&2
  exit 1
fi
RHO_PRODUCED="$(find "$RHO_BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' -type f | sort | tail -n 1)"
if [[ -z "$RHO_PRODUCED" ]]; then
  echo "No AppImage was produced under $RHO_BUNDLE_DIR." >&2
  exit 1
fi
RHO_APPIMAGE="$RHO_BUNDLE_DIR/$RHO_EXPECTED_NAME"
if [[ "$(realpath "$RHO_PRODUCED")" != "$(realpath "$RHO_APPIMAGE")" ]]; then
  mv "$RHO_PRODUCED" "$RHO_APPIMAGE"
fi
chmod +x "$RHO_APPIMAGE"

# LIN3: replace the default AppRun with the dependency-check wrapper.
"$RHO_SCRIPT_ROOT/patch-appimage-apprun.sh" "$RHO_APPIMAGE"

# AppRun replacement changes AppImage bytes, so discard Tauri's pre-patch
# signature and sign only the final image.
find "$RHO_BUNDLE_DIR" -maxdepth 1 -type f -name '*.AppImage.sig' -delete
(
  cd "$RHO_REPOSITORY_ROOT/desktop/src-tauri"
  npx -y "@tauri-apps/cli@$RHO_TAURI_CLI_VERSION" signer sign "$RHO_APPIMAGE"
)
if [[ ! -s "$RHO_APPIMAGE.sig" ]]; then
  echo "Final Linux updater signature is missing." >&2
  exit 1
fi

# The produced AppImage must be executable and its AppRun must contain the
# WebKitGTK 4.1 dependency check (also enforced in the hosted lane).
RHO_VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rho-appimage-verify.XXXXXX")"
trap 'rm -rf -- "$RHO_VERIFY_DIR"' EXIT
if [[ ! -x "$RHO_APPIMAGE" ]]; then
  echo "Produced AppImage is not executable: $RHO_APPIMAGE" >&2
  exit 1
fi
(
  cd "$RHO_VERIFY_DIR"
  "$RHO_APPIMAGE" --appimage-extract >/dev/null
)
if ! grep -q 'libwebkit2gtk-4\.1\.so\.0' "$RHO_VERIFY_DIR/squashfs-root/AppRun"; then
  echo "Produced AppImage AppRun does not contain the WebKitGTK 4.1 dependency check." >&2
  exit 1
fi
rm -rf -- "$RHO_VERIFY_DIR"
trap - EXIT

RHO_APPIMAGE_SIZE="$(stat -c '%s' "$RHO_APPIMAGE")"
RHO_APPIMAGE_SHA256="$(sha256sum "$RHO_APPIMAGE" | awk '{print $1}')"
printf '%s  %s\n' "$RHO_APPIMAGE_SHA256" "$RHO_EXPECTED_NAME" > "$RHO_APPIMAGE.sha256"

echo "Rho AppImage: $RHO_APPIMAGE"
echo "Rho AppImage size (bytes): $RHO_APPIMAGE_SIZE"
echo "Rho AppImage SHA-256: $RHO_APPIMAGE_SHA256"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "appimage_path=$RHO_APPIMAGE" >> "$GITHUB_OUTPUT"
  echo "appimage_name=$RHO_EXPECTED_NAME" >> "$GITHUB_OUTPUT"
  echo "product_name=$RHO_PRODUCT_NAME" >> "$GITHUB_OUTPUT"
  echo "app_version=$RHO_VERSION" >> "$GITHUB_OUTPUT"
  echo "appimage_sha256=$RHO_APPIMAGE_SHA256" >> "$GITHUB_OUTPUT"
  echo "appimage_signature=$RHO_APPIMAGE.sig" >> "$GITHUB_OUTPUT"
fi
