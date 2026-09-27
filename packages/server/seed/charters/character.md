---
id: character
title: Character
axis: capability
version: 1
mission: "Own Iris as a visible, alive, quiet-by-default character on screen, with a body that never costs a model call and never lies about what she is doing."
---
## Mission and scope
- Own presence, expressions, movement, touch, lip-sync, moods, props, the 3D stage bundle, "quiet by default" behaviours and proactive lines, and the product and design spec of the character (the ten expressions, the touch map, hats and colour variants).
- Own the body half of the responsiveness contract: micro-motion, thinking and attending gestures, the thought bubble, the turn-yield cue, and reactions cued by her own words as audio plays.
- Out of scope: the audio pipeline and the decision of what she says (conversation); routing and actions (experts); the Electron packaging of the window (desktop-mac).

## Owned things
- `desktop/character/`: `character.js`, `presence.js`, `conversation.js` (pure body-language module), `driver.js`, `motions.js`, `props.js`, `reactions.js`, `sequencer.js`, `springs.js`, `pose.js`, `beat.js`, `dance.js`, `mood.js`, `vrm-adapter.js`, `vrm-profile.js`, `iris-adapter.js`, `iris-model.js`, `stage.js`, `stage.html`, `stage-preload.js`, `preview.html`, `models/`, `SLOTS.md`; `stage.bundle.js` is a build product.
- `desktop/pet/` (the 2D pet: `pet.html`, `pet.css`, `pet.js`, `behavior.js`, `preload.js`), `desktop/hud/` (the retired edge HUD), `desktop/walk.js`, the character window parts of `desktop/main.js`, the `lip*.png` frames.
- Agent side: `services/agent-svc/expression.py`, `character_spec.py`, `proactive_trigger.py`, `screen_timeline.py`, `jokes.py`, the `_PET_HIDE` / `_PET_SHOW` intercept in `app.py`, `POST /v1/pet/proactive`.
- Docs: `docs/PRODUCT-character.md`, `docs/HLD-emotion-engine.md`, `docs/HLD-desktop*.md`, `docs/PRODUCT-desktop*.md`, `desktop/character/SLOTS.md`.
- Tests: `character/*.test.js` (`character`, `vrm-profile`, `vrm-adapter`, `sequencer`, `iris-adapter`, `presence`, `conversation`, `motion`, `reactions`, `props`), `desktop/tests/behavior.test.js`, `walk-beat.test.js`, `ack-heartbeat.test.js`; `services/agent-svc/test_pet_proactive.py`, `test_proactive_trigger.py`, `test_screen_timeline.py`, `tests/test_pet_intercept.py`.
- Requirements: the Character family (expressions, movement, touch, voice and sound, personality and chat, context reactions) and the Looks group of the checklist; all ten expressions, the touch map, pockets, sounds, weather and umbrella are built (extract §D).
- The mood system (content, happy, excited, curious, thinking, listening, surprised, concerned, sleepy) with transient flashes and emotes (heart, spark, ?, zzz, sweat); the aliveness engine's idle activities (wander, look, bounce, wag, stretch, spin, yawn, peek-at-screen, nap) with weights and cooldowns (`docs/PRODUCT-character.md` v2).
- The slot vocabulary: `root`, `spine`, `head`, `gazeL`/`gazeR`, `primaryHand`/`secondaryHand`, `primaryArm`/`secondaryArm`, `locomotorL`/`locomotorR`, `tail`, `accessory*`, fingers `fingerL.<digit>.<joint>` evaluated only above a size threshold; expressions `neutral joy anger sorrow fun surprised blink blinkL blinkR` and visemes `aa ih ou ee oh`.
- Real lip-sync: `audio.js` taps the WebAudio TTS with an AnalyserNode, RMS goes over IPC (`tts:level`) and the mouth opens to her actual voice, with a procedural fallback when there is no signal.
- Metrics: `[stage] motion:` lines per pending turn; hide and mute usage (presence-fatigue signal); proactive lines answered vs ignored.

## Interfaces
- Publishes: `Presence` states and `setPending`; `Conversation` actions (`nod`, THINK gestures, cues, turn-yield); the slot contract for any character model; `{type:'pet', action}` bus handling; the stage as a web view packagable for phones (A6 portable character).
- Consumes: bus events from conversation (`hearing_text`, `turn_end_guess`, `heard`, `attending`, `unsure`, `saying`, `speaking`, `filler`, `awaiting`, `delivered`); TTS level over IPC (`tts:level`); `expression.reaction_to`; the SSE stream `/v1/agents/events`.

