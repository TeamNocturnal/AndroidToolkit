# Android Toolkit Backlog

This document tracks focused follow-up work that should live outside the main README.

## Linux Support

- [x] Add Linux `udev` setup docs so USB `adb` / `fastboot` access works without `sudo` where possible.
- Validate Linux runtime behavior on `Debian`, `Fedora`, `Arch Linux`, and `openSUSE`. Validation checklist: [LINUX_RUNTIME_VALIDATION.md](/Users/xs/Projects/AndroidToolkit/LINUX_RUNTIME_VALIDATION.md)
- Decide which Linux bundle targets are first-class release artifacts: `AppImage`, `.deb`, `.rpm`, or a smaller initial set.
- Decide whether Arch Linux should ship through `AppImage` only first or get a dedicated `AUR` / `PKGBUILD` flow.
- Verify bundled Linux `adb` and `fastboot` compatibility on the supported distros.
- Polish Linux-specific desktop UX gaps such as folder reveal behavior and any path or shell edge cases.
- Add Linux build and packaging coverage to CI / release automation once the distro support is validated.

## Help & Docs

- After the Help & Docs platform design is finalized, add OS gating so each platform setup card only shows on the OS the app is currently running on. Leave all platform cards visible during the current design pass.

## Maintenance

- Fix live preview in Device Companion so the in-app stream renders correctly instead of showing the broken-image placeholder, and replace the blocked browser popup path with a real Tauri popout window. Current app output: `Unable to open live-view popout window.`
