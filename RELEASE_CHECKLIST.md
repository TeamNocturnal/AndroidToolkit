# Release Checklist

## Before Publishing

- [x] App version updated to `2.0.0`
- [x] Titlebar branding updated to `Android Toolkit`
- [x] Footer version updated to `v2.0.0`
- [x] Beta labels removed from release-facing UI and metadata
- [x] In-app update checker switched from stub to GitHub releases lookup
- [x] Lint passes
- [x] Frontend production build passes
- [x] Rust `cargo check` passes
- [x] CI workflow added
- [x] Changelog added
- [x] Release notes draft added
- [x] Screen Mirror popout hidden for the stable release

## Packaging

- [ ] Install `create-dmg`
- [ ] Run `npm run build:mac`
- [ ] Verify generated `.app` launches locally
- [ ] Verify generated `.dmg` installs locally
- [ ] Verify DMG on a second Mac

## Manual App Verification

- [ ] Titlebar shows `Android Toolkit`
- [ ] Footer shows `v2.0.0`
- [ ] Screen Mirror popout button is absent
- [ ] Devices view still works
- [ ] Maintenance view still works
- [ ] Update checker does not show runtime errors

## Publish

- [ ] Review `RELEASE_NOTES_2.0.0.md`
- [ ] Commit release-prep changes
- [ ] Tag release
- [ ] Push branch and tags
- [ ] Create GitHub release with final DMG and notes