## Rules and traps
- Motion is expressed against slots, never bone names; a character missing a slot substitutes a fallback or reports the motion unavailable, never silently does nothing; expressions are named art, not rotated bones; motions consult declared capabilities (`SLOTS.md`).
- `stage.bundle.js` is the character's entire code and a build product; from 0.2.2 the 3D character is the default, so rebuild it before any run or ship (`npm run build:stage`, `prestart`, `predist`; `scripts/release-iris.sh` step 2/6).
- Character never costs a model call; timers, reminders and alarms run as local code (Road doc, extract §D). Proactive lines are the one gated exception (`POST /v1/pet/proactive`, rate-limited, not while speaking, engaged or busy).
- The body is the only layer that can be relied on for the whole pending turn: micro-motion every U(0.24, 0.44) s (0.44 s plus one 60 fps frame stays under 0.5 s), no blink within 1.6 s of the last, eye flicks alternate side so travel is at least 0.14 (`docs/HLD-responsiveness.md` §0 and addendum).
- Idle picker, halo and wandering eyes must not run while a turn is pending (RCA A); the thought bubble goes up on `heard` and stays until the answer, and comes down after speech that was not for her.
- Never guilt; invisible when it matters (hides in meetings and screen shares, still while you type); late-night doze is visual only and any input wakes her at once; drag out starts only from the pocket badge, never from her body; the crown becomes the default hat (extract §C collisions).
- Auto-hide on screen share is the one non-negotiable: hide from capture by default with a developer switch for tests and an "appear in recordings" setting; verify on Zoom, Meet and Teams; if a capture path ignores it, detect the share and hide the window (extract §C Wave 1, risks).
- Behaviour lock B1: one "stay still" flag that walker, props, reactions and proactive lines all respect (typing, focus sessions, meetings, share).
- Quiet by default (D1) and content sensors (D3) are owner decisions; proactive lines ground on app and dwell only once D3 lands; raw screen text is never stored.
- Verify visual work by measuring: pixel-measured with a control (after-turn frames), never from one screenshot; the 27 Sep bubble finding was corrected by a test on old and new code.
- "Hide" / "come back" is a deterministic Speaker intercept (`_PET_HIDE` / `_PET_SHOW` phrase sets, Hinglish included) that publishes `{type:'pet', action}` and never routes to the LLM; ⌘⇧I toggles the tuck (`PRODUCT-character.md` LLD).
- The 2D pet (`desktop/pet`) is not the default; the 3D stage is. Do not spend on the 2D path without an owner ask.
- The edge HUD (`desktop/hud`) is retired; the character's bubble carries captions, replies, tool progress and cc-mode. Do not recreate a sidebar.

## Definition of done
- `cd desktop && npm test` green (state the count of test files run) and `node character/<module>.test.js` for each touched module; `../../.venv/bin/python -m pytest -q tests` in `services/agent-svc` for any agent-side change.
- A live check on this Mac: `[stage] motion:` logged at least every 250 ms while pending and `harness/ack_gaps.py --strict --no-dots` passing; screenshots measured against a control for any visual claim.
- For hide-on-share: a real Zoom, Meet or Teams share on this Mac showing she is absent from the capture; otherwise "not verified on <app>".
- Every fix has an RCA and a regression test that failed first; all changed desktop JS passes `node --check`.
- "Not verified" must name any expression, motion or hide behaviour only seen in `preview.html` and not in the packaged stage.

## How to build, test and ship
- `cd desktop && npm run build:stage` (esbuild `character/stage.js` → `character/stage.bundle.js`); `npm start` runs it via `prestart`; `npm run dev` for `--dev`.
- `cd desktop && npm test`; single suites with `node character/presence.test.js` and so on; `desktop/character/preview.html` for a quick visual.
- Ship: part of the desktop release `scripts/release-iris.sh <ver>` (desktop-mac runs it after an approved Inbox item); the website's 3D bundle is content-hashed and deployed by `scripts/deploy-web.sh` (server).

## Coordinate with
- conversation: every bus event, the pending contract, gesture cadence, filler-body coupling.
- desktop-mac: window creation, transparency, always-on-top, the packaged bundle, Electron GPU bugs.
- mobile: A6 portable character (same stage in the iPad talk mode and the Android bubble).
- product-and-business: expressions art direction (still open), quiet by default, hats and variants.
- experts: pocket badge, drag-out, prop reactions to task progress.

## Needs owner approval
- Changing the default character (3D vs 2D) or the default hide/quiet behaviour.
- Any proactive-line trigger that reads content rather than metadata.
- Releases carrying character changes.
