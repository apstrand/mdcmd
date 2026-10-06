# MarkDown Commander — native iOS app

A native SwiftUI rebuild of mdcmd (displayed as **MarkDown Commander**) for iOS.
It enables the same workflows as the Tauri app — browse and edit Markdown in
Files / iCloud Drive / Dropbox / Google Drive — but as a genuinely native app
(no web view), following Apple's platform conventions. On iPad it uses a
two-column split view (browser + editor side by side); on iPhone it's a single
navigation stack. A welcome note is pre-pinned on first launch.

This is a standalone [**xtool**](https://xtool.sh) SwiftPM project, so it builds
with Swift toolchains on macOS **and Linux** (for CI), and can also be opened in
Xcode. It shares no code with the Tauri build; the file operations are plain
`FileManager`, and the security-scoped bookmark handling is ported from the
Tauri `docpicker` plugin.

## What it does

- **On My iPhone** — the app's own on-device Documents folder is always present
  as a built-in location (and appears in the Files app under "On My iPhone ›
  mdcmd" for two-way access), so there's an editable local workspace out of the
  box with nothing to set up.
- **Browse & pin** — add folders or files from the system document picker
  (Files, iCloud Drive, Dropbox, Google Drive) with the `+` button. Picked
  locations are pinned as shortcuts and their access is restored on each launch
  via security-scoped bookmarks. Drill into folders (navigation stays inside each
  picked root).
- **Edit Markdown** — a native styled-source editor (live syntax highlighting,
  iA Writer / Bear style) with an **Edit / Preview** toggle. Explicit Save plus
  auto-save on leave/background; dirty tracking; a keyboard formatting bar.
- **Create** files and folders; **search** a folder recursively.
- **Media** — view images (pinch-zoom) and video.
- **Open With** — open `.md`/text files from other apps in place (edits the
  original), via the share sheet / Files.
- **Quick Note widget** — a Home Screen widget that jumps into a designated note
  (`mdcmd://quicknote`), sharing the target through an App Group.

## Project layout

```
ios/
  Package.swift            SwiftPM manifest (app + widget library products)
  xtool.yml                app bundleID, Info.plist, entitlements, widget
  Mdcmd-Info.plist         merged onto the app's Info.plist (doc types, URL scheme)
  Mdcmd.entitlements       App Group
  QuickNoteWidget-Info.plist / .entitlements
  Sources/
    Mdcmd/                 the app (MdcmdApp, State, Services, Markdown, Views, Models)
    QuickNoteWidget/       the WidgetKit extension
  Mdcmd.xcodeproj          committed Xcode project — the TestFlight archive target
  Mdcmd/                   resources for that project (Info.plist, Assets, privacy)
  scripts/                 build/run helpers (xtool-based; Linux-friendly)
```

Day-to-day development uses xtool/SwiftPM (above). `Mdcmd.xcodeproj` is a second,
plain app-target build over the **same** `Sources/Mdcmd` tree — it exists only so
CI can `xcodebuild archive` for App Store distribution (xtool doesn't sign/upload
to TestFlight). Its `Mdcmd/Info.plist` is a complete plist and must be kept in
sync with the `Mdcmd-Info.plist` merge fragment when doc types / the URL scheme /
the display name change. The widget and App Group are **not** part of this target,
so the App Store build is a single app signed with a plain provisioning profile.

## Prerequisites

- Swift toolchain (macOS: Xcode; Linux: a Swift toolchain).
- [`xtool`](https://xtool.sh) on `PATH`. On macOS, xtool uses Xcode's iOS SDK
  directly (`xtool sdk install /Applications/Xcode.app` is a no-op that reports
  "Not installed"; that's expected).

## Build & run

```bash
cd ios

# Compile (this is the CI gate; works on Linux too)
xtool dev build                 # or: scripts/build.sh

# Run on the booted iOS Simulator (macOS)
xtool dev run --simulator       # or: scripts/run-sim.sh [udid]

# Run on a connected device (needs Apple Developer auth: xtool setup)
xtool dev run

# Open in Xcode for development
xtool dev generate-xcode-project && open Package.swift
```

## TestFlight distribution

Pushing a version tag ships a build to TestFlight via
`.github/workflows/ios-testflight.yml` (mirrors the mailbox setup):

```bash
./bump-version.sh 0.1.14     # from the repo root; updates package.json et al.
git commit -am "bump version to 0.1.14"
git tag v0.1.14 && git push origin v0.1.14
```

The tag must match `package.json`'s version (that becomes
`CFBundleShortVersionString`); the GitHub run number becomes the build number.
The job archives `Mdcmd.xcodeproj` with **manual** signing, exports an App Store
ipa, and uploads it with `altool`.

One-time setup (the workflow does not create these):

- An App Store Connect app record for bundle id `com.mdcmd.app`.
- Repo secrets — reused from the macOS release job: `APPLE_API_KEY` (key id),
  `APPLE_API_ISSUER`, `APPLE_API_KEY_BASE64` (the `.p8`); and new for iOS:
  `APPLE_TEAM_ID`, `IOS_DISTRIBUTION_CERTIFICATE` (base64 of an Apple
  Distribution `.p12`) + `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, and
  `IOS_PROVISIONING_PROFILE` (base64 of an App Store `.mobileprovision` for
  `com.mdcmd.app`, tied to that cert). See the header of the workflow file for
  how to produce each.

## Notes

- **App Group / Widget:** the widget shares the Quick Note target with the app
  through App Group `group.com.mdcmd.ios`. On the Simulator this works with the
  bundled entitlements; on a **device** the provisioning profile must include the
  App Group capability (`xtool setup` / your Apple Developer account).
- **Bundle ID:** `com.mdcmd.app` (change in `xtool.yml` and `Mdcmd.xcodeproj` if
  signing under your own team). The App Group id (`group.com.mdcmd.ios`) is
  independent of the bundle id and is left unchanged.
