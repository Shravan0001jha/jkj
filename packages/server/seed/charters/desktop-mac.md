---
id: desktop-mac
title: Desktop (Mac)
axis: platform
version: 1
mission: "Own the Mac app as a shippable: packaging, signing, notarisation, the bundled agent, the updater and the release scripts, for Apple Silicon first and Intel level with it."
---
## Mission and scope
- Own `desktop/` as an Electron app (`iris-desktop` 0.2.15, Electron ^32, electron-builder ^25, three ^0.186, @pixiv/three-vrm ^3.5), its main process, windows, sign-in, preload bridges and the updater.
- Own the PyInstaller agent bundle (`services/agent-svc/iris-agent.spec`), the Vision OCR helper and the yt-dlp JS solver it must carry, and the arm64 and x64 release pipelines.
- Own dev ergonomics on the Mac: `npm start` (prestart rebuilds `character/stage.bundle.js`), `Procfile.desktop`, `scripts/run-desktop.sh`.
- Out of scope: what the character does (character); the voice loop (conversation); the Windows build (windows); the server the updater talks to (server).

## Owned things
- `desktop/main.js`, `preload.js`, `auth.js`, `updater.js`, `signin.html`, `signin.js`, `signin-preload.js`, `renderer/index.html`, `renderer/renderer.js`, `renderer/style.css`, `chat/` (chat popup shell; the Memory view logic is memory's), `slate/`, `panel/`, `drop/`, `onboarding/`, `build/` (entitlements `build/entitlements.mac.plist`, icons), `package.json` (`build` block: `appId app.iris.desktop`, dmg + zip arm64, `extraResources` from `../services/agent-svc/dist/iris-agent`, generic publish provider pointing at the API host's `/v1/update`, usage descriptions for mic, Apple Events, Contacts, Calendars, Reminders, Accessibility).
- `services/agent-svc/iris-agent.spec` (hidden imports `svclog`, `cloud_client`, `screen_timeline`, `speech_acts`, `proactive_trigger`, `collect_submodules('context')`), `services/agent-svc/context/ocr/build.sh`, `dist/`, `dist-x64/`, `build-x64/`.
- `scripts/release-iris.sh`, `scripts/release-iris-x64.sh`, `scripts/build-agent.sh arm64|x64`, `scripts/sign-app.sh`, `scripts/rollback-iris.sh` (shared with qa-release), `scripts/manifest_merge.py` + `scripts/test_manifest_merge.py`, `Procfile.desktop`, `scripts/run-desktop.sh`, `.venv` and `.venv-x64`.
- Tests: `desktop/tests/quit.test.js`, `plist.test.js`, `token.test.js`, `slate.test.js`, `workcard.test.js`, `pcm.test.js`, `speaker.test.js`, `audio-music.test.js` and the rest of `npm test`.
- Shippables and versions: Mac Apple Silicon 0.2.15 (latest release, notarised, self-updating); Mac Intel 0.2.4 (stuck; Apple Silicon was 0.2.11 when the Road doc called it "seven releases behind").
- Docs: `docs/HLD-desktop*.md`, `docs/PRODUCT-desktop*.md`, `docs/board/tickets/IRIS-010.md` (silent auto-update).
- Metrics: release lead time; launch-check pass; update adoption per version (from tester logs); Intel lag in releases.

## Interfaces
- Publishes: `latest.json` (the manifest, one key per platform) and `Iris.dmg` / update zips in the S3 bucket behind CloudFront; the packaged env for the agent (`VOICE_IO=renderer`, the latency flags in `desktop/auth.js`); IPC bridges (`pet:nudge`, `pet:tuck`, `tts:level`); the `iris-dev.log` the harness reads.
- Publishes: the launch-check result and `iris-dev.log` location for qa-release; the arm64 and x64 dmg names and sha256s in the release report.
- Consumes: `/v1/update/{filename}` with the user's token and short-lived signed URLs (`updater.js`); the agent's `/healthz` on port 9110; `character/stage.bundle.js` from character.

