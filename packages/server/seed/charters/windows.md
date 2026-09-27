---
id: windows
title: Windows
axis: platform
version: 1
mission: "Bring Iris on Windows from \"it builds\" to \"a Windows user completes the same daily errands as a Mac user\", alongside the human teammate who develops it."
---
## Mission and scope
- Own the Windows build of the desktop app: the PowerShell scripts, the Windows Procfile, the CI probe, the Win32 seams in the agent, and the NSIS installer with its `latest.yml` for auto-update.
- Own the Windows LLD the owner asked for: the design document that records how each Mac-only mechanism (AppleScript seams, sox, Vision OCR, notarisation) maps to Windows, written before code.
- Own the road to Phase 2 (Windows + Android) as far as the Windows half goes: validation on real hardware, then the India beta on Windows.
- Out of scope: the shared Electron app and agent code paths (desktop-mac owns packaging; capability charters own behaviour); the Mac release pipeline.

## Owned things
- `Procfile.windows`, `scripts/release-iris-win.ps1`, `scripts/build-agent.ps1`, `scripts/run-desktop.ps1`, `scripts/make-win-icon.ps1`, `.github/workflows/windows-build.yml`, the `.venv-win` layout.
- The Windows dependency wall in `services/agent-svc/iris-agent.spec` (`psutil`, the `winrt.windows.*` namespaces for OCR and storage, guarded by platform).
- The `Win32` seam class in `services/agent-svc/experts/platform_cmd.py` (`browser_*`, `term_*`, app, mail and contacts methods) and every `CAP_*` refusal that says in one sentence what Windows cannot do yet (for example `CAP_MAIL`: the mail expert refuses on Windows).
- The `win` and `nsis` blocks in `desktop/package.json` (target `nsis` x64, artifact `Iris-${version}-win-${arch}.${ext}`, one-click, per-user, desktop and start-menu shortcuts).
- Shippable: Windows 0.2.10, built and published, not tested on real hardware (Road doc, 25 Sep).
- The Windows LLD doc (requested by the owner; not present in `docs/` as of 27 Sep; to be written under `docs/` following the HLD → LLD → TDD order).
- The Windows dev stack: `Procfile.windows` runs `llm` (9102), `judgement` (9101), `cover` (9108), `emotion` (9109), `voice` (9107), `orchestrator` (8000) and `agent` (9110, `VOICE_IO=renderer`) under honcho with `cmd.exe` semantics, mirroring `Procfile.desktop` line for line.
- The CI artifact checks: an `.exe` installer exists, `latest.yml` exists, `iris-agent.exe` is inside the app; the agent answered `/healthz` on 127.0.0.1:9110 within 30 s.
- Metrics: CI probe green/red; errand parity count against the Mac catalogue; real-hardware issues open.

## Interfaces
- Publishes: a signed NSIS installer plus `latest.yml` on disk and the manifest fragment to publish from the Mac (`release-iris-win.ps1` prints it); the `Win32` seam behaviour the experts rely on.
- Consumes: the same agent (`services/agent-svc`) and app (`desktop/`) as the Mac; `latest.json` merging via `scripts/manifest_merge.py` (desktop-mac); the CI artifact `iris-windows-unsigned` (14-day retention).

