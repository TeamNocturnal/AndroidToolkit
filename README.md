# Nocturnal Toolkit

Nocturnal Toolkit is a Tauri-based desktop and Android app for managing Android devices, apps, and power-user workflows from a cleaner UI.

## Android Backlog

The items below are still pending for the Android app. Completed items have been intentionally removed from this list.

- Android window insets: fix the status bar overlapping the top of the app and the navigation bar covering bottom controls by handling Android window insets properly.

## Desktop Backlog

- Saved devices: move saved ADB devices to a persistent file instead of localStorage, support save-on-pair/save-on-connect, and allow remove/delete from the Connected Devices view.
- macOS installer: add a custom drag-to-Applications installer UI styled more like LuLu / Objective-See.

## Quest Tools Backlog

- Add Lightning Launcher support in Quest Tools.

## TV & Streaming Backlog

The items below are the TV & Streaming additions still not covered yet.

### Streaming Clients

- RealStream
- Stream Cinema
- iMPlayer
- TiviMate
- VidHub

### YouTube / Video Replacements

- Verify whether any additional YouTube-style replacements still need to be added beyond SmartTube and TizenTube Cobalt.

### Sports / Music / Premium Services

- SportzX
- TIDAL
- Fandango at Home
- Apple TV

### Screenshot Verification

- Verify the exact app name for the yellow grid-style logo tile shown beside Stream Cinema in the screenshot.
- Verify the exact app name for the purple `T` logo tile shown beside VidHub in the screenshot.
- Verify the exact app name for the gray diamond / `TV...` logo tile shown at the far right of the screenshot.

## Notes

- Android currently focuses on the device the APK is running on.
- Desktop behavior should remain unaffected by Android-only UI changes.
