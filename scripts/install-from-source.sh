#!/usr/bin/env bash
set -euo pipefail

# Source install script for Linux systems without an official Rho installer
# (Windows NSIS, macOS DMG, Linux AppImage/deb).
#
# Authority: docs/plans/active-2026-08-20-source-install-diagnostic-script-spec.md
# (S1). The script NEVER installs packages and never escalates privileges:
# it reports every missing toolchain/system requirement together with the
# distro-specific package that provides it, builds the rho-desktop binary
# from source, and installs it under a configurable prefix (default
# /usr/local). Platform support follows the Ark R sidecar manifest
# (runtime/ark.json): Linux is supported on exactly x86_64 and arm64 (both
# wired through bootstrap-ark-linux.sh); any other unix-like system — BSD
# included — is rejected explicitly. Unsupported/unknown Linux distributions
# fall back to a generic report plus an invitation to contribute a package
# map via PR.
#
# Exit codes (stable contract, see the spec):
#   0 installed (or built with --build-only)
#   1 usage error or unsupported uname -s
#   2 missing dependencies (report printed; nothing built)
#   3 build failed
#   4 install failed (prefix not writable)

RHO_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RHO_REPOSITORY_ROOT="$(cd "$RHO_SCRIPT_ROOT/.." && pwd)"

# --- defaults -----------------------------------------------------------------
RHO_PREFIX="${RHO_PREFIX:-/usr/local}"
RHO_JSON=0
RHO_SKIP_ARK=0
RHO_SKIP_DEPS=0
RHO_BUILD_ONLY=0
# Test override: point at a fake /etc/os-release (see test-install-from-source.sh).
RHO_OS_RELEASE="${RHO_OS_RELEASE:-/etc/os-release}"

usage() {
  printf '%s\n' \
    'Usage: scripts/install-from-source.sh [options]' \
    '' \
    'Builds rho-desktop from source and installs it under a prefix. Reports' \
    'missing toolchain/system dependencies with distro-specific install hints;' \
    'never installs packages and never escalates privileges.' \
    '' \
    'Options:' \
    '  --prefix DIR     install prefix (default: /usr/local)' \
    '  --json           print diagnostics as one JSON object on stdout' \
    '  --skip-ark       do not bootstrap the Ark R sidecar (R sessions will not work)' \
    '  --skip-deps      skip the dependency report and try to build directly' \
    '  --build-only     build but do not install' \
    '  --help           show this help' \
    '' \
    'Exit codes: 0 ok; 1 usage/unsupported system; 2 missing dependencies;' \
    '3 build failed; 4 install failed (prefix not writable).'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 ]] || { echo "error: --prefix requires a directory" >&2; exit 1; }
      RHO_PREFIX="$2"
      shift 2
      ;;
    --json) RHO_JSON=1; shift ;;
    --skip-ark) RHO_SKIP_ARK=1; shift ;;
    --skip-deps) RHO_SKIP_DEPS=1; shift ;;
    --build-only) RHO_BUILD_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# --- platform detection --------------------------------------------------------
# Test override hooks (same style as RHO_OS_RELEASE): uname cannot be faked on
# the fixture host, so the fixture injects these to cover the BSD-rejection
# and linux-arm64 branches.
RHO_UNAME_S="${RHO_UNAME_S:-$(uname -s 2>/dev/null || echo unknown)}"
RHO_OS="$(printf '%s' "$RHO_UNAME_S" | tr '[:upper:]' '[:lower:]')"
RHO_ARCH="${RHO_UNAME_M:-$(uname -m 2>/dev/null || echo unknown)}"

RHO_DISTRO=""
if [[ "$RHO_OS" == "linux" && -f "$RHO_OS_RELEASE" ]]; then
  RHO_DISTRO="$(sed -n 's/^ID=//p' "$RHO_OS_RELEASE" | head -n 1 | tr -d '"')"
fi

# Platform support follows the Ark R sidecar manifest (runtime/ark.json), which
# declares windows-x64, macos-arm64, linux-x64 and linux-arm64. BSD has no Ark
# build, so source install is offered on Linux only; macOS uses the official
# DMG installer.
case "$RHO_OS" in
  linux) : ;;
  darwin)
    echo "error: macOS users should use the official DMG installer; source install on macOS is not supported by this script yet." >&2
    exit 1
    ;;
  *)
    echo "error: unsupported system: $RHO_UNAME_S. Rho's platform support follows the Ark R sidecar (runtime/ark.json): linux-x64, linux-arm64, macos-arm64, windows-x64. BSD has no Ark build, so source install is offered on Linux only." >&2
    exit 1
    ;;
