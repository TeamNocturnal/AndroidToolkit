#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/appimage"
BIN_PATH="$ROOT_DIR/src-tauri/target/release/app"
ICON_SOURCE="$ROOT_DIR/src-tauri/icons/128x128.png"
APP_NAME="Android Toolkit"
APP_ID="android-toolkit"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
DESKTOP_FILE="$DESKTOP_DIR/$APP_ID.desktop"
ICON_TARGET="$ICON_DIR/$APP_ID.png"

find_latest_appimage() {
  find "$APPIMAGE_DIR" -maxdepth 1 -type f -name '*.AppImage' -print 2>/dev/null | sort | tail -n 1
}

resolve_exec_target() {
  if [[ $# -gt 0 && -n "${1:-}" ]]; then
    printf '%s\n' "$1"
    return 0
  fi

  local latest_appimage=""
  latest_appimage="$(find_latest_appimage || true)"
  if [[ -n "$latest_appimage" ]]; then
    printf '%s\n' "$latest_appimage"
    return 0
  fi

  if [[ -x "$BIN_PATH" ]]; then
    printf '%s\n' "$BIN_PATH"
    return 0
  fi

  return 1
}

TARGET_PATH="$(resolve_exec_target "${1:-}")" || {
  printf '[FAIL] No AppImage or release binary was found.\n' >&2
  printf 'Build first with `npm run build:linux` or pass an explicit executable path.\n' >&2
  exit 1
}

mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
cp "$ICON_SOURCE" "$ICON_TARGET"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
Comment=Android device manager and ADB toolkit
Exec=$TARGET_PATH
Icon=$APP_ID
Terminal=false
Categories=Utility;Development;
StartupNotify=true
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

printf 'Desktop launcher installed.\n'
printf 'Launcher: %s\n' "$DESKTOP_FILE"
printf 'Exec: %s\n' "$TARGET_PATH"
printf 'Icon: %s\n' "$ICON_TARGET"
