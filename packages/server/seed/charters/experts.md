---
id: experts
title: Experts
axis: capability
version: 1
mission: "Own every deterministic action Iris takes on a device and the routing that reaches it, so an action runs before she claims it and she never says \"done\" about something that did not happen."
---
## Mission and scope
- Own device actions and routing: the two-stage router, action detection, argument grounding, the dispatch policy, the task orchestrator, and every expert module.
- Own the no-lie guard and act-then-acknowledge: a deterministic expert runs first and speaks its real result; an unverified mutation is hedged; a failure is admitted.
- Own the info expert (cloud answers), phone↔Mac errands on the Mac side, and workspace documents made by the cloud agent.
- Out of scope: the Speaker's words and the delivery gate (conversation); the cloud agent's own loop and tiers (server); the phone apps' side of errands (mobile).

## Owned things
- `services/agent-svc/router.py`, `task_orchestrator.py`, `dispatch_policy.py`, `action_detect.py`, `arg_ground.py`, `workflows.py`, `task_registry.py`, `agent_manager.py`, `agent_parse.py`, `send_guard.py`, `recent_actions.py`, `directives.py`, `speculate.py`, `cc_mode.py`, `watchdog.py`, `phone.py`, `cloud_client.py`, `workspace.py`, `info_answer.py`, `pocket.py`, `media.py`, `context/` (screen and window context, OCR helper), `mcp.json`.
- `services/agent-svc/experts/`: `base.py`, `platform_cmd.py` (Darwin, Win32, Null seams), `sysexec.py`, `browser.py`, `whatsapp.py`, `mail.py`, `clipboard.py`, `pocket.py`, `device.py`, `media.py`, `terminal.py`, `apps.py`, `timeparse.py`, `timer.py`, `reminders.py`, `calendar.py`, `info.py`, `workspace.py` (`memory.py` belongs to memory).
- Docs: `docs/experts/browser.md`, `comms.md`, `core.md`, `device-media.md`, `info.md`, `terminal-apps.md`, `time-planning.md`; `docs/HLD-delegation.md`, `docs/HLD-lie-engine.md`, `docs/HLD-experts.md`, `docs/PRODUCT-experts.md`, `docs/HLD-whatsapp.md`, `docs/PRODUCT-whatsapp.md`, `docs/HLD-mac-workspace.md`.
- Evals (not collected by pytest; they call a model): `tests/eval_core.py` (43), `eval_browser.py` (46), `eval_comms.py`, `eval_device_media.py` (44 + 14 held out), `eval_terminal_apps.py` (42), `eval_time_planning.py` (45), with fixtures under `tests/fixtures/eval_*_{before,after}.json`.
- Requirements: the Utility family (system actions, pockets and caught downloads, communication, reminders/alarms/focus/deadlines) and the phone→Mac errand flow.
- Metrics: routed / args / happened / honest per catalogue (core 43/43 detect, 42/43 honest; browser 46/46; device-media 44/44; terminal-apps 40/42 all four); declined-request rate; verified errand completion rate.

## Interfaces
- Publishes: the expert contract `Fn(speaks, latency, mutates, risk)`, `Param(ground, choices, positional, ask)`, `Result(ok, message, verified: Optional[bool], data)`; `dispatch_policy.result_line` / `speaks_line`; task registry events `task_decided`, `task_done`, `task_failed`; `{kind:"clarify", question}` from grounding; the expert catalogue the router renders.
- Consumes: `[[DELEGATE]]` turns from the Speaker; `POST /v1/chat/messages` with `source="mac"` (info and workspace, chat tier); `GET /v1/errands/next` long-poll and `POST /v1/errands/{id}/status` (phone errands); `memory_lookup` entity lookups; the ROUTER context block from `context/`.

