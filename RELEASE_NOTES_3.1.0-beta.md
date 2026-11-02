## Android Toolkit v3.1.0

I rolled this build with the latest fixes and improvements from the current branch.

### Build Info

- Channel: beta
- Version: `3.1.0`
- Branch: `beta`

### What I Changed Since The Previous Build

- Enabled all six app search providers by default: F-Droid, GitHub, Aptoide, APKPure, APKMirror, and Uptodown.
- Closed sidebar groups, connection setup, and expandable tool sections by default while keeping direct tool cards visible.
- Cleaned up Getting Started, device connections, navigation, and duplicate shortcuts so setup follows a clearer order.
- Fixed light and dark theme contrast, native dropdown colors, Classic styling conflicts, output panels, and palette-switching flashes.
- Reworked app search and downloads to resolve current package metadata, show APK variants, and retain direct downloads wherever available.
- Added guided website downloads with Browse and file-drop import when a provider blocks direct access or requires a browser check.
- Added app update shortcuts, persistent install queues between pages, retryable errors, sequential batch recovery, and validated APK/bundle handling.
- Added multi-device TV scans and a reversible one-click optimizer with optional bundled-app cleanup and supported cache-only cleanup.
- Organized universal TV and streaming tools, including device health, network checks, remote controls, display tools, screenshots, and audio-delay troubleshooting.
- Added DNS presets for standard, security, ad-blocking, and family filtering, with saved settings and restore support.
- Added device-aware update controls that detect supported settings and updater apps, back up changes, verify results, and support undo.
- Fixed screenshot capture and Windows development file-watcher failures.
- Updated release metadata and beta build names to `3.1.0`, with timestamped builds and release notes matching the nightly layout.
- Verified download, install, update, uninstall, website import, archive import, and batch error recovery on an ONN device. Removed the temporary test app and confirmed the original app list remained unchanged.

### Install Notes

- macOS: open the `.dmg` and drag `Android Toolkit.app` into `Applications`.
- Windows: use the `.exe` installer or `.msi` package.
- Linux: install the native package for your distro when available. Debian-based systems can install the `.deb` with `sudo apt install ./Android-Toolkit_<version>_amd64.deb`.

### Downloads

- Latest release: https://github.com/TeamNocturnal/AndroidToolkit/releases/latest
- All releases: https://github.com/TeamNocturnal/AndroidToolkit/releases
