#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_CONFIG="$ROOT_DIR/src-tauri/tauri.conf.json"

if ! command -v create-dmg >/dev/null 2>&1; then
  echo "create-dmg is required for macOS packaging. Install it with: brew install create-dmg" >&2
  exit 1
fi

APP_NAME="$(node -p "JSON.parse(require('fs').readFileSync('$TAURI_CONFIG', 'utf8')).productName")"
APP_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$TAURI_CONFIG', 'utf8')).version")"
RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  arm64|aarch64) APP_ARCH="arm64" ;;
  x86_64|amd64) APP_ARCH="x64" ;;
  *) APP_ARCH="$RAW_ARCH" ;;
esac
APP_BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/macos"
APP_PATH="$APP_BUNDLE_DIR/$APP_NAME.app"
DMG_NAME="${APP_NAME// /-}-Installer_${APP_VERSION}_${APP_ARCH}.dmg"
DMG_PATH="$ROOT_DIR/$DMG_NAME"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/android-toolkit-dmg.XXXXXX")"

cleanup() {
  rm -rf "$STAGING_DIR"
}

trap cleanup EXIT

echo "Starting ad-hoc macOS build for $APP_NAME..."

echo "Building the Tauri app bundle..."
npm run tauri build -- --bundles app

if [ ! -d "$APP_PATH" ]; then
  echo "Expected app bundle was not found at $APP_PATH" >&2
  exit 1
fi

echo "Ad-hoc signing the app bundle..."
codesign --force --deep --options runtime -s - "$APP_PATH"

echo "Verifying the app signature..."
codesign --verify --verbose "$APP_PATH"

echo "Creating the DMG..."
rm -f "$DMG_PATH"
cp -R "$APP_PATH" "$STAGING_DIR/"

create-dmg \
  --volname "$APP_NAME Installer" \
  --window-pos 200 120 \
  --window-size 600 300 \
  --icon-size 100 \
  --icon "$APP_NAME.app" 175 120 \
  --hide-extension "$APP_NAME.app" \
  --app-drop-link 425 120 \
  "$DMG_PATH" \
  "$STAGING_DIR"

echo "Ad-hoc signing the DMG..."
codesign --force -s - "$DMG_PATH"

echo "Verifying the DMG signature..."
codesign --verify --verbose "$DMG_PATH"

echo "Done. Output: $DMG_PATH"