## Rules and traps
- Act then acknowledge. `dispatch_policy.latency`: fast (every deterministic expert) runs first and then speaks `result_line`; past `IRIS_FAST_ACK_S` (2.5 s) she says "On it." and the real line follows; slow (`media.play`, `workspace.make`, unknown) keeps the optimistic ack, the owner's explicit exception (`docs/experts/core.md` B2).
- `Result.verified`: `False` is never stated as success; `None` on a state-changing function is hedged ("Should be done — …"); `True` or read-only is stated plainly; failures give an apology plus a usable reason (core.md B4).
- The no-lie guard `app._nolie_verdict`: an animation satisfies a turn only when the user asked for one; `DONE_CLAIMS` includes "cleaned up", "muted", "paused" and about 35 more (core.md B1).
- Argument grounding: a string arg must be grounded in the user's words (last 3 turns, wake word stripped) or the on-screen context; a positional ask filled with a name is rejected; a rejected pick becomes a clarifying question and nothing runs (core.md B3).
- Answer or screen: a question that needs a fresh fact goes to `info.answer` (cloud chat tier, about $0.025 and 7 s warm, 12 s budget, 90 s give-up, then an offer of a browser search); `browser.search_web` only on an explicit see/open verb; the router's `_finish` backstop rewrites the pick (`HLD-delegation.md` §2). Only the question text leaves the Mac, never screen text, tabs, clipboard or files.
- WhatsApp: staged send then confirm; `IRIS_WA_ALLOWLIST` is checked in `_press_send()` and fails closed when garbled; during testing WhatsApp may message only the owner's own number; "me" is the Mac's own number, never the module default (`docs/experts/comms.md` A, C).
- Email is drafts only: `platform_cmd.mail_osa` strips string literals and refuses any script containing `send`; `mail.draft` never says "sent" (comms.md B).
- A judgement word about tabs ("unused", "clean up", "tidy") never closes; it proposes `tidy_tabs` and waits for a yes (browser.md BUG-1). Router JSON lists and numbers must be coerced (BUG-2). Tab functions speak their own result (BUG-3).
- Terminal: AppleScript `windows` is front-to-back, not tab-bar order; ⌘1…⌘8 select tabs left to right, ⌘9 the last; a busy tab's `close` returns success and leaves a "terminate?" sheet; `if name of first application process whose frontmost is true is not "Terminal"` is a precedence bug that fails with -1700 and must be parenthesised, pinned by a regression test (`docs/experts/terminal-apps.md` §0).
- Calendar writes are staged and read back by uid before she claims them; reads use EventKit through JXA (77 ms) not Calendar.app AppleScript (10 s); macOS 27 refuses to auto-launch Calendar so the seam opens it hidden first (`time-planning.md` 0.4). Timers persist to `IRIS_TIMERS_FILE` and survive sleep; every reply states the resolved time with AM/PM.
- Media controls go to the player that is actually playing and are read back before she speaks; music ducks under her voice; YouTube downloads need `yt_dlp_ejs/core.min.js` in the bundle (device-media.md).
- Evals cost money and vary run to run (Haiku router); never read the owner's real tabs, drive his Music, Chrome or Terminal tabs, or send anything from his accounts; the fakes exist for that (browser.md, device-media.md "what the harness does NOT prove").
- Workflows chain experts with one confirmation: `email_page` (current page → `mail.draft`), `whatsapp_page`, `remind_page`, `copy_page_link`, `tidy_tabs` (browser and terminal, one yes); `workflows.offer_single` stages a single step behind the yes/no intercept with risk `"offer"` (core.md §1, `HLD-delegation.md` §5.4).
- `experts.pocket.resolve(which)` is the one resolver behind paste, WhatsApp and mail: "the doc you made" is the workspace's newest document, pointing words are the newest item, a bare "file" is the newest file (comms.md D). A file is uploaded only when it was dropped on her, never guessed.
- Anything no expert covers is refused for every user but the owner today (the fallback spawns Claude Code, which exists only on the dev machine); the agent loop on the Claude API (Road move 3) replaces it, with `verify` beside every `run`, shortlisted tools (the router's top two or three, about 400 tokens instead of 2,100 for all 54 functions), prompt caching, small model first, and a hard stop.
- Recurring fallbacks become new experts so the long tail shrinks instead of being paid for each time (Road risks).

## Definition of done
- `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests` green with the count (2,261 passed, 1 skipped, 3 xfailed on 27 Sep; about 2,300 today per the brief).
- The relevant catalogue eval re-run with its before/after fixture and the four columns reported, with the run's cost (core AFTER ×2 cost $0.25).
- A live check of the changed expert on this Mac against things the agent created itself (its own Terminal tabs, an "Iris Test" calendar), with the owner's state restored.
- Every bug has an RCA with `agent.log` timestamps, a control run on the old code, and a test that failed first.
- "Not verified" must name real-app paths only checked against a fake (Spotify, Apple Music, YouTube scripts; `claude -p` fallback).

## How to build, test and ship
- Tests: `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests` (`pytest.ini`: `testpaths = tests`).
- Evals: `../../.venv/bin/python tests/eval_core.py --only "info|search|weather"`, `tests/eval_browser.py`, `tests/eval_comms.py --root <old tree>`, `tests/eval_device_media.py`, `tests/eval_terminal_apps.py`, `tests/eval_time_planning.py`; gateway on port 9102 from `Procfile.desktop`.
- Ship: rides the desktop release (`scripts/release-iris.sh`, desktop-mac) after an approved Inbox item; a server note change (`MAC_NOTE` in `services/cloud-agent/agent.py`) ships through `scripts/deploy-agent.sh` (server).

## Coordinate with
- conversation: `speaks` functions, ack shapes, the delivery gate, intercepts (yes/no, "send", pet hide/show).
- server: the chat tier, `/v1/errands*`, the workspace jobs, the tool-use endpoint for the agent loop.
- memory: `experts/memory.py`, `memory_lookup` in the router, outcome events from `task_registry.on_finish`.
- mobile: the errand contract both phones speak.
- windows: `platform_cmd.py` Win32 seams and `CAP_MAIL`-style capability refusals.
- character: pocket badge and progress reactions.

## Needs owner approval
- Any send path beyond the owner's own number; any change to the WhatsApp allowlist rule or the never-send mail guard.
- Running evals that drive real apps on his Mac or spend beyond the daily cap.
- Removing the Claude Code fallback from the product (Road Phase 1).
