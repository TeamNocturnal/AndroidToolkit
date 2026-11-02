# Apps

## Find Apps

Search by app name or Android package name. All six providers are attempted when enabled: F-Droid, GitHub, Aptoide, APKPure, APKMirror, and Uptodown. Results retain the provider's version and APK variant. Unknown device architectures are left unspecified.

- **Install / Update** downloads the package and installs it on the selected device.
- **Download APK** saves a validated package in the computer's Downloads folder without overwriting existing files.
- **Add to Queue** stages a direct download for Install APK.
- **Get APK** appears when the provider does not expose a usable direct download. The dialog opens the relevant website and accepts the downloaded file through Browse or drag and drop.

Direct downloads remain available where the provider exposes them. A failed download can open the same import flow. Browser checks, rate limits, and pages requiring a manual APK variant selection are not bypassed. APKPure package-name lookup can work even when its general search requires a browser. APKMirror and Uptodown behavior is checked per result, rather than declaring the entire provider browser-only.

GitHub lists individual APK assets so a user can choose the correct variant. F-Droid resolves its current version code from package metadata and does not invent a `_latest.apk` address. Aptoide results show the supplying store and its version; a result is not a guarantee that it is newer than every other source.

## Install APK

Browse or drop APK, APKM, APKS, or XAPK files. The queue survives navigation between pages, ignores repeated paths, runs a batch sequentially, and reports failed packages without stopping subsequent entries. Failed entries can be retried.

The installer examines the archive contents instead of relying on the filename. A normal APK must contain an Android manifest. Bundles containing a single APK set are extracted into isolated temporary directories and installed with `install-multiple -r` when there are multiple APKs. Bundletool archives containing device variants require a device-specific export or bundletool itself. Extraction failures and installation failures clean up temporary files. A package containing OBB game data is rejected with instructions to use its original store; those files are never silently discarded.

Downloads are limited to 1 GB, use timeouts, and reject HTML pages and unrelated ZIP files. Android remains responsible for APK signatures, platform compatibility, and version downgrade checks. The app never uninstalls an existing package to get around an update failure.

## Manage Apps

**Update** opens a package-name search for the selected app. Installing a newer compatible version uses Android's replacement install (`-r`) and keeps app data. **Uninstall** and **Clear Data** explain data removal before proceeding. Command failures remain visible, and controls recover after errors.

App backups include APK files and the shared files available to ADB. They do not imply access to private application data.

## App Stores

Store downloads use the store's own source. Aurora resolves its current F-Droid package, Aptoide resolves its current package metadata, and website-based stores attempt download resolution before offering import instructions. Galaxy Store remains an OEM-provided store rather than an installer for unrelated devices.

## Validation

```text
npm run test:apps
npm run test:tv
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

An optional network smoke test exercises the six live search providers:

```text
cargo test --manifest-path src-tauri/Cargo.toml live_sources -- --ignored --nocapture
```

Provider availability is a live condition. A provider returning a browser-download result is distinct from an APK download succeeding, and opening Android's local installer is distinct from a completed installation.
