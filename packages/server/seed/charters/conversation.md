---
id: conversation
title: Conversation
axis: capability
version: 1
mission: "Own the voice loop end to end so that from the moment the user stops talking she is never silent or still for more than 500 ms and only the Speaker ever speaks."
---
## Mission and scope
- Own STT and TTS, the wake word and the wake gate, the Speaker, the responsiveness ladder, the single-speaker delivery gate, echo and AEC, fillers, the speech-vs-popup split and streamed replies.
- The hard contract: from speech end until her answer is audible (or she decides the turn was not for her) the user sees or hears something new at least every 500 ms, randomised (`docs/HLD-responsiveness.md` §0, 27 Sep).
- The other contract: one Speaker owns every word in both directions; orchestrator and agents produce state and data, never speech (`docs/HLD-single-speaker.md` §1, `docs/PRODUCT-single-speaker.md`).
- Out of scope: what an expert does once routed (experts); the body that performs the gestures (character owns `desktop/character`, this charter owns the events it consumes); the cloud streaming route's deployment (server).

## Owned things
- `services/agent-svc/speaker.py`, `speaker_gate.py`, `speech.py`, `speech_acts.py`, `stt_stream.py`, `responsiveness.py`, `reply_stream.py`, `state_intent.py`, `email_speech.py`, `wake.py`, `wake_listen.py`, `voice_native.py`, `vocalize.py`, `vocabulary.py`, `svclog.py` (the log shipper, because it once froze the Speaker thread), the `speaker_turn` / `_cover_silence` / `_dispatch_command` / `_on_stt_final` parts of `app.py`.
- `desktop/renderer/audio.js`, `audio-preload.js`, `capture-worklet.js`, `level-worklet.js`, `pcm.js`, `speaker.js` (mic capture, WebRTC AEC, TTS playback and level).
- `harness/`: `ack_gaps.py` (the 500 ms analyser), `test_ack_gaps.py`, `live_turn.py`, `live_convo.py`, `live_bargein.py`, `live_matrix.sh`, `speech.py`, `transcriber.py`, `voice_service.py`; `scripts/echo_selftest.py`, `scripts/stt_harness.py`.
- Docs: `docs/HLD-responsiveness.md`, `docs/HLD-single-speaker.md`, `docs/HLD-live-voice.md`, `docs/HLD-voice-expressivity.md`, `docs/PRODUCT-echo.md`, `docs/PRODUCT-single-speaker.md`, `docs/PRODUCT-context-wakegate.md`, `docs/PRODUCT-contacts-stt.md`, `docs/RCA-voice-first-turn-stale-context.md`.
- Bus events: `turn_end_guess`, `hearing_text`, `heard`, `attending`, `unsure`, `thinking`, `saying {text}`, `speaking {on, text}`, `filler {stage}`, `awaiting {id}` / `delivered`.
- Metrics: longest pending-turn gap (median 0.27 s after the 27 Sep fix, 0 turns over 0.5 s target); speech-end to first audio; filler fire spread; discard rate (56% at 0.2.7); STT seconds per wall-clock minute.

## Interfaces
- Publishes: the bus events above, consumed by `desktop/character/driver.js`; `Conversation.pending()` states (`listening` in guess/attending, `thinking` once `heard`); the Speaker's `[[DELEGATE]]` / `[[SEE]]` directives to the orchestrator; the delivery gate's `on_decided` / `on_done` verdicts.
- Consumes: `task_registry` done/failed events (experts); `/v1/stt/stream`, `/v1/tts`, `/v1/tts/stream`, `/v1/llm`, `/v1/llm/stream` from server; `memory_client.recall` within its 80 ms budget (memory); `expression.reaction_to` and `Presence.setPending` on the desktop (character).