esac

# Linux is supported on exactly the two architectures covered by the Ark
# manifest: x86_64 and aarch64/arm64. Any other Linux architecture is
# rejected explicitly, matching the product decision that Linux means these
# two platforms only (BSD and other unix-like systems are rejected above).
case "$RHO_ARCH" in
  x86_64|aarch64|arm64) : ;;
  *)
    echo "error: unsupported Linux architecture: $RHO_ARCH. Source install supports linux x86_64 and arm64 only (matching runtime/ark.json)." >&2
    exit 1
    ;;
esac

# --- distro package maps -------------------------------------------------------
# Best-effort, community-extensible. Add a case for a new os-release ID and
# adjust the RHO_PKG_* variables; keep this block the single source of truth
# for the suggestions printed by the diagnostics.
RHO_PM_INSTALL=""
RHO_PKG_CARGO=""
RHO_PKG_NODE=""
RHO_PKG_CURL=""
RHO_PKG_UNZIP=""
RHO_PKG_FILE=""
RHO_PKG_PKGCONFIG=""
RHO_PKG_RScript=""
RHO_PKG_WEBKIT=""
RHO_PKG_GTK3=""

case "$RHO_DISTRO" in
  debian|ubuntu|linuxmint|pop|elementary|zorin|raspbian)
    RHO_PM_INSTALL="apt-get install -y"
    RHO_PKG_CARGO="cargo"
    RHO_PKG_NODE="nodejs"
    RHO_PKG_CURL="curl"
    RHO_PKG_UNZIP="unzip"
    RHO_PKG_FILE="file"
    RHO_PKG_PKGCONFIG="pkg-config"
    RHO_PKG_RScript="r-base"
    RHO_PKG_WEBKIT="libwebkit2gtk-4.1-dev"
    RHO_PKG_GTK3="libgtk-3-dev"
    ;;
  fedora|rhel|rocky|almalinux|centos|ol)
    RHO_PM_INSTALL="dnf install -y"
    RHO_PKG_CARGO="cargo"
    RHO_PKG_NODE="nodejs"
    RHO_PKG_CURL="curl"
    RHO_PKG_UNZIP="unzip"
    RHO_PKG_FILE="file"
    RHO_PKG_PKGCONFIG="pkgconf-pkg-config"
    RHO_PKG_RScript="R"
    RHO_PKG_WEBKIT="webkit2gtk4.1-devel"
    RHO_PKG_GTK3="gtk3-devel"
    ;;
  arch|manjaro|endeavouros)
    RHO_PM_INSTALL="pacman -S --needed"
    RHO_PKG_CARGO="cargo"
    RHO_PKG_NODE="nodejs"
    RHO_PKG_CURL="curl"
    RHO_PKG_UNZIP="unzip"
    RHO_PKG_FILE="file"
    RHO_PKG_PKGCONFIG="pkg-config"
    RHO_PKG_RScript="r"
    RHO_PKG_WEBKIT="webkit2gtk-4.1"
    RHO_PKG_GTK3="gtk3"
    ;;
  opensuse|sles|opensuse-leap|opensuse-tumbleweed)
    RHO_PM_INSTALL="zypper install -y"
    RHO_PKG_CARGO="cargo"
    RHO_PKG_NODE="nodejs"
    RHO_PKG_CURL="curl"
    RHO_PKG_UNZIP="unzip"
    RHO_PKG_FILE="file"
    RHO_PKG_PKGCONFIG="pkgconf-pkg-config"
    RHO_PKG_RScript="R-base"
    RHO_PKG_WEBKIT="webkit2gtk4-devel"
    RHO_PKG_GTK3="gtk3-devel"
    ;;
  alpine)
    RHO_PM_INSTALL="apk add"
    RHO_PKG_CARGO="cargo"
    RHO_PKG_NODE="nodejs"
    RHO_PKG_CURL="curl"
    RHO_PKG_UNZIP="unzip"
    RHO_PKG_FILE="file"
    RHO_PKG_PKGCONFIG="pkgconf"
    RHO_PKG_RScript="R"
    RHO_PKG_WEBKIT="webkit2gtk-4.1-dev"
    RHO_PKG_GTK3="gtk3-dev"
    ;;
  *)
    # Unknown distro: keep empty maps so the report falls back to the generic
    # "no package-name map yet" invitation.
    ;;
