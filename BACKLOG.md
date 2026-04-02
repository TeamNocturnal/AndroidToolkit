# Android Toolkit Backlog

This document tracks focused follow-up work that should live outside the main README.

## Linux Support

- [x] Add Linux `udev` setup docs so USB `adb` / `fastboot` access works without `sudo` where possible.
- Validate Linux runtime behavior on `Debian`, `Fedora`, `Arch Linux`, and `openSUSE`.
- Decide which Linux bundle targets are first-class release artifacts: `AppImage`, `.deb`, `.rpm`, or a smaller initial set.
- Decide whether Arch Linux should ship through `AppImage` only first or get a dedicated `AUR` / `PKGBUILD` flow.
- Verify bundled Linux `adb` and `fastboot` compatibility on the supported distros.
- Polish Linux-specific desktop UX gaps such as folder reveal behavior and any path or shell edge cases.
- Add Linux build and packaging coverage to CI / release automation once the distro support is validated.
