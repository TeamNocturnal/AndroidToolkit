# Linux USB Setup

This guide covers the Linux USB permissions work needed for bundled `adb` and `fastboot` to talk to physical Android devices without running the app as `root`.

Bundled Android platform-tools inside Android Toolkit handle the `adb` / `fastboot` executables, but Linux still relies on `udev` rules to grant access to USB Android devices.

## What This Fixes

If Android Toolkit launches on Linux but:

- `adb devices` shows no USB device
- `fastboot devices` shows nothing in bootloader mode
- the device only appears when commands are run with `sudo`

then the missing piece is usually `udev` rules.

## Debian

Install the Android udev rules package:

```bash
sudo apt update
sudo apt install android-sdk-platform-tools-common
adb version
adb start-server
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Then unplug and reconnect the phone and try the app again.

## Fedora

Fedora ships `adb` and `fastboot` in the `android-tools` package, but USB access still depends on local `udev` rules for the device.

Recommended approach:

1. Install the current community-maintained Android udev rules file from the `android-udev-rules` project.
2. Copy `51-android.rules` into `/etc/udev/rules.d/`.
3. Reload rules and reconnect the device:

```bash
adb version
adb start-server
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Source project:

- [M0Rf30/android-udev-rules](https://github.com/M0Rf30/android-udev-rules)

## Arch Linux

Install the Android udev rules package:

```bash
sudo pacman -S --needed android-udev
adb version
adb start-server
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Then unplug and reconnect the phone and try the app again.

## openSUSE

Install the Android udev rules package if it is available for your openSUSE release:

```bash
sudo zypper install android-udev-rules
adb version
adb start-server
sudo udevadm control --reload-rules
sudo udevadm trigger
```

If your current release does not provide it directly, use the package page below to find the supported repository for your exact openSUSE version:

- [openSUSE android-udev-rules package](https://software.opensuse.org/package/android-udev-rules)

Then unplug and reconnect the phone and try the app again.

## Verify ADB

With the phone booted normally and USB debugging enabled:

```bash
adb devices
```

You should see a device serial listed instead of an empty result.

If you see `unauthorized`, unlock the phone and accept the USB debugging prompt, then run `adb devices` again.

## Verify Fastboot

With the phone booted into bootloader / fastboot mode:

```bash
fastboot devices
```

You should see the device serial listed there as well.

## Notes

- Some devices also require accepting the USB debugging authorization prompt on the phone after the rules are fixed.
- If `adb` still does not see the device, try a different USB cable and port before assuming the app is at fault.
- Wireless ADB does not need `udev` rules, but USB ADB and USB fastboot usually do.