esac

# --- diagnostics ---------------------------------------------------------------
declare -A RHO_MISSING_KIND=()
declare -A RHO_MISSING_PURPOSE=()
declare -A RHO_MISSING_SUGGEST=()
RHO_MISSING=()
RHO_WARNINGS=()

require_command() {
  local name="$1"
  local purpose="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    local suggest=""
    case "$name" in
      cargo)
        suggest="install rustup (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)"
        if [[ -n "$RHO_PKG_CARGO" ]]; then
          suggest="$suggest, or the distro package: $RHO_PM_INSTALL $RHO_PKG_CARGO"
        fi
        ;;
      node)
        suggest="install Node.js (nvm/volta or your distro package)"
        if [[ -n "$RHO_PKG_NODE" ]]; then
          suggest="$suggest: $RHO_PM_INSTALL $RHO_PKG_NODE"
        fi
        ;;
      Rscript)
        if [[ -n "$RHO_PKG_RScript" ]]; then
          suggest="$RHO_PM_INSTALL $RHO_PKG_RScript"
        fi
        ;;
      *)
        local var_name="RHO_PKG_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
        if [[ -n "${!var_name:-}" ]]; then
          suggest="$RHO_PM_INSTALL ${!var_name}"
        fi
        ;;
    esac
    RHO_MISSING+=("$name")
    RHO_MISSING_KIND["$name"]="command"
    RHO_MISSING_PURPOSE["$name"]="$purpose"
    RHO_MISSING_SUGGEST["$name"]="$suggest"
  fi
}

require_pkgconfig() {
  local module="$1"
  local purpose="$2"
  local pkg_name=""
  case "$module" in
    webkit2gtk-4.1) pkg_name="$RHO_PKG_WEBKIT" ;;
    gtk+-3.0) pkg_name="$RHO_PKG_GTK3" ;;
  esac
  if ! pkg-config --exists "$module" 2>/dev/null; then
    RHO_MISSING+=("$module")
    RHO_MISSING_KIND["$module"]="library"
    RHO_MISSING_PURPOSE["$module"]="$purpose"
    if [[ -n "$pkg_name" && -n "$RHO_PM_INSTALL" ]]; then
      RHO_MISSING_SUGGEST["$module"]="$RHO_PM_INSTALL $pkg_name"
    else
      RHO_MISSING_SUGGEST["$module"]=""
    fi
  fi
}

if [[ "$RHO_SKIP_DEPS" -eq 0 ]]; then
  if [[ "$RHO_OS" == "linux" && -z "$RHO_DISTRO" ]]; then
    RHO_WARNINGS+=("could not read an ID from $RHO_OS_RELEASE; package suggestions will be generic")
  fi

  require_command cargo "building the rho-desktop binary"
  require_command node "reading the Ark runtime manifest and writing the Linux kernelspec"
  require_command curl "downloading the pinned Ark sidecar archive"
  require_command unzip "extracting the pinned Ark sidecar archive"
  require_command file "verifying the staged Ark sidecar ELF architecture"
  require_command Rscript "resolving R_HOME/R libs for the Ark kernelspec (R sessions need R)"
  require_command pkg-config "detecting the WebKitGTK/GTK build libraries"
  require_pkgconfig webkit2gtk-4.1 "Tauri WebKitGTK 4.1 headers and runtime library"
  require_pkgconfig gtk+-3.0 "Tauri GTK 3 headers and runtime library"

  # Both Linux manifest entries (linux-x64, linux-arm64) are fully wired
  # through bootstrap-ark-linux.sh; the architecture check above guarantees
  # this platform has a usable Ark sidecar.
fi

# --- report ---------------------------------------------------------------------
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

