#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
ADB_BIN="$TAURI_DIR/binaries/adb-x86_64-unknown-linux-gnu"
FASTBOOT_BIN="$TAURI_DIR/binaries/fastboot-x86_64-unknown-linux-gnu"

pass() {
  printf '[PASS] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1"
  exit 1
}

printf 'Android Toolkit Linux smoke check\n'
printf 'Repo: %s\n\n' "$ROOT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This smoke check is intended to run on Linux."
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  warn "Current host architecture is $ARCH. Bundled Linux sidecars in this repo currently target x86_64."
else
  pass "Host architecture is x86_64."
fi

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  printf 'Detected distro: %s\n' "${PRETTY_NAME:-${NAME:-Unknown Linux}}"
else
  warn "/etc/os-release not found. Distro-specific reporting is unavailable."
fi

[[ -x "$ADB_BIN" ]] || fail "Bundled adb sidecar is missing or not executable: $ADB_BIN"
[[ -x "$FASTBOOT_BIN" ]] || fail "Bundled fastboot sidecar is missing or not executable: $FASTBOOT_BIN"
pass "Bundled Linux adb and fastboot sidecars are present."

if command -v xdg-open >/dev/null 2>&1; then
  pass "xdg-open is available."
else
  warn "xdg-open is missing. Reveal-in-folder behavior will not work."
fi

if command -v file >/dev/null 2>&1; then
  file "$ADB_BIN" "$FASTBOOT_BIN"
else
  warn "'file' is not installed, skipping binary type check."
fi

printf '\nChecking bundled platform-tools...\n'
"$ADB_BIN" version >/dev/null && pass "Bundled adb runs." || fail "Bundled adb failed to execute."
"$FASTBOOT_BIN" --version >/dev/null && pass "Bundled fastboot runs." || fail "Bundled fastboot failed to execute."

if command -v ldd >/dev/null 2>&1; then
  printf '\nShared library check:\n'
  ldd "$ADB_BIN" || warn "ldd reported an issue for bundled adb."
  ldd "$FASTBOOT_BIN" || warn "ldd reported an issue for bundled fastboot."
else
  warn "ldd is not available, skipping shared library checks."
fi

printf '\nBuild artifact hints:\n'
if [[ -d "$TAURI_DIR/target/release/bundle/appimage" ]]; then
  pass "AppImage bundle directory exists."
else
  warn "AppImage bundle directory not found yet."
fi

if [[ -d "$TAURI_DIR/target/release/bundle/deb" ]]; then
  pass "deb bundle directory exists."
else
  warn "deb bundle directory not found yet."
fi

if [[ -d "$TAURI_DIR/target/release/bundle/rpm" ]]; then
  pass "rpm bundle directory exists."
else
  warn "rpm bundle directory not found yet."
fi

printf '\nSmoke check complete.\n'
printf 'Next manual checks:\n'
printf '1. Launch the app with `npm run tauri dev` or a release bundle.\n'
printf '2. Confirm the Devices screen appears and the Linux USB helper card shows when no USB device is detected.\n'
printf '3. Confirm a USB phone appears in `adb devices` after udev rules are installed.\n'
printf '4. Confirm a bootloader-mode device appears in `fastboot devices`.\n'
