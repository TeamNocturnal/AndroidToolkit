# Android Toolkit 2.0.0

First stable `2.0.0` release of Android Toolkit by Team Nocturnal.

## Highlights

- Stable `2.0.0` branding across the app, package metadata, and desktop bundle config
- Clean local validation path with passing `eslint`, frontend production build, and Rust `cargo check`
- Basic GitHub Actions CI for lint, frontend build, and Rust validation
- Live in-app update banner backed by GitHub releases instead of a hardcoded stub
- Screen Mirror popout entry point hidden for the stable release while follow-up work stays tracked for the next beta
- Updated macOS packaging docs and ad-hoc signing flow to help avoid damaged-app behavior without a Developer ID

## Notes

- macOS distribution currently uses ad-hoc signing, not Apple Developer ID signing or notarization
- Screen Mirror popout polish and re-enable work is intentionally deferred to a future beta cycle
- The web bundle is still large, so startup and packaging optimization remains an improvement area after `2.0.0`

## Validation

- `npm run lint`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

## Known Deferred Work

- Re-enable and harden Screen Mirror popout behavior
- Additional bundle-size reduction and code splitting
- Optional future Tauri webview hardening such as a stricter CSP
