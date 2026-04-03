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
- [ ] In-app onboarding wizard for first-time users: step-by-step guide for enabling Developer Options and Wireless Debugging, not just a link to external docs.

## Maintenance

- [ ] Finish Device Companion live-stream transition: replace the current desktop preview path with a stable long-running video stream pipeline, harden reconnect handling, and verify popout reliability across supported desktop platforms.

## Navigation & Layout

- [ ] Reorganize the desktop sidebar sections for a cleaner information architecture.
- [ ] Add icons next to each parent menu label: Devices, Apps, Media, Power Tools, and Pro Tools.
- [ ] Keep Help & Docs and About outside a collapsible parent section so they are always visible.

## Updates & Release

- [ ] Wire up update checker to GitHub releases API: replace stub in App.jsx with fetch('https://api.github.com/repos/TeamNocturnal/AndroidToolkit/releases/latest'), read .tag_name, compare against CURRENT_VERSION, show banner if newer. Placeholder UI already in place.
- [ ] Persistent saved devices: move saved devices storage from localStorage to a JSON file on disk so devices survive app reinstalls and can be shared between machines. Desktop only.

## Android (Paused)

Android app development is paused. Existing Android build remains functional. Items below are tracked for when Android work resumes:

- [ ] Fix window insets: status bar overlap at top, nav bar hiding bottom tab bar
- [ ] Fix bottom tab bar cutting off page content
- [ ] Android navigation redesign: portrait = bottom bar with hamburger + section name, landscape = side rail, drawer for all nav
- [ ] Local split APK / XAPK install on Android
- [ ] Local fastboot support on Android
- [ ] Android Device Tweaks: WRITE_SETTINGS + one-time WRITE_SECURE_SETTINGS ADB grant for DPI, animation speed, DNS, font size, screen timeout
- [ ] WiFi ADB for Android-to-Android device management
