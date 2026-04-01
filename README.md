# TN Toolkit

Desktop and Android device toolkit by Team Nocturnal for sideloading, ADB workflows, app management, TV tools, Quest tools, maintenance, backups, and power-user Android workflows from a cleaner UI.

[Official Site](https://toolkit.team-nocturnal.com) · [Forum Thread](https://forums.wbodytech.com/%E2%9A%A1-nocturnal-toolkit-by-team-nocturnal.t239/) · `macOS` · `Windows` · `Android`

## What TN Toolkit Is Now

TN Toolkit has moved far beyond the original "APK installer + ADB helper" idea.

The current project is a cross-platform toolkit built with `Tauri 2 + Rust + React` that gives you:

- a desktop control center for Android devices over `ADB` and `Fastboot`
- a mobile-first Android build with its own on-device tool flow
- app installs, package management, backups, file browsing, shell access, and maintenance tools
- dedicated flows for Android TV / Fire TV / Google TV / Quest / ROM flashing
- a much cleaner GUI for jobs that normally require a pile of shell commands

## Current Highlights

### Apps

- `Install APK` with queue support and split package handling
- `Search APKs` across supported sources
- `App Stores` for alternative Android app stores
- `Manage Apps` for listing, launching, clearing, uninstalling, and inspecting packages

### Devices

- USB and wireless ADB device detection
- pairing and connect flows for wireless debugging
- saved device tools, import/export, and history
- live hardware info, battery, storage, and transport details

### Media

- TV & Streaming tools for Fire TV, Android TV, Google TV, Shield, ONN, and similar devices
- media app install flows for tools like Kodi, Stremio, SmartTube, Cloudstream, Syncler, NuvioTV, and more
- launcher tools, device setup guides, and TV-specific utilities

### Power Tools

- `File Browser` with local/device panes and direct transfers
- `Backup & Restore` for app backups and no-root data exports
- `Maintenance` for cleanup, review, diagnostics, and device-care workflows
- `Tweaks` for display/UI adjustments and Private DNS
- `Quest Tools` for sideloading and headset-focused workflows
- `ROM Tools` for flashing and recovery-related tasks

### Pro Tools

- `ADB & Shell`
- reboot modes
- quick commands
- package and permission controls
- deeper device actions for advanced users

### Android App

- mobile-first navigation and local-device toolkit flow
- local shell/logcat/device tools
- maintenance and tweaks flows adapted for Android
- local APK install through the system package installer
- Android-specific UX instead of forcing the desktop UI onto a phone

## Tech Stack

- `Tauri 2`
- `Rust`
- `React`
- `Vite`
- bundled `adb` and `fastboot` binaries

## Project Links

- Official site: [toolkit.team-nocturnal.com](https://toolkit.team-nocturnal.com)
- Forum thread: [forums.wbodytech.com](https://forums.wbodytech.com/%E2%9A%A1-nocturnal-toolkit-by-team-nocturnal.t239/)

## Local Development

### Frontend

```bash
npm install
npm run dev
```

### Desktop App

```bash
npm run tauri dev
```

### Production Build

```bash
npm run tauri build
```

## Backlog

This backlog is meant to track the next meaningful steps, not every idea that has ever come up.

### Desktop

- Add a proper custom macOS drag-to-Applications installer experience.
- Set up macOS signing + notarization for trusted DMG distribution.
- Upgrade the current device preview into a true low-latency live mirroring pipeline.

### Android

- Finish Android window inset handling so the status/nav bars never overlap content on every device.
- Continue improving Android cleanup and maintenance workflows with more guided review and result summaries.
- Keep refining Android tablet/landscape layouts where needed.

### Quest Tools

- Add Lightning Launcher support.

### Media / TV

- Add remaining media apps still on the backlog:
  - `RealStream`
  - `Stream Cinema`
  - `iMPlayer`
  - `TiviMate`
  - `VidHub`
  - `SportzX`
  - `TIDAL`
  - `Fandango at Home`
  - `Apple TV`
- Verify the remaining unidentified screenshot-based media tiles before adding them.
- Continue polishing Media section grouping and device-specific setup flows.

## Notes

- Desktop and Android intentionally do not behave the same in every area.
- Android-only changes should stay isolated from the desktop build.
- Generated build output is intentionally not kept in Git history unless needed.

## Team Nocturnal

Built by `XsMagical` / Team Nocturnal.