## Rules and traps
- `scripts/release-iris.sh` kills the installed Iris (`pkill -f Applications/Iris.app/Contents/MacOS/Iris` and the dev Electron) for its launch check and does not relaunch it; it also removes the `SingletonLock` files. Warn the owner before running it on his machine.
- One release at a time: the `/tmp/iris-release.lock` directory; two concurrent runs shared scratch dirs and SIGKILLed a good 0.2.4 mid-launch-check. If stale, `rmdir` it.
- Rebuild `stage.bundle.js` first (step 2/6); from 0.2.2 the 3D character is the default, so a stale bundle ships an unknown product.
- The OCR helper must be compiled by `context/ocr/build.sh` before PyInstaller and must be in the bundle in the right slice (`lipo -archs`); `yt_dlp_ejs/core.min.js` must be in the bundle or music ships dead. Both are asserted, because a missing module fails at first use on a tester's Mac, not at build.
- Sign inside-out, never `--deep`; `--options runtime` only with a real Developer ID (ad-hoc has no Team ID and Electron Framework is refused at dyld); a ticket stapled only to the dmg does not travel with the dragged app, so staple the app before the dmg (`scripts/sign-app.sh`, release steps 3/6, 3d/6).
- The quarantined launch check runs only on the notarised build (4c/6); a quarantined check on an un-notarised build fails every build and killed 0.2.4 twice.
- Intel: separate script on purpose; PyInstaller cannot cross-compile, so `arch -x86_64 ../../.venv-x64/bin/python -m PyInstaller` with `--distpath dist-x64`; assert the agent is `x86_64` and the OCR helper `x86_64`; prove the agent serves `/healthz` and that the port's owner is the new process; `manifest_merge.py` writes only the x64 key. The script's header comment ("0.2.1 while arm64 is on 0.2.4") is stale; the real gap is 0.2.4 vs 0.2.15.
- Updater (`desktop/updater.js`, ticket IRIS-010): the build is not on a public URL; the feed goes through iris-api with the user's token and the server hands back short-lived signed URLs; electron-updater fetches them itself and serves Squirrel.Mac over a localhost proxy so Squirrel never talks to our server.
- Updater timing: never interrupt someone mid-sentence; download in the background, install on quit. Squirrel validates the code signature, so silent update only works with a Developer ID signed and notarised build.
- `scripts/sign-app.sh <Iris.app>` uses `APPLE_SIGN_ID` from `~/iris-ops/state/infra.env` (by name) or a keychain identity and falls back to ad-hoc; an ad-hoc build works locally but warns on download and cannot self-update.
- Rollback is a copy of stored object versions back over the current keys (`scripts/rollback-iris.sh <version>`), no rebuild.
- Heavy builds are capped at 1–2 concurrent on this Mac; CoreAudio has overloaded under load before; the Mac is kept awake with `caffeinate -dimsu`.
- Packaged builds force `VOICE_IO=renderer` on both halves and turn on `TTS_STREAM`, `SPEAKER_STREAM`, `OPENER`, turbo voice; the dev stack must match (`Procfile.desktop`).
- Do not touch the owner's running Iris or restore it wrongly; `honcho` restarts can silently keep serving old code, so verify the PID is fresh before a live test.

## Definition of done
- `cd desktop && npm test` green (22 test files) and `node --check` on changed JS; `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests` for spec or agent changes; `python -m pytest -q scripts/test_manifest_merge.py` for manifest changes.
- A release is done when the script reached 6/6, the notarised + stapled + quarantined launch check passed, `latest.json` carries the new version and sha256, and an installed copy on this Mac updated itself on quit.
- Intel is done only when the x64 dmg was launched on a real Intel Mac or Rosetta-free VM; otherwise "not verified on Intel hardware".
- A rollback is done when `latest.json` reports the target version and sha256 and a fresh download launches; say if the installed copies' update path was not exercised.
- Every fix has an RCA and a regression test that failed first.

## How to build, test and ship
- Dev: `cd desktop && npm start` (runs `npm run build:stage` via `prestart`); `npm run dev` for `--dev`; `honcho start -f Procfile.desktop` for the local stack.
- Agent bundle: `scripts/build-agent.sh arm64` or `x64`; or `cd services/agent-svc && ../../.venv/bin/pyinstaller --noconfirm iris-agent.spec`.
- Release (owner-approved Inbox item, then qa-release confirms readiness): `scripts/release-iris.sh <version>` (bundle → app → sign → launch check → zip → staple → dmg → notarise → upload → CDN); Intel: `scripts/release-iris-x64.sh`; rollback: `scripts/rollback-iris.sh [version]`.

## Coordinate with
- character: the stage bundle, window transparency and GPU behaviour.
- conversation: renderer audio, `VOICE_IO`, latency flags.
- experts: the bundle's hidden imports and helpers (OCR, yt-dlp), `context/`.
- server: the update feed, signed URLs, `/v1/logs` shipping from Electron (missing crash reporter).
- windows: shared `package.json` `win`/`nsis` block and `iris-agent.spec` platform guards.
- qa-release: release readiness, the smoke script, rollback.

## Needs owner approval
- Running `scripts/release-iris.sh` or `release-iris-x64.sh` (they publish to testers and kill his running Iris).
- Rollback; changing the publish URL, signing identity or entitlements; bumping Electron major.
- Adding a usage description or entitlement (each is a new permission prompt for every tester).
