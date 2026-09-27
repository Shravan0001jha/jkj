---
id: mobile
title: Mobile
axis: platform
version: 1
mission: "Own the iPhone, iPad and Android apps so the phone is the place you ask from, and bring the iPhone app to the definition's Phase 1 shape."
---
## Mission and scope
- Own the iOS app (SwiftUI, XcodeGen) for iPhone and iPad, its dev loop on the owner's connected devices, TestFlight uploads, and the share extension.
- Own the Android app (Kotlin, Jetpack Compose, Firebase only for push), its Gradle build and release signing.
- Own the phone side of errands (queue, status, push), the chat client, the phone MemoryScreen and Drive views, and the requirements the definition adds and the apps lack: widgets, Live Activities, alarms on iPhone, the floating bubble on Android, share-sheet capture, voice notes, the library.
- Out of scope: the relay and push services themselves (server owns `relay.py`, `apns.py`, `fcm.py`, `asc.py`); the Mac side of an errand (experts `phone.py`); the character engine being packaged (character, A6).

## Owned things
- Worktree `~/claude-dev-mobile` (branch `feat/mobile`): `mobile/ios/project.yml` (source of truth; the `.xcodeproj` is generated, not committed), `mobile/ios/Iris/`, `IrisShare/`, `IrisUITests/`, `dev-run.sh`, `testflight.sh`, `README.md`; `mobile/android/build.gradle.kts`, `settings.gradle.kts`, `gradle.properties`, `app/build.gradle.kts`, `app/src/`, `app/google-services.json`, `gradlew`.
- iOS facts: bundle id `com.irisforu.iris`; iPhone chat (photos, camera, documents, voice notes, Quick Look, Share, Save to Drive, Stop/Retry/Delete, media/docs/links, memory, Google Drive, Mac status); iPad "Iris lives on the screen": a large animated stage reacting to the chat, tap-to-talk (voice note in, her voice out via `/v1/tts`, system voice fallback, `source=talk`), screen stays on; push via APNs direct with tokens `apns:sandbox|production:<hex>` and inline reply; share extension "Send to Iris" sharing sign-in through a keychain group; debug launch env `IRIS_DEBUG_TOKEN/EMAIL`, `IRIS_DEBUG_SIGNOUT`, `IRIS_DEBUG_NOPUSH`, `IRIS_DEBUG_SEND`, `IRIS_DEBUG_SPOKEN`, `IRIS_DEBUG_SPEAK`.
- Android facts: `applicationId com.irisforu.iris`, `minSdk 26`, `targetSdk 35`, `compileSdk 36`, `versionName 0.3.0`, `versionCode 3`, `API_URL` and `SITE_URL` as `buildConfigField`s (one place for a staging build); release signing from `IRIS_ANDROID_KEYSTORE` / `_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD` pointing at a keystore kept in `~/iris-ops/mobile/` (by name only); minify and shrink on for release; sign-in, push (FCM) and the phone relay exist.
- Shippables: iOS (TestFlight through `asc.py` invites; the Road doc of 25 Sep recorded no iPhone app at 0.2.11, the worktree now holds the SwiftUI project; its TestFlight build number is a UTC timestamp), Android 0.3.0.
- Requirements: iPhone app in Phase 1 (D5), widgets, Live Activities, wake-up alarm rings on the phone, Android floating bubble, portable character A6, presence A4, share-sheet capture, voice notes, the library; the phone→Mac errand flow (the Workplace's seeded M3 feature).
- Metrics: install success on the two devices; TestFlight build acceptance; errand round-trip time phone → Mac → phone; crash-free sessions (nothing reports them yet).

## Interfaces
- Publishes: the phone contract both apps speak and iOS reuses from Android: `POST /v1/chat/messages` (`source=phone|talk`), `POST /v1/errands`, `GET /v1/errands`, `/v1/shelf`, `POST /v1/devices`, `GET /v1/link`, `/v1/chat/memory`, `/v1/google/*`.
- Consumes: those routes from server; `asc.py` for TestFlight invites; the character stage as a web view (A6) from character; `/v1/tts` for the iPad's voice.

## Rules and traps
- Use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; the active `xcode-select` is CommandLineTools and must not be switched with sudo (`dev-run.sh`, brief §0).
- `xcodegen generate` before any build; never edit the `.xcodeproj` by hand.
- The connected devices' UDIDs and the test account token are read by `dev-run.sh` (device ids inline, token from `~/iris-ops/state/test_token`); never print them in reports.
- iOS and Mac builds run only on this Mac; keep heavy builds to 1–2 concurrent (CoreAudio has overloaded under load).
- Signing team and keychain group are in `project.yml` and `testflight.sh`; reuse them, never paste them into docs. The Workplace's own iPhone app reuses this signing team (brief §0).
- UI tests need "Enable UI Automation" confirmed once per device with its passcode (the owner does that).
- `dev-run.sh` writes screenshots to `IRIS_SHOTS` (default `/tmp/iris-ios`), signs in as the test account, and `NOBUILD=1` skips the build for a quick relaunch; `IRIS_DEBUG_SIGNOUT=1` clears the token.
- Android debug builds use the default debug key, which is all a phone needs for sideloading; only release builds touch the keystore.
- `testflight.sh` archives Release with automatic signing and uploads (or `--export` for the `.ipa` only); every upload is an outward action and needs an approved Inbox item.
- iOS cannot float over other apps; widgets, Live Activities and alarms carry her there; ship chat, alarms and a widget first, Live Activities after (extract §C D5, risks).
- iOS subscriptions must go through the App Store; Android through Play billing (§C "Alongside").
- The relay's `GET /v1/errands/next` poll is the Mac's heartbeat and how the phone knows whether she is awake; an errand runs one at a time per Mac (`relay.py`, `phone.py`).
- Firebase is used only for push on Android; `google-services.json` is in the tree; treat it as configuration, not a secret, but do not copy it elsewhere.
- Android stays at chat level on the same API until Phase 2, then gains the floating bubble and errand parity (extract §F 14).
- The friend network (Iris-to-Iris notes) needs the 18+ gate first and rate limits, block and report from day one (D6).
- Presence (A4) decides which device rings or shows a message: heartbeats the Mac already sends and the phone would send; alarms are a server schedule plus a local copy de-duplicated by id so an offline Mac still rings (extract §C collisions).
- The iPhone app is the largest single item on the road (Wave 5, 6–8 weeks); it is not "done" until the definition's stage-1 gate is measured on real users.

## Definition of done
- iOS: `./dev-run.sh iphone 3 8 IRIS_DEBUG_NOPUSH=1 "IRIS_DEBUG_SEND=hello"` and `./dev-run.sh ipad …` produce screenshots that are measured against a control, plus a build log with zero `error:` lines; `IrisUITests` run and counted when they apply.
- Android: `./gradlew test` and `./gradlew assembleDebug` green, an install on a device or emulator with the errand round trip shown in the Mac's `agent.log`.
- Errand flow: a phone request appears on the Mac, runs, and the phone shows done/failed with the result, with timestamps from both sides.
- "Not verified" must name whichever device was not exercised, and TestFlight acceptance if the upload was not done.

## How to build, test and ship
- iOS: `brew install xcodegen`; `export DEVELOPER_DIR=…`; `xcodegen generate`; `./dev-run.sh <iphone|ipad> [shots] [gap] [K=V…]`; TestFlight: `./testflight.sh` (upload) or `./testflight.sh --export`.
- Android: `cd ~/claude-dev-mobile/mobile/android && ./gradlew assembleDebug` / `assembleRelease` with the `IRIS_ANDROID_*` env set from `~/iris-ops/mobile/`.
- Ship: TestFlight upload (`testflight.sh`) or a Play/APK release only with an approved Inbox item; qa-release prepares readiness.

## Coordinate with
- server: APNs/FCM, `asc.py`, relay routes, `source=talk`, entitlements on the phone.
- experts: the errand contract and what the Mac reports back.
- character: A6 portable character for the iPad stage and the Android bubble.
- memory: `/v1/chat/memory` shape and the phone facts migration.
- product-and-business: D5 (which phone), Phase 1 scope, App Store billing.
- qa-release: device verification, TestFlight readiness.

## Needs owner approval
- Every TestFlight upload, store upload or APK release; adding a tester to the TestFlight group.
- Anything that needs his passcode or a prompt on his devices (UI Automation, provisioning).
- New Apple or Google credentials; changing bundle ids or the signing team.
