#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '[FAIL] Linux desktop builds must be created on Linux.\n' >&2
  exit 1
fi

export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"

printf 'Android Toolkit Linux build helper\n'
printf 'Repo: %s\n' "$ROOT_DIR"
printf 'APPIMAGE_EXTRACT_AND_RUN=%s\n\n' "$APPIMAGE_EXTRACT_AND_RUN"

cd "$ROOT_DIR"
npm run tauri build

printf '\nBuild complete.\n'
printf 'Launch the generated .AppImage or install the native package output.\n'
printf 'Do not launch the raw AppDir/AppRun helper directly; it is an internal staging artifact.\n'
