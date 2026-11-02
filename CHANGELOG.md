# Changelog

## 3.1.0 nightly - 2026-11-02

- Merged the 3.1.0 beta improvements and updated changelog into nightly.
- Included versioned 3.1.0 release highlights in the first nightly for this version, with commit summaries for subsequent builds.
- Defaulted installed nightly builds to the nightly update channel while preserving saved channel choices.
- Pinned release metadata and package jobs to the same nightly commit.
- Kept one nightly release publisher in the current format; the legacy packaging workflow remains available as a manual package check.

## 3.1.0 beta - 2026-11-02

### Added

- Multi-device TV inspection and a reversible one-click optimizer with optional bundled-app and cache cleanup.
- Universal TV and streaming tools for health, network, remote controls, display, screenshots, and audio-delay troubleshooting.
- DNS provider presets with security, ad-blocking, and family-filtering choices, backup, verification, and restore.
- Device-aware update blocking and restoration for supported settings and updater apps.
- Guided website download/import for blocked app providers, direct APK downloads to Downloads, and app update shortcuts.
- App workflow and TV tool regression checks in CI.

### Changed

- Enabled all app search sources and closed expandable sections by default.
- Reordered setup and navigation, simplified device connections, and consolidated duplicate tools and shortcuts.
- Kept manual TV controls visible as regular tool cards.
- Preserved install queues between pages and continued batches after individual failures.
- Displayed real package versions and APK variants without inventing architecture support or verified-download labels.
- Matched beta release notes, timestamped tags, and artifact names to the nightly format.
- Resolved current app-store versions instead of using pinned Aurora and Aptoide APK links.

### Fixed

- Light/dark palette conflicts, Classic navigation styling, control contrast, and theme-switch flashes.
- F-Droid download URL generation, Uptodown search addresses, APKMirror variant parsing, and blocked download recovery.
- Install errors that could leave controls busy, Windows package filename handling, and duplicate queue imports.
- Screenshot binary output and Windows development watcher crashes.
- Beta packaging that still referenced the 3.0.0 release notes and Windows version override.
- Same-version beta build update detection using timestamped frontend build metadata.

### Validation

- Frontend lint and production build, Rust checks, and automated app/provider/TV tests.
- ONN download/install/update/uninstall cycle, checksum verification, website import, archive installation, and batch failure recovery.
- Temporary test app removed; original installed-app list verified unchanged.
- Provider browser checks remain respected. OBB game bundles and bundletool multi-device archives require their original store or a device-specific export.

## 2.0.0 - 2026-04-03

First stable `2.0.0` release of Android Toolkit by Team Nocturnal.

- Promoted the app from beta branding to stable `2.0.0` across the desktop UI, package metadata, and Tauri config.
- Added basic CI to run lint, frontend build, and Rust `cargo check` on pushes and pull requests.
- Replaced the in-app update banner stub with a live GitHub releases lookup.
- Cleaned the lint and release-validation path so generated build output and machine-conflict files do not pollute source checks.
- Fixed the Screen Mirror UI for stable by hiding the popout entry point while keeping the implementation for a future beta.
- Added release backlog tracking for the deferred Screen Mirror popout re-enable work.

## Unreleased

- Screen Mirror popout refinement and re-enable work remains tracked for the next beta cycle.
