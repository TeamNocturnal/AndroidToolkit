# Linux Runtime Validation

This document is the test checklist for the Linux support work in Android Toolkit.

The goal is to validate runtime behavior on:

- `Debian`
- `Fedora`
- `Arch Linux`
- `openSUSE`

## What We Can Validate Automatically

Run the smoke check on a Linux machine from the project root:

```bash
bash scripts/linux-smoke-check.sh
```

What it checks:

- Linux host detection
- `x86_64` host compatibility with the currently bundled Linux sidecars
- presence of bundled `adb` and `fastboot`
- whether `xdg-open` is installed
- whether bundled `adb` and `fastboot` execute
- `ldd` output for the bundled sidecars
- whether AppImage, `.deb`, and `.rpm` bundle directories exist after a build

## Manual Validation Checklist

Run these checks on each supported distro.

### 1. Setup

- Install the distro prerequisites from [README.md](/Users/xs/Projects/AndroidToolkit/README.md).
- Install Linux USB permissions using [LINUX_USB.md](/Users/xs/Projects/AndroidToolkit/LINUX_USB.md).
- Run `npm install`.

### 2. Dev Launch

```bash
npm run tauri dev
```

Verify:

- the app launches without missing-library errors
- the main window renders correctly
- the sidebar and titlebar behave normally
- the Devices screen loads without crashing

### 3. Bundled ADB

With a phone booted normally and USB debugging enabled:

Verify:

- the device appears in the Devices panel
- the Linux USB helper card disappears once USB access works
- `adb devices` lists the device
- shell commands from the app succeed
- APK install from the app succeeds
- file push and pull succeed

### 4. Bundled Fastboot

With a supported device in bootloader / fastboot mode:

Verify:

- `fastboot devices` lists the device
- fastboot commands launched from the app return output normally

### 5. Linux UX Checks

Verify:

- reveal-in-folder opens the containing folder through `xdg-open`
- copy buttons work
- the Linux USB helper card shows distro-aware commands
- the wireless ADB shortcut path is still usable if USB is not configured

### 6. Release Build

```bash
npm run tauri build
```

Verify:

- expected Linux bundle directories are created
- the produced package launches on that distro
- bundled `adb` and `fastboot` still execute from the packaged app

## Validation Notes

Record the results per distro:

- distro name and version
- desktop environment
- package format tested
- whether USB `adb` worked
- whether USB `fastboot` worked
- whether the packaged app launched
- any missing-library or permission issues

## Current Status

This repository now includes the checklist and smoke-check tooling, but full runtime validation still requires testing on actual `Debian`, `Fedora`, `Arch Linux`, and `openSUSE` machines.