## Rules and traps
- A human teammate (Yash, per the Workplace brief §4) also develops Windows. Coordinate before touching anything Windows-specific; never overwrite their work; pull and read their branch first; changes go through a PR they review.
- Every PowerShell script and `Procfile.windows` is marked UNVERIFIED: written on macOS, never executed on Windows. Treat each as a hypothesis until a run on real hardware says otherwise, and keep the marker until then.
- The CI workflow answers only "does Iris build on Windows at all" and "does the bundled agent serve `/healthz`". It cannot answer whether the transparent character window renders (Electron #40515, machine-dependent GPU) or whether echo cancellation works (#47043, no mic or speaker on a runner). A green run is not a tested build.
- PyInstaller cannot cross-compile; the Windows agent must be built on Windows (`build-agent.ps1`), output `services\agent-svc\dist\iris-agent\iris-agent.exe` so `extraResources` picks it up unchanged.
- `Procfile.windows` runs under `cmd.exe`: `set VAR=value&&` with no space before `&&` (a trailing space becomes part of the value and the port fails to parse); `VAR=value cmd` does not set anything; the interpreter is `.venv-win\Scripts\python.exe`.
- The agent is pinned to `VOICE_IO=renderer` on Windows because `sox` does not exist there; the Electron side must agree (`$env:VOICE_IO='renderer'` in dev) or the agent waits for mic frames from a window that was never created.
- Name the electron-builder target explicitly (`npx electron-builder --win nsis --x64 --publish never`); a bare `--x64` was silently ignored on macOS because `package.json` pins the arch.
- `latest.yml` is what electron-updater fetches on Windows; without it there is no auto-update even though the installer exists.
- The Windows release script deliberately stops at a signed installer on disk and does not upload; publishing `latest.json` happens from the Mac where `~/iris-ops` lives. Do not merge the two scripts.
- The Mac-only mechanisms have no Windows equivalent yet: mail drafts (`CAP_MAIL`), Calendar via EventKit, Vision OCR (winrt OCR instead), Terminal tab control, notarisation (Authenticode optional in the script).
- Definition rules apply on Windows too: hide from capture on screen share, still while typing, never auto-send.
- Windows is the definition's Phase 2 (60% of US students and 76% of Indian desktops run it); the Road doc's Phase 4 gate is "a Windows user and an Android user complete the same daily errands as a Mac user" (extract §A rollout, §D).
- Keep the arm64 Mac path untouched when accommodating Windows; the Mac release script is deliberately not shared (`release-iris-win.ps1` header).

## Definition of done
- CI `windows-build` green on the change, with the artifact's installer size, `latest.yml` and "agent: bundled" lines quoted.
- On real Windows hardware (the teammate's machine or a VM with a GPU): the installer runs, the character window renders transparent, the agent serves `/healthz`, one voice turn round-trips, and the daily errand catalogue result is stated against the Mac's (`tests/eval_*` rows that apply).
- `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests` on the Mac still green for any seam change (the Null and Darwin seams must not regress).
- "Not verified" must say "not run on Windows hardware" whenever that is true, and keep the UNVERIFIED markers.
- The Windows LLD is done when it lists every Mac-only mechanism with its Windows counterpart or an honest "no equivalent", and the owner has read it before code starts.

## How to build, test and ship
- CI probe: push to `desktop/**`, `services/agent-svc/**` or the workflow, or `workflow_dispatch`; runner `windows-latest`, Python 3.12, Node 22.
- On Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-agent.ps1`; `scripts\run-desktop.ps1` for the dev stack (`main.js` calls it when nothing answers on :8000); `scripts\release-iris-win.ps1 [version]` for the installer.
- Publish: the manifest fragment is merged into `latest.json` from the Mac by desktop-mac after an approved Inbox item; upload of the installer to the bucket likewise.

## Coordinate with
- desktop-mac: `package.json` build blocks, `iris-agent.spec`, manifest merge, version numbering (Windows is on 0.2.10 while the Mac is on 0.2.15).
- experts: `platform_cmd.py` seams and capability refusals; which experts can exist on Windows.
- character: transparent window rendering and GPU issues.
- conversation: renderer-only audio on Windows, AEC verification.
- product-and-business: Phase 2 timing and the India beta shape.
- qa-release: real-hardware verification and release readiness.
- beta-ops: the first Windows testers' logs (the shipper and `/admin/logs` are platform-neutral; the Electron crash reporter is not yet built anywhere).

## Needs owner approval
- Publishing a Windows build (manifest merge, upload); any Authenticode signing certificate.
- Any change that alters the human teammate's branch or workflow.
- Spend on a Windows VM or hardware for verification.
