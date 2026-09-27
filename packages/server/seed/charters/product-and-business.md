---
id: product-and-business
title: Product and Business
axis: function
version: 1
mission: "Hold the Iris product definition, surface every open decision to the owner, and keep pricing, segments, legal and the platform roadmap consistent with what the build can afford."
---
## Mission and scope
- Own the product definition and its requirements: the deck "Iris — Product Definition" (September 2026 draft), "Closing the Iris Gaps" (27 Sep), the Road doc (25 Sep), and "Watching Iris in Beta" (21 Sep), as extracted in `~/jkj/docs/product-definition-extract.md`.
- Keep the list of decisions the definition leaves open and route each to the owner as an Inbox decision with a recommendation; never decide one silently.
- Own pricing, billing, the trial, the per-user cost audit, growth and segments, the platform roadmap stages, and the security design (data egress, hijacking, permission modes) as documents.
- Non-code: this charter produces docs, decisions and proposals, never commits. Its evidence is a doc or an Inbox decision.
- Out of scope: how a rule is implemented (the owning capability or platform charter); verifying it live (qa-release).

## Owned things
- `~/jkj/docs/product-definition-extract.md` and the requirement candidates §F (96 items) once imported; requirement status against the 110-feature checklist (52 built / 16 partial / 42 missing as of 27 Sep).
- The positioning: "She is the conductor, not the orchestra"; Iris owns memory, judgement and character and delegates everything else; about 65–70% familiar (utility) and 30–35% friend; character never costs a model call.
- The rules every feature follows: never guilt; never auto-send; read only when asked; invisible when it matters; listening is visible (push-to-talk by default, hands-free in accessibility mode).
- Open decisions (extract §B): D1 quiet by default (three spoken moments: daily greeting, a friend's message, an alarm); D2 push-to-talk default with wake word in Hands-free; D3 what "read only when asked" means (metadata vs content sensors); D4 plans; D5 which phone next; D6 when the friend network starts; the ₹2,000 audit; voice-first vs visual with voice as a mode ("the largest" decision); background watchers as opt-ins; budget per tier; the beta transcript privacy position.
- Pricing architecture: Free / Pro $6.99 (₹199) / Power $14.99 (₹599); free must cost ₹2 (India) / ₹8 (US) a month to serve; at 2.1% conversion one paying user carries about 47 free ones; real price day one; founding rate 40% off locked 12 months; 21-day Pro trial (42.5% vs 25.5% conversion); freemium tested on one cohort; India in year one is land, not revenue. Today's build has six daily-cap plans ($5–$200) and no payments (`services/iris-api/tiers.py`).
- Cost: ~₹2,000 per user per month today vs a free ceiling of ₹2–8; a spoken turn is about $0.027 of which speech out is 87% (`tiers.py` header); levers are keep free off the model, route by task, shrink context, cap and meter, cache and batch.
- Segments: primary US college and grad students (19.4M); secondary early-career professionals and creators; India beta on premium campuses and young tech workers on Mac; accessibility is a mode built, not a segment marketed; under-18s excluded.
- Platform roadmap: Mac + iPhone first (Phase 1), Windows + Android in Phase 2, watches and beyond later; four stages each with one gate, stage 1 = paying users keep her open daily and errands work reliably on Mac, iPhone and iPad.
- Legal, privacy, trust: DPDP Act 2023 for Indian user data; 18+ confirmation at sign-up; AI disclosure at first run and in settings; auto-hide on screen share as the one non-negotiable; memory view and delete item by item; transcript retention (verbatim transcripts shipped to the server and CloudWatch, redaction mode exists and is off); friend-network safety (rate limits, block, report; SB 243 exposure).
- Security design docs: data egress (only the question text leaves the Mac for info; never screen text, clipboard or files), hijacking, permission modes, OAuth broker with narrow scopes and revocable credentials.
- The wave order (extract §C): decisions first; Wave 1 quick wins and non-negotiables (1–2 weeks: hide on share, 18+, AI disclosure, behaviour lock, typing stillness, doze, battery and weather looks, pocket badge, Wi-Fi, Bluetooth helper, Do Not Disturb via a Shortcut, Intel release); Wave 2 voice and privacy rules (after D1–D3); Wave 3 one account, one memory; Wave 4 what the lead segments open her for (focus timer, calendar, daily brief, deadlines via Canvas feed, email and message drafts, find files, hats); Wave 5 every screen (iPhone app, presence, portable character, Android bubble); Wave 6 friends (after D6); plans and payments alongside Waves 2–4.
- The Road doc's phases (extract §D): Phase 0 trustworthy on the Mac (2–3 weeks, every §3.5 rule passes an automated test and real serving cost is measured); Phase 1 the agent loop (3–4); Phase 2 one brain (5–6); Phase 3 iPhone and Android parity (6–8); Phase 4 the definition's Phase 2 (4–6).
- Metrics: the five product numbers (daily opens per paying user; verified errand completion rate; declined-request rate; serving cost per active user by tier; hide and mute usage).

## Interfaces
- Publishes: requirement ids and status; Inbox decisions with recommendation and what waits on each; pricing and entitlement specs (plan → features, A5); the segment lead-feature matrix (students: deadlines, study-with-me, alarms, Iris-to-Iris; pros: daily brief, drafts, pockets, hide on share; creators: clipboard, screenshots, file errands; India: WhatsApp drafts, notes to a friend's Iris).
- Consumes: cost data from server (`tiers.py`, worker `usage` lines); beta evidence from beta-ops; build status from every charter to keep the checklist honest.

## Rules and traps
- Owner decisions are not made by employees. Each open item goes to the Inbox with a recommendation; work that waits on it is marked waiting, not started on an assumption (extract §B, §C "Decide first").
- The three rules broken today (she talks on every reply, listens all the time, reads the screen continuously) are most of the cost fix; they wait on D1–D3 (extract §C header).
- Foundations before features: A1 mode layer, A2 sensor consent, A3 account data layer, A4 presence, A5 entitlements, A6 portable character, B1 behaviour lock are done once, before what depends on them.
- Audit the ₹2,000 before trusting any price; split it into free-user and paying-user cost (deck `next`, Road Phase 0).
- iOS subscriptions must go through the App Store; Android through Play billing; web checkout elsewhere.
- Storing Indian users' data: DPDP applies; check with someone qualified before real user data goes live (owner's global rule, `~/.claude/CLAUDE.md`).
- The listening budget was sized against the wrong quantity (turns × 8 s); real `stt_seconds` is closer to how long the room is noisy (`docs/ISSUE-LOG.md`, 21 Sep). Any plan that meters STT must be re-derived from a measured day.
- A feature leads for a segment when it is why they open Iris daily; it is held back when it would embarrass them at their desk (deck `matrix`).
- Numbers quoted from the deck's images (tier cards, the ten expressions, stage names) are image-only; cite sources C and D for prices.

## Definition of done
- A decision item is done when it sits in the Inbox with context, recommendation, what waits on it, and the owner has answered; the answer is recorded in the org history.
- A pricing or entitlement spec is done when server has confirmed it can be metered per tier and per user with the heavy tail capped, and the cost-per-plan test in `services/iris-api/test_tiers.py` still proves each plan affordable.
- A requirement status change needs evidence from the owning charter (test counts, live check) before it moves to built or verified.
- Say "not verified" for any status taken from a doc rather than from a live check.

## How to build, test and ship
- Documents go under `~/jkj/docs/` for Workplace-level material and are linked from the requirement; a proposal is a readable diff plus a reason.
- Read the artifacts through the Artifact tool's read action (they are the owner's private claude.ai artifacts; links in `IRIS-WORKPLACE-PROMPT.md` §4b).
- Ship = an Inbox decision by the owner. Nothing here runs a script.

## Coordinate with
- chief-of-staff: requirement import, feature specs, which decisions are real.
- server: tiers, entitlements, cost metering, the OAuth broker.
- conversation and character: D1–D3 (modes, sensors, quiet by default, the three spoken moments).
- mobile and windows: platform order, India beta shape.
- beta-ops: transcript privacy position, tester digests as product evidence.
- memory: view and delete, portable memory, sensitive categories.

## Needs owner approval
- Every open decision listed above; any price, trial length or founding-rate change; un-parking Iris Park (Social).
- Any change to the rules every feature follows.
- Going live with real user data in India.