## Rules and traps
- The 500 ms contract is enforced by `harness/ack_gaps.py --strict` (exit 1 on any pending gap over 0.5 s). Body layers: micro-motion every U(0.24, 0.44) s, big gestures every U(1.2, 2.2) s never the same twice, bubble dots only once the turn is confirmed hers; voice rungs filler U(0.8–1.2) s, still U(4–6) s, hand-off U(8.5–10) s, each optional and dropped if the mouth is busy (`HLD-responsiveness.md` §0, §3, LLD A).
- Randomise form and jitter timing within the windows; never add delay past a window's upper bound; never more than one filler per stage; never repeat a line or gesture back to back.
- Attending promises nothing: no bubble, no voice; a visual "considering" may be withdrawn, a spoken filler may not (round 8).
- A pending turn is never shown as idle; her own chime or filler must not flip presence to speaking then idle (`Presence.setPending`, RCA A).
- `svclog.CloudLogHandler.emit()` only enqueues; the flusher thread ships. A synchronous POST there stalled the Speaker thread up to 10 s (RCA D1).
- Rungs are keyed to the turn the Speaker is answering (`_OWED`), not the mic-gate turn id (RCA D2).
- Act first, then acknowledge: "Let me find out." is the only pre-answer line for a lookup; never "Done" for a question (`docs/HLD-delegation.md` §3).
- Only the executor voices; `task_orchestrator.dispatch` emits no `reply`; tests assert it (`HLD-single-speaker.md` §7).
- Dev stack has latency parity with packaged builds: `TTS_STREAM=1 SPEAKER_STREAM=1 ELEVEN_TTS_MODEL=eleven_turbo_v2_5` in `Procfile.desktop`; `OPENER` per the LLD. Packaged builds force `VOICE_IO=renderer` on both halves (`desktop/auth.js`).
- Streamed replies on the cloud path need `POST /v1/llm/stream`; the client falls back cleanly when it 404s; deployment belongs to server and ships when the owner says so.
- Echo: with `VOICE_IO=renderer` WebRTC AEC cancels her own TTS and music; `VOICE_IO=native` (sox + afplay, no AEC) restores the old path exactly; other apps' audio is not cancelled (`PRODUCT-echo.md`).
- Wake gate: when an expert awaits a short reply (staged WhatsApp draft, a "did you mean" pick) a bare "send" / "yes" / "cancel" / a number must be honoured, not dropped as too-short; heard speech including talk-over under AEC is kept as context (`PRODUCT-context-wakegate.md`).
- STT defaults `STT_LANGUAGE=en` (Deepgram `multi` hallucinated Spanish on Indian-accented speech); contact names are keyterm-boosted (`ISSUE-LOG.md`).
- The mic gate streams whenever sound crosses the RMS threshold, so `stt_seconds` bills ambient noise (about two thirds of wall-clock in active use). Running out gives "I've run out of listening time for today." (`app.py`) and a deaf app; a stricter gate is the cheaper lever (`ISSUE-LOG.md`, 21 Sep).
- Judge the speech, never the decision; when a check and the product disagree, suspect the check first (`ISSUE-LOG.md`). Unit tests cannot catch voice timing bugs; run real speech before claiming a fix.
- Quiet by default is an open owner decision (D1/D2). Do not change the default speaking or listening mode without the Inbox decision; build the mode layer (A1) so Quiet, Talk and Hands-free are settings of one policy object.

## Definition of done
- `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests` green with the count stated (2,261 passed, 1 skipped, 3 xfailed on 27 Sep per `HLD-delegation.md` §8); `python -m pytest -q harness/test_ack_gaps.py`; `cd desktop && npm test` (includes `tests/ack-heartbeat.test.js`, `character/conversation.test.js`).
- A live run on this Mac: `python -m harness.ack_gaps <iris-dev.log> --strict` passes on every voiced turn, with `--no-dots` too; the longest gaps reported per turn.
- A real spoken turn through `harness/live_turn.py` or `live_convo.py` with the shipped binary, judged on what she said.
- Every fix carries an RCA with log evidence, a control run on the old code, and a regression test that failed first.
- "Not verified" must name any of: the shipped voice app (if only the dev stack was run), the packaged build's flags, the cloud stream route.

## How to build, test and ship
- Dev stack: `honcho start -f Procfile.desktop` (agent on port 9110), `cd desktop && npm start`.
- Tests: `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests`; `cd desktop && npm test`.
- Live: `python -m harness.ack_gaps ~/…/iris-dev.log --since HH:MM --strict`; `harness/live_matrix.sh`; `scripts/echo_selftest.py` for the echo baseline.
- Ship: rides the desktop release (`scripts/release-iris.sh`, desktop-mac) or the API deploy (`scripts/deploy-api.sh`, server); both need an approved Inbox item. Never restart or touch the owner's running Iris without saying so.

## Coordinate with
- character: every body event and the pending-state contract; gesture cadence changes need both sides.
- experts: `dispatch_policy` ack shapes, `speaks` functions, the delivery gate's task lifecycle.
- server: `/v1/llm/stream`, `/v1/tts/stream`, STT quota and the listening budget.
- memory: the 80 ms recall inside the turn; the MEMORY block placement in the Speaker prompt.
- qa-release: live verification of any voice change before it counts.
- product-and-business: D1/D2 and the mode layer.

## Needs owner approval
- Changing the default listening or speaking mode (push-to-talk, quiet by default).
- Any relaxation of the 500 ms contract or the filler windows.
- Deploying `/v1/llm/stream`; any release carrying voice changes.
