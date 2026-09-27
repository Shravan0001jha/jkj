# Releasing Iris Workplace to TestFlight

Everything here runs without an Apple ID logged in to Xcode: signing and uploads authenticate
with the team's App Store Connect API key in `~/iris-ops/mobile/asc.env` (`ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_KEY_FILE`). Override the location with `ASC_ENV=/path/asc.env`.

    release/asc.py status            # bundle id, app record, TestFlight groups and testers
    release/archive.sh               # Release archive + export -> build/release/IrisWorkplace.ipa
    release/upload.sh --validate     # altool validation of the .ipa; uploads nothing
    release/upload.sh --upload       # the real upload (needs CONFIRM_UPLOAD=yes)
    release/asc.py builds            # what App Store Connect has, with processing state

`xcode-select` points at CommandLineTools on this Mac; the scripts export
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` themselves.

## What each piece is

| File | Purpose |
|---|---|
| `archive.sh` | `xcodegen generate`, `xcodebuild archive` (Release, generic iOS, automatic signing, `-allowProvisioningUpdates` with the ASC key), then `-exportArchive` with `ExportOptions.plist`. Writes `build/release/IrisWorkplace.ipa`, plus `archive.log` / `export.log`. Never uploads. |
| `ExportOptions.plist` | `method=app-store-connect`, `destination=export`, automatic signing, team `M9YV87TCT9`, symbols uploaded, version/build managed by us not by Xcode. |
| `upload.sh` | `xcrun altool --validate-app` by default; `--upload` does `--upload-app` and refuses unless `CONFIRM_UPLOAD=yes`. The key is copied to a private temp dir for the call (`API_PRIVATE_KEYS_DIR`) and removed after. |
| `asc.py` | Stdlib-only App Store Connect client (ES256 JWT via the system `openssl`). `status`, `ensure-bundle-id`, `ensure-internal-group`, `builds`, `get <path>`. |
| `make-icon.swift` | Draws the app icon and writes every size into `AppIcon.appiconset` with its `Contents.json`. Re-run after changing the drawing. |
| `../IrisWorkplace/PrivacyInfo.xcprivacy` | Privacy manifest: no tracking, no collected data types, one required-reason API (UserDefaults, CA92.1). XcodeGen copies it as a resource; nothing to add to `project.yml`. |

## Versioning

- Marketing version: `MARKETING_VERSION` in `project.yml` (`0.1.x`). Bump it there for a new
  version; TestFlight groups builds under it.
- Build number: `archive.sh` derives it on every run as UTC `yyyymmddHHMM` and forces it past
  `build/release/last-build` if two runs land in the same minute. App Store Connect rejects a
  reused build number for the same version, so each run yields something uploadable.
  `BUILD_NUMBER=… release/archive.sh` pins it.
- Export compliance: `ITSAppUsesNonExemptEncryption=false` is already in `project.yml` (the
  app uses only HTTPS/ATS, which is exempt), so a TestFlight build needs no compliance
  answer in the web UI.

## App Store Connect prerequisites

1. **Bundle ID** `com.irisforu.workplace`: registered on 2026-09-28 by `asc.py ensure-bundle-id`
   (Certificates, Identifiers & Profiles id `59D69C9ZRJ`, platform iOS). `asc.py status`
   confirms it.
2. **App record**: the API cannot create app records, so someone with Admin or App Manager
   access does it once in the browser (about two minutes):
   1. Open <https://appstoreconnect.apple.com/apps> and sign in with the team Apple ID
      (team `M9YV87TCT9`, "Shravan Jha").
   2. Click the blue **+** next to "Apps" (top-left) and choose **New App**.
   3. Platforms: tick **iOS** only.
   4. Name: `Iris Workplace`. (If Apple says the name is taken, use `Iris Workplace by Iris`;
      the name on the phone stays "Iris Workplace" from `CFBundleDisplayName`.)
   5. Primary Language: **English (U.K.)** (the Iris app record uses en-GB too).
   6. Bundle ID: pick **XC com irisforu workplace - com.irisforu.workplace** from the list
      (it is there because step 1 registered it; if the list is stale, reload the page).
   7. SKU: `irisworkplace`.
   8. User Access: **Full Access**.
   9. Click **Create**. Nothing else on the app page needs filling for TestFlight internal
      testing; the App Store listing can stay empty.
   10. Back on the Mac: `release/asc.py status` should now print `app record: present`.
3. **Internal testing group** with the owner only: after step 2 run
   `ASC_OWNER_EMAIL=<owner's Apple ID email> release/asc.py ensure-internal-group`. It creates the
   internal group **Owner** with access to all builds and adds the owner. Internal testers must
   be users of the App Store Connect team; if the API refuses to add him, do it in the browser:
   app → **TestFlight** tab → **Internal Testing** → **Owner** → **Testers (+)** → tick the
   owner → **Add**. He then gets an email invite and installs the TestFlight app from the App
   Store; every later build appears there automatically.

## The upload, when the owner has approved it

    release/archive.sh
    release/upload.sh --validate
    CONFIRM_UPLOAD=yes release/upload.sh --upload
    release/asc.py builds            # processingState VALID after 5–15 minutes

Once a build shows `VALID`, TestFlight notifies the internal group; the owner opens TestFlight on
the phone and taps **Install** / **Update**. Builds expire after 90 days; re-run the three lines
for a new one.

## Signing notes

- No Apple Distribution certificate is kept on this Mac on purpose: with `-allowProvisioningUpdates`
  plus the API key, Xcode uses cloud-managed signing (the certificate lives in Apple's
  infrastructure; the key's App Manager role is enough). The first archive on a fresh Mac takes
  a little longer while Xcode fetches the cloud certificate and creates the App Store profile.
- If the archive fails with "No profiles for 'com.irisforu.workplace' were found", the bundle id
  is not registered: `release/asc.py ensure-bundle-id`.
- The entitlements file is empty. No push (`aps-environment`) is requested; alerts are local
  notifications. Adding push later means an APNs key (see `~/iris-ops/mobile/apns.env` for the
  Iris app's), the entitlement in `project.yml`, and a line in `PrivacyInfo.xcprivacy` is not
  required for push itself.
