# Android Toolkit 3.0.0-beta

Initial beta release for the Android Toolkit desktop redesign branch.

## Highlights

- New premium desktop shell with a Tahoe-inspired utility-window layout
- Refined titlebar, sidebar, grouped panels, and calmer desktop chrome
- Beta branding and `3.0.0-beta` versioning across the frontend and Tauri metadata
- Full in-app update channel support for `stable`, `beta`, and `nightly`
- Improved selected-sidebar states and sidebar interaction polish for both dark and light themes
- Added a dedicated macOS beta packaging script with `build:mac:beta`

## Notes

- This beta is focused on desktop UI and shell polish; core device logic and workflows remain in place
- The app is intentionally cross-platform, so the design borrows from Tahoe materials without fake native traffic-light controls
- macOS packages remain ad-hoc signed and are not notarized yet

## Validation

- `npm run lint`
- `npm run build`
- `npm run build:mac:beta`

## Known Follow-Up

- Continue tightening inner panel styling so the tool surfaces fully match the new shell
- Reduce the large frontend bundle size over time with code-splitting and cleanup
- Add formal beta release process/checklist updates once the branch workflow is settled
