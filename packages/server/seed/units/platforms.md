# Platforms unit

The Platforms unit owns each shippable surface: the Mac app on Apple Silicon and Intel, Windows, iPhone and iPad, Android, and, as a chapter, the server. Its charters are `desktop-mac`, `windows` and `mobile`; Rohan holds desktop-mac and windows, Tara holds mobile, and Kabir sits here as the server chapter member so that packaging, updates, push and TestFlight decisions are made with the server in the room.

## What it is for

- Turning the capabilities into installable, updatable builds: the notarised Mac dmg and self-updater (0.2.15), the Intel build (0.2.4, to be brought level), the Windows NSIS installer (0.2.10, untested on hardware), the iOS app on TestFlight and the Android app (0.3.0).
- The definition's platform order: Mac + iPhone first, Windows + Android in Phase 2; rendering, behaviour and memory that do not assume macOS.
- The phone side of the seeded feature, the phone→Mac errand flow, which crosses mobile, server and the Mac.

## How the charters coordinate

- desktop-mac and windows share `desktop/package.json`, `services/agent-svc/iris-agent.spec` and `scripts/manifest_merge.py`; the manifest is published only from the Mac, one platform key at a time, under the single release lock.
- mobile and the server chapter share the phone contract (`/v1/chat/messages`, `/v1/errands*`, `/v1/shelf`, `/v1/devices`, `/v1/link`), APNs/FCM and `asc.py`; iOS reuses the contract proven on Android.
- windows works alongside a human teammate (Yash); nothing Windows-specific is changed without coordinating, and their work is never overwritten.
- A capability change that needs a platform-specific seam (`experts/platform_cmd.py` Darwin/Win32/Null) is a PR into the capability's repo, reviewed by that lead, with the platform lead consulted.

## Shared rules

- Build here only: Mac and iOS builds run on this Mac, at most 1–2 heavy builds at a time; the Mac is kept awake with `caffeinate -dimsu`.
- Every release, deploy, TestFlight or store upload is an owner-approved Inbox item, prepared by QA; `scripts/release-iris.sh` kills the owner's installed Iris and does not relaunch it, so the timing is agreed first.
- PyInstaller cannot cross-compile: arm64 in `.venv`, x64 under `arch -x86_64` with `.venv-x64`, Windows on a Windows machine or the CI probe.
- Secrets stay by name: `~/iris-ops/state/infra.env`, `~/iris-ops/mobile/`, the signing team in `project.yml`; device ids and tokens are read by `dev-run.sh`, never pasted into reports.
- "Not verified on <hardware>" is stated whenever a build was only launched on the developer's Mac or a CI runner.

## Who leads

Rohan leads the unit (desktop-mac and windows) and is the escalation point for Tara; Kabir's server work escalates through the Capabilities unit. Rohan goes to the Chief of Staff.
