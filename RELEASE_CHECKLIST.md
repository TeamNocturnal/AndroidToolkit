# Release Checklist — 3.1.0 beta and nightly

## Before Publishing

- [x] App, npm lockfile, Cargo, and Tauri versions use `3.1.0`.
- [x] All six app search sources are enabled by default.
- [x] Sidebar groups and expandable tool sections start closed.
- [x] Getting Started, device connections, app tools, TV tools, and themes have been updated.
- [x] Versioned beta/nightly notes and the changelog describe the current changes.
- [x] Beta notes follow the current nightly release layout.
- [x] Timestamped beta tags, frontend build versions, and artifact names identify each build.
- [x] The first 3.1.0 nightly includes the updated notes; later nightlies summarize new commits.
- [x] Nightly release jobs build the exact commit used in the release metadata.
- [x] Windows packaging uses the current numeric app version.
- [x] Frontend lint and production build pass.
- [x] Rust checks and automated app, provider, and TV tests pass.
- [x] ONN download, installation, update, uninstall, website import, archive import, and batch error recovery were verified.
- [x] The temporary test app was removed and the original app list was verified unchanged.

## Packaging

- [ ] GitHub Windows, macOS, and Linux build jobs complete successfully.
- [ ] Windows `.exe` and `.msi` artifacts are attached to the beta release.
- [ ] macOS and Linux artifacts are attached to the beta release.
- [ ] Packaged installers are checked on their target platforms.

## Publish

- [ ] Commit release changes locally.
- [ ] Push the commit to `beta`.
- [ ] Verify the generated beta prerelease notes and build metadata.
- [ ] Confirm GitHub checks and release artifact jobs complete.
