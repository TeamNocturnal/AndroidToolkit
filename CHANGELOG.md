# Changelog

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
