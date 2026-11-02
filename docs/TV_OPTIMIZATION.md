# Android TV and stick optimization

Reviewed 2026-11-02.

## Shared workflow

TVs, streaming boxes, and sticks use the same optimizer. Compatibility is determined from Android TV features, Android version, available shell commands, installed apps, and readable package states. A manufacturer or model selection is unnecessary. The target-device selector appears only when more than one device is present.

This approach covers Android TV, Google TV, and Android-based Fire OS without restricting the implementation to a list of brands. Sony, TCL, Hisense, Philips, Xiaomi/Redmi, Google, onn, NVIDIA, Sharp, Panasonic, Toshiba, JVC, Skyworth, Haier, Nokia, Thomson, realme, MECOOL, Homatics, RockTek, Dune HD, Dynalink, projector vendors, and generic OEMs all pass through the same capability checks. This is architectural coverage, not a claim that every vendor's firmware has been tested.

Non-Android platforms are outside this workflow. In particular, newer Fire TV devices can use Vega OS rather than Android-based Fire OS. See [Amazon's platform overview](https://www.developer.amazon.com/apps-and-games/sdks).

## Options

| Option | Default | Behavior |
| --- | --- | --- |
| Faster menus | On | Caps three standard animation scales at 0.5, preserving existing faster or disabled animations. |
| Disable bundled apps I choose | Off | Shows installed, enabled preloads from an exact catalog of standalone entertainment apps. Each app requires individual selection. Uses reversible owner-profile disabling; retains app data. |
| Clear temporary app caches | Off | Available only when the firmware advertises the cache-only command and meets the platform gate. Limited to recognized entertainment apps. Checks for running app processes and skips them. Never substitutes data clearing if unsupported or unsuccessful. |
| Demo/shop-mode check | Included in scan | Reads Android's retail-demo flag. Unknown stays unknown. Shows manufacturer guidance for proprietary shop modes. An active Android retail-demo flag blocks optimization. |

The optional-app catalog identifies standalone apps, not guaranteed-unused apps. Users must choose what they do not use. Unknown packages and vendor services are excluded. No package-name substring is sufficient to qualify an app for automatic cleanup.

Disabling a preload may save background work but does not reclaim its read-only system-image space. No speed improvement is promised for an already-tuned device. Available RAM and free storage are diagnostic snapshots.

Cache clearing retains application data but temporary cache cannot be restored. Apps can recreate it and may need to fetch content again. The optimizer reports success, running-app skips, and errors separately. Google's [cache and storage guidance](https://support.google.com/chromecast/answer/11276506?hl=en) distinguishes cache cleanup from app removal.

## Demo modes and home-screen clutter

There is no established universal shell operation for safely leaving every manufacturer's retail mode. Android's [retail-mode architecture](https://source.android.com/docs/core/display/retail-mode) can involve device ownership and provisioning; it must not be treated as a harmless display toggle.

| Make / platform | Guidance |
| --- | --- |
| Sony | Use Retail mode settings to turn off demo and picture-reset behavior. [Sony instructions](https://www.sony.com/electronics/support/articles/00050389) |
| TCL | Choose Home Mode in Usage Mode when available. [TCL instructions](https://support.tcl.com/en_US/how-to-switch-your-tcl-google-tv-from-store-mode-to-home-mode) |
| Hisense | Use the Store Mode / Home Mode controls; menu paths vary. [Manufacturer manual, Usage Mode section](https://files.hisense-usa.com/download/f2565f9cb1a82ad4) |
| Philips / TP Vision | Set the TV's location to Home rather than Shop. [Philips instructions](https://www.philips.co.uk/c-f/XC000015786/what-to-do-when-information-about-philips-tv-appears-on-the-screen-shop-mode) |
| Xiaomi / Redmi | Look for TV Mode and choose Home; follow firmware-specific guidance. [Xiaomi example](https://www.mi.com/global/support/faq/details/KA-367537/) |
| Other Android TV makes and sticks | Use the manufacturer's normal Store / Shop / Retail / Demo / Usage Mode menu if present. An absent Android flag does not prove the vendor mode is off. |

The optimizer never factory-resets, changes device ownership, or disables retail-management packages. Vendor demo applications require manual investigation rather than a broad removal list.

Google TV's Apps only mode is an optional manual home-screen preference. It reduces personalized recommendations but changes Search, Assistant, and Watchlist availability; sponsored content can remain. See [Google's explanation](https://support.google.com/googletv/answer/10267283?hl=en). Recommendation services, kids profiles, and the stock launcher are therefore excluded from automatic cleanup.

## Restore and protections

Original settings and exact package enabled states are saved and read back before reversible writes. Every write is verified. A failure triggers rollback; incomplete rollback is reported. Restore checks hardware identity and refuses to overwrite a later unrelated adjustment. Legacy animation backups remain readable.

Owner-profile operations require Android user 0. Launchers, settings, remote input, Cast, accessibility, DRM, tuners, HDMI/CEC, picture processing, networking, stores, firmware updates, and unknown vendor packages are not modified by the optimizer. It does not apply CPU/GPU overrides, memory-killer limits, DNS changes, interface-resolution changes, or blanket background-process termination.

The package operations follow Android's [package-manager implementation](https://android.googlesource.com/platform/frameworks/base/+/main/services/core/java/com/android/server/pm/PackageManagerShellCommand.java), including distinct cache-only cleanup and default/enabled/disabled-user states. Support is checked on the connected firmware rather than inferred from the brand.

## Connected-device scanning

The top-bar Scan button refreshes the complete ADB USB/Wi-Fi inventory. Scan All Devices in TV tools also inspects each authorized device independently. Unauthorized, offline, recovery, unsupported, and failed entries remain visible. A per-device timeout prevents one unresponsive device from hiding the rest. Review selects an individual TV; scanning never applies optimizations to a batch.

Devices must already be connected through ADB. This does not scan every LAN address or bypass pairing/debugging authorization. A device merely connected to the home router may need its Wi-Fi debugging connection established first.

## Audio lag and recovery

Audio sync is separate from menu-animation speed. The audio panel captures uptime, the music audio route, the surround-output preference, buffer-counter availability, and a count of recent targeted audio warnings. It does not measure end-to-end lip-sync delay. Missing permissions are reported, and raw log messages and media titles are not displayed or saved by the panel.

An ONN Android 14 sample showed HDMI audio and approximately 18.5 days of uptime, with no warnings in the sampled audio log. The user reported intermittent sound trailing video by one or two seconds with a 5.1 system and a soundbar, relieved by rebooting. These observations do not establish whether the player, decoder, HDMI path, TV, or external audio system causes the delay. Capture another diagnostic while the symptom is present.

Recovery is explicit: restart a chosen enabled playback app, or request a restart of the selected TV/stick. App restart verifies the TV activity before stopping playback, retains sign-in data, and excludes core services. Device restart verifies hardware identity and the owner profile. Neither action runs during Optimize or scans. A successful restart command means a request was sent, not that audio sync has been verified afterward.

For surround setups, the guide suggests isolating the app/audio track and HDMI path, checking firmware and supported formats, and temporarily testing stereo only when the user chooses. The previous surround format should be restored after that test. No audio offset or surround format is changed automatically. See [Google audio-sync troubleshooting](https://support.google.com/chromecast/answer/15653636?hl=en), [Google HDMI-chain guidance](https://support.google.com/googletv/answer/16995384), and [TCL audio-delay troubleshooting](https://support.tcl.com/us-googletv-troubleshooting/audio-delay-issues-on-your-tcl-google-tv).

## TV navigation

TV tools are grouped by task rather than brand:

Desktop navigation follows Getting Started → Devices → Apps → Device Tools → Files & Backups → Advanced → Help. Devices owns USB/Wi-Fi connection and code/QR pairing. TV Setup keeps manufacturer instructions and links to Devices instead of presenting a second connection form. General Tools keeps debugging preference controls, while connection and pairing stay in Devices.

| Section | Contents |
| --- | --- |
| Tools | Scan, optimize, audio help, device health, network checks, display inspection and adjustment, remote, screenshots, settings shortcuts, background apps, and Private DNS |
| Setup | Debugging guides, connection and pairing, and ADB checks |
| Apps & Cleanup | Device-specific app groups, individual app management, and app utilities |
| Streaming | Media apps, Kodi repositories, and sources |
| Launchers | Home-screen installation, switching, and restoration |

Duplicate cleanup shortcuts are consolidated into app groups. Background apps and Private DNS appear as regular cards in Tools. Display adjustments share the existing display card. Fire TV extras appear as expanded cards only for a recognized Fire TV. Interface size affects Android rendering rather than HDMI output resolution.

### Private DNS

The selector has 22 choices: standard and filtered hostnames grouped by Google, Cloudflare, AdGuard, Quad9, CleanBrowsing, and Control D, with NextDNS/custom profile input and Automatic/Off modes. Each profile describes its purpose rather than promising universal ad removal or complete parental control. Some apps, VPNs, and separate DNS clients bypass system DNS. Filters can disrupt app domains; video ads hosted with the video often remain. Control D’s combined filtering levels are also described in its [setup guide](https://controld.com/blog/how-to-setup-control-d-on-firefox/).

Android Private DNS needs a provider hostname rather than an IPv4 address or a DNS-over-HTTPS URL. Provider endpoints and filtering descriptions were checked against [Google](https://developers.google.com/speed/public-dns/docs/using), [Cloudflare](https://developers.cloudflare.com/1.1.1.1/setup/android/), [AdGuard](https://adguard-dns.io/en/public-dns.html), [Quad9](https://docs.quad9.net/services/), [CleanBrowsing](https://cleanbrowsing.org/filters/), [Control D](https://docs.controld.com/docs/free-dns), and [NextDNS](https://nextdns.io/). The [supplied comparison](https://showdns.net/learn/10-best-dns-providers) informed provider coverage; router-IP-only entries are not copied into the Android hostname field.

Apply requires Android 9+, TV identification, the primary profile, and a read-back-verified local backup before writes. Both DNS settings are verified after writing; failures attempt exact rollback. Restore previous checks hardware identity and refuses to overwrite later changes. Automatic returns to network-supplied DNS with opportunistic encryption; Off disables Android Private DNS. Neither means router filtering is removed. Settings read-back confirms saved preferences, not a successful TLS connection or effective filtering. No provider is applied by selection alone, during Scan, or during Optimize.

Device health reports contain a summary of model, platform, memory, free storage, uptime, and security patch; saving is explicit. Network checks read local IPv4 addresses, routing tables, and Private DNS preferences. Test connection sends three pings to 1.1.1.1; it reports loss and average reply time, not throughput or a diagnosis of streaming quality. Blocked or unavailable diagnostics remain explicit. Display checks inspect Android rendering size and density rather than claiming an HDMI output mode. These diagnostics use the documented [ADB shell](https://developer.android.com/tools/adb) facilities; Android's [diagnostics guidance](https://developer.android.com/tools/dumpsys) describes related device inspection.

Remote keys and settings shortcuts use fixed allowlists and validate TV features before sending a command. They affect the selected TV only when clicked. No free-form shell or typed remote text is accepted. Settings pages vary by firmware; an unsupported shortcut reports the error and offers All settings instead. Screenshots use the existing desktop capture service, display in memory, and save to Downloads only on request. Protected video may be black. Switching devices clears the displayed reports and capture. Device actions share a busy state with optimization to prevent overlapping operations within the page.

Desktop capture collects raw process events to preserve PNG bytes; the shell plugin's text-oriented output collector inserts newlines. Capture rejects non-PNG output, limits image size, and stops the capture client after a 30-second timeout.

## Cross-device update controls

The shared System updates card is available in Device Tools, Phone Tools, Tweaks, Quest Tools, and TV Tools. It identifies manufacturer, brand, Android version, hardware identity, A/B support, the automatic-install preference, and installed system updater packages. The same component is used throughout; it only targets the selected ADB serial and the hardware reviewed in the latest scan.

| Detected family | Available method |
| --- | --- |
| Samsung, Motorola, OnePlus, OPPO/Realme, Vivo/iQOO, ASUS, Sony, TCL/Alcatel, LG, Amazon Fire OS | Exact known updater packages, only when present as installed system apps with a readable primary-user state |
| Any manufacturer with the standalone Adups client | The exact `com.adups.fota` package, when present as an installed system app |
| ONN, Google, NVIDIA, other A/B Android devices | Automatic-install preference when detected; no blanket Google services disabling |
| Xiaomi/Redmi/POCO, Huawei/Honor | No automatic package blocking; automatic-install preference when detected, otherwise device settings |
| Other devices or unsupported firmware | Automatic-install preference when detected, otherwise an explicit unsupported result and manual settings |

The [AOSP preference controller](https://github.com/aosp-mirror/platform_packages_apps_settings/blob/master/src/com/android/settings/development/DisableAutomaticUpdatesPreferenceController.java) documents `ota_disable_automatic_update`. Pausing this preference is distinct from blocking downloads, every vendor updater, or manual updates. A/B detection and saved-setting read-back do not prove that a particular vendor respects it. The [AOSP OTA architecture](https://source.android.com/docs/core/ota/ab) explains why some Google-based devices use Play services as their update client. Play services, app stores, update engines, and firmware partitions are never disabled or altered by this tool.

Updater package roles were reviewed in the [upstream package catalog](https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation/blob/main/resources/assets/uad_lists.json). That catalog flags MIUI updater removal as unsafe on some versions; `com.android.updater` is excluded. This is a curated package-role map, not physical validation of every manufacturer. Fire OS protection varies: the [Fire toolkit's observed limitations](https://github.com/jeremykenedy/fire-tv-toolkit/blob/main/docs/GUARD.md) show that firmware can refuse updater disabling. A refused command is reported and previous successful changes are rolled back; no hide, uninstall, root, or alternate bypass is attempted.

Block/Allow saves and verifies a local restore backup before writing, checks the primary profile and reviewed hardware identity, reads back each change, and attempts rollback on failure. Undo preserves exact default/enabled/disabled-user states and absent preference values, refuses another device or later manual changes, and keeps the backup on incomplete restoration. The matching plan is rebuilt before applying; another manufacturer's packages and packages with unknown, hidden, suspended, or unsupported states are excluded.

Package disabling is for the primary Android profile and does not guarantee that every system-level update path stops. Firmware can reset these preferences. Blocking firmware updates also delays security fixes; never interrupt an update already downloading or installing. These controls do not manage Play Store or other app auto-updates. Enterprise update policies are separate and require an authorized device-policy controller, as explained in [Android's update-policy documentation](https://developer.android.com/work/dpc/system-updates).

Earlier read-only ONN Android 14 inspection confirmed A/B support, an unset automatic-install preference, and no dedicated supported updater package. Its available method is therefore Pause auto-install and Allow updates, with an explicit statement that this is not a full update block. The ONN subsequently went offline; the completed inspector could not be run live against it, and one reconnect timed out. No update-control writes were performed during validation. Other manufacturers, failures, restoration, and cross-device guards are exercised with simulated devices.

## Validation commands

Run `npm run test:tv`, `npm run lint`, and `npm run build`.

Tests exercise brand-independent detection, existing faster settings, package selection and exact restore, failed backups and writes, interrupted rollback, hardware identity changes, secondary users, unknown demo state, managed demo blocking, unsupported cache commands, running-app exclusion, and tampered backups. Simulated brand coverage is separate from physical-device verification.