print_report() {
  if [[ "$RHO_JSON" -eq 1 ]]; then
    printf '{"os":%s,"distro":%s,"arch":%s,"ok":%s,' \
      "\"$(json_escape "$RHO_OS")\"" \
      "\"$(json_escape "$RHO_DISTRO")\"" \
      "\"$(json_escape "$RHO_ARCH")\"" \
      "$([[ ${#RHO_MISSING[@]} -eq 0 ]] && echo true || echo false)"
    printf '"missing":['
    local first=1
    local name
    for name in "${RHO_MISSING[@]}"; do
      [[ "$first" -eq 1 ]] || printf ','
      first=0
      printf '{"kind":%s,"name":%s,"purpose":%s,"suggest":%s}' \
        "\"$(json_escape "${RHO_MISSING_KIND[$name]}")\"" \
        "\"$(json_escape "$name")\"" \
        "\"$(json_escape "${RHO_MISSING_PURPOSE[$name]}")\"" \
        "\"$(json_escape "${RHO_MISSING_SUGGEST[$name]}")\""
    done
    printf '],"warnings":['
    first=1
    local warning
    for warning in "${RHO_WARNINGS[@]}"; do
      [[ "$first" -eq 1 ]] || printf ','
      first=0
      printf '"%s"' "$(json_escape "$warning")"
    done
    printf ']}\n'
  else
    local warning
    for warning in "${RHO_WARNINGS[@]}"; do
      printf 'WARNING: %s\n' "$warning"
    done
    local name
    for name in "${RHO_MISSING[@]}"; do
      printf 'MISSING %s: %s\n' "$(printf '%s' "${RHO_MISSING_KIND[$name]}" | tr '[:lower:]' '[:upper:]')" "$name"
      printf '  required for: %s\n' "${RHO_MISSING_PURPOSE[$name]}"
      if [[ -n "${RHO_MISSING_SUGGEST[$name]}" ]]; then
        printf '  suggest: %s\n' "${RHO_MISSING_SUGGEST[$name]}"
      else
        printf '  suggest: no package-name map for %s yet; install the equivalent of %s with your system package manager, or open a PR to scripts/install-from-source.sh to add a map for %s\n' \
          "${RHO_DISTRO:-this system}" "$name" "${RHO_DISTRO:-this system}"
      fi
    done
    if [[ ${#RHO_MISSING[@]} -gt 0 ]]; then
      printf '%d missing requirement(s); resolve them and re-run. Re-run with --json for machine-readable diagnostics.\n' "${#RHO_MISSING[@]}"
    else
      printf 'All toolchain and system requirements are satisfied.\n'
    fi
  fi
}

if [[ "$RHO_SKIP_DEPS" -eq 0 ]]; then
  print_report
  if [[ ${#RHO_MISSING[@]} -gt 0 ]]; then
    exit 2
  fi
fi

# --- build ---------------------------------------------------------------------
if [[ "$RHO_SKIP_ARK" -eq 0 ]]; then
  "$RHO_SCRIPT_ROOT/bootstrap-ark-linux.sh"
  "$RHO_SCRIPT_ROOT/prepare-runtime-resources.sh"
else
  printf 'Skipping Ark sidecar bootstrap; R sessions will not be available.\n'
fi

(
  cd "$RHO_REPOSITORY_ROOT"
  cargo build --release -p rho-desktop
) || {
  echo "build failed (exit code 3)" >&2
  exit 3
}

RHO_BINARY="$RHO_REPOSITORY_ROOT/target/release/rho-desktop"
if [[ ! -x "$RHO_BINARY" ]]; then
  echo "build did not produce $RHO_BINARY" >&2
  exit 3
fi

if [[ "$RHO_BUILD_ONLY" -eq 1 ]]; then
  printf 'Built: %s\n' "$RHO_BINARY"
  exit 0
fi

# --- install -------------------------------------------------------------------
RHO_BIN_DIR="$RHO_PREFIX/bin"
if ! mkdir -p "$RHO_BIN_DIR" 2>/dev/null || [[ ! -w "$RHO_BIN_DIR" ]]; then
  echo "error: $RHO_BIN_DIR is not writable." >&2
  RHO_RETRY_ARGS=""
  if [[ $# -gt 0 ]]; then RHO_RETRY_ARGS=" $*"; fi
  echo "Re-run with sudo ($0$RHO_RETRY_ARGS) or pass --prefix pointing at a writable location (e.g. --prefix \$HOME/.local)." >&2
  exit 4
fi
install -m 755 "$RHO_BINARY" "$RHO_BIN_DIR/rho-desktop"

RHO_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$RHO_REPOSITORY_ROOT/Cargo.toml" | head -n 1)"
printf 'Installed: %s/bin/rho-desktop\n' "$RHO_PREFIX"
printf 'Version: %s\n' "${RHO_VERSION:-unknown}"
printf 'Installed-from-source binaries are not covered by the official auto-update channel.\n'
