# Iris — structured extract of the four definition artifacts

Sources read (Artifact tool `read`; the Road doc is a Claude Docs document, read through the Docs connector because its content does not live in the page):

- A. "Iris — Product Definition" deck — https://claude.ai/artifact/D3RnHZxvijew1JJj8hetQG (Slides type; `project/deck.json` + 19 slides, version 1790519555-85ba, deck dated "working draft · September 2026", created 2026-09-23)
- C. "Closing the Iris Gaps" — https://claude.ai/artifact/X1NjmtxguA2FacH3q83Lyj (dated 27 Sep; built from the 22 Sep Product Definition draft, the Feature Checklist, and code at release 0.2.13)
- D. "Iris: the road from today's build to the product" — https://claude.ai/artifact/AYGc1twG1DLgVVbSNFMV6V (Claude Docs, dated 2026-09-25, rev 7; author Shravan; codebase as of 0.2.11)
- E. "Watching Iris in Beta" — https://claude.ai/artifact/FBWoV1HvgXk4Cpy9AGmRDo (dated 21 Sep 2026, 0.2.7 published, assessed against a real tester session)

Note on the deck: several slides carry their content in images (`/_blob/...`). Only the image `alt` text is recoverable; where the numbers on the picture (e.g. the tier price cards, the ten expressions and their triggers, the four stage names and gates, the four rollout phases) are not in the slide text, this is flagged as "image only". Prices and phase names quoted elsewhere come from sources C and D, which cite the same definition.

---

## A. Product Definition deck, section by section

Deck title: "Iris — Product Definition". Slide order from `deck.json`: cover, what, spectrum, evidence, devices, rollout, features, expressions, touch, rules, segments, matrix, cost, tiers, launch, vision, orbit, stages, next (19 slides). Six sections; each section runs from its `start` slide to the next section's start.

### Section "intro" — "What Iris is and why she is a familiar rather than a friend"
Slides: cover, what, spectrum, evidence.

#### Slide `cover` — "Iris"
- Tagline: "A cute creature familiar who lives on your devices, knows your day, and carries your errands to the right app."
- Status line: "Product definition · working draft · September 2026".
- Speaker notes: "Seven parts: what she is, where she lives, features, who we sell to, what each segment gets, price, and the long-term vision."

#### Slide `what` — "THE ONE LINE / She is the conductor, not the orchestra."
- "Iris owns three things herself — memory, judgement and character. Everything else she hands to the app best suited for it."
- Speaker notes: "Not a chatbot, not a virtual pet. The name is the iris of the eye: she decides how much gets through to you."

#### Slide `spectrum` — "Where Iris sits: a familiar, not a friend"
- Image (alt): "Friend to tool spectrum with Iris at two-thirds toward tool".
- "Work is the product; character is the interface. Target split: about 65–70% familiar, 30–35% friend."
- Speaker notes: "Friend products sell talk and presence. Tool products sell work. We sit closer to the tool side but keep the character as the face."

#### Slide `evidence` — "Why that call — the market evidence"
- Table (Product / What happened / Lesson):
  - Tolan — "$12M ARR in months, then a flat quarter; 80%+ US revenue" — "Friends monetise fast, then plateau".
  - Character.ai — "28M to 20M users; ~$2.50 per user per year" — "Huge engagement, weak revenue".
  - Desktop Mate — "Players down 86% from peak; mixed reviews" — "Cute without purpose fades".
  - Bongo Cat — "~177k daily players, 96% positive, 16 months on" — "A character tied to your work retains".
  - Siri AI — "On-screen errands across iPhone and Mac, free" — "Raw errands are becoming an OS feature".
- Footnote: "Third-party estimates; directional, not exact".

### Section "where" — "Which devices she launches on, and why Mac and iPhone come first"
Slides: devices, rollout.

#### Slide `devices` — "Where she lives: two mirror-image markets"
- Image (alt): "US versus India laptop and phone operating system share".
- "US is Apple-friendly where it matters — 68% of 18–29s use iPhone, ~40% of students use a Mac. India runs on Windows and Android, but MacBooks took 71% of its premium AI-notebook category."
- Speaker notes: "StatCounter measures web traffic, not ownership. The Linux bar is mostly masked Windows."

#### Slide `rollout` — "Launch on Mac + iPhone, then open up"
- Image (alt): "Four-phase device rollout from Mac and iPhone to Windows, Android, watches and beyond" (phase names beyond this are image only; source D confirms "Mac + iPhone first, Windows + Android in Phase 2").
- "Why Apple first": "Densest part of the core segment, one ecosystem to build, users who pay".
- "Why Windows is phase 2": "60% of US students and 76% of Indian desktops run it".
- "India caveat": "Mac + iPhone reaches only ~1 in 10 young Indians — beta first".

### Section "features" — "The fourteen feature types, the character mechanics and the rules they follow"
Slides: features, expressions, touch, rules.

#### Slide `features` — "Fourteen feature types, three families"
- Family "Character": "Expressions · Movement · Touch · Voice & sound · Personality & chat · Context reactions" — "Makes her feel alive. Runs on-device."
- Family "Utility": "System actions · Pockets & caught downloads · Communication · Iris-to-Iris messages · Reminders, alarms, focus, deadlines" — "The reason she stays open."
- Family "Relationship": "Memory & bond · Customization · Cross-device · Social (parked) · Privacy & control" — "Why people come back."
- Speaker notes: "AI delegation and bring-your-own-subscription were cut. Iris Park is parked until the core is proven."

#### Slide `expressions` — "Expressions, and what triggers them"
- Image (alt): "Ten expressions with their triggers" (the ten expressions and triggers are image only; source D says "All ten expressions" are built).
- Footnote: "Placeholder faces — art direction still open".

#### Slide `touch` — "Touch: her body is the interface"
- Image (alt): "Touch map showing head pat, belly poke, tail tug, drop a file and drag to top".
- "Pockets": "Drop a file, link or paragraph on her and she holds it — then take it out in another window, on another device, or hand it to a friend."
- "She also catches your last download. This is the one errand that needs a body."

#### Slide `rules` — "The rules every feature follows"
- "Never guilt." — "She is never upset because you were away. Companion apps use guilt or FOMO in 37% of goodbyes — it lifts usage and raises churn, anger and legal risk."
- "Never auto-send." — "Messages and emails stay drafts until you confirm."
- "Read only when asked." — "Clipboard, files and screen are touched on request, never in the background."
- "Invisible when it matters." — "She hides in meetings and screen shares, and stays still while you type."
- "Listening is visible." — "Push-to-talk by default; hands-free lives in accessibility mode."

### Section "who" — "The segments we target and what each one leads with"
Slides: segments, matrix.

#### Slide `segments` — "Who we are building for"
- Image (alt): "Target rings from primary US students out to segments we are not serving yet".
- "Primary: US college and grad students, 19.4M of them, designed with people who struggle to focus in mind."
- "Secondary: early-career professionals and creators — they pay the most."
- "India beta: premium campuses and young tech workers on Mac."
- "Accessibility is a mode we build, not a segment we market to. Under-18s wait: companion-chatbot laws target minors."

#### Slide `matrix` — "Same Iris, different lead features"
- Image (alt): "Feature by segment matrix marking each feature core, included or later" (the full core/included/later matrix is image only).
- "Students lead with deadlines, study-with-me, alarms and Iris-to-Iris messages."
- "Pros lead with the daily brief, drafts, pockets and hiding on screen share."
- "Creators lead with clipboard, screenshots and file errands."
- "India leads with WhatsApp drafts and notes to a friend's Iris."
- Rule: "A feature leads when it is why that segment opens Iris daily; it is held back when it would embarrass them at their desk."

### Section "money" — "The cost problem, the three tiers and how we launch the price"
Slides: cost, tiers, launch.

#### Slide `cost` — "The pricing problem is cost, not price"
- Image (alt): "Serving cost of 2000 rupees per user against consumer AI price points".
- "At ₹2,000 per user per month we cost more than ChatGPT Plus sells for. Inference for a fixed capability falls roughly 10x a year — but the plan cannot rest on that alone."
- Speaker notes: "Levers: keep the free tier off the model entirely, route by task, shrink context, cap and meter, cache and batch. First job is auditing the 2,000 figure."

#### Slide `tiers` — "Three tiers, two markets"
- Image (alt): "Free, Pro and Power tier cards with prices" (prices are image only on the slide; sources C and D quote the definition as Free, Pro $6.99 / ₹199, Power $14.99 / ₹599).
- "Free must be almost free to serve: at 2.1% conversion, one paying user carries about 47 free ones."

#### Slide `launch` — "How we launch the price"
- "Real price, day one" — "A cheap launch price becomes the price people think is right".
- "Founding rate" — "40% off, locked 12 months, clearly time-boxed".
- "21-day trial" — "Long trials convert at 42.5% against 25.5% for short ones".
- "Freemium, tested" — "Hard paywalls convert 5x better — try one cohort, keep free for the friend loop".
- "India in year one is land, not revenue: rivals are giving a full year away."

### Section "vision" — "The long-term plan: Iris on every screen, then her own"
Slides: vision, orbit, stages, next.

#### Slide `vision` — "THE LONG-TERM PLAN / She is everywhere you are."
- "Laptop, phone, tablet, watch, car screen — and eventually a small Iris screen by your bed. The device changes; she does not."
- Speaker notes: "This is the single vision we committed to. Everything before it is the path."

#### Slide `orbit` — "One character, many bodies"
- Image (alt): "Iris at the centre with devices in rings from now to the vision".
- "The moat is the memory, not the metal. Hardware can be copied in a year; two years of knowing someone cannot."
- "So from day one: a portable memory format, and a character engine that assumes nothing about macOS."
- "Rules: never replace the phone, software before hardware, nothing ever bricks."

#### Slide `stages` — "Four stages, each with one gate"
- Image (alt): "Four stages from laptop and phone to our own screen, each with a gate" (stage names and gates are image only; source D quotes stage 1's gate as "paying users keep her open daily and errands work reliably" on Mac, iPhone and iPad, and says every other stage is gated on that one).
- "Skipping a gate is how companion hardware dies: Humane shipped fewer than 10,000 Pins and bricked them all; Rabbit sold 100,000 and drowned in returns."
- Speaker notes: "Cheapest test of stage 4: ship bedside mode on an old phone before building any hardware."

#### Slide `next` — "What we need to decide next"
- "Audit the ₹2,000. Split it into free-user and paying-user cost. Every price in the document depends on it."
- "Settle voice. Text-first on the laptop, but the watch, car and bedside screen are voice-first. Design it now or rebuild later."
- "Prove the character loop. Ten users, four weeks: do they keep her open, and do they send notes to a friend's Iris?"
- "Decide the India shape. Beta on Mac now, or wait for Windows and Android in phase 2?"
- Footnote: "Full detail: Iris Product Definition, sections 1–7".

---

## B. Open decisions the definition leaves to the owner

From the deck (slide `next` and footnotes):
1. Audit the ₹2,000/user/month serving cost and split it into free-user vs paying-user cost; every price depends on it.
2. Settle the voice architecture: text-first on laptop vs voice-first on watch, car and bedside screen — design now or rebuild later.
3. Prove the character loop: ten users, four weeks — do they keep her open, and do they send notes to a friend's Iris?
4. India shape: beta on Mac now, or wait for Windows and Android in phase 2?
5. Art direction for the expressions ("Placeholder faces — art direction still open").
6. Freemium model: test a hard paywall on one cohort vs keeping free for the friend loop ("Freemium, tested").
7. Iris Park (Social) is parked "until the core is proven" — when to un-park.

From "Closing the Iris Gaps" (D1–D6, "Your call"):
8. D1 Quiet by default — definition: she speaks three things (daily greeting, a friend's message, an alarm); today she speaks every reply. Recommendation: Quiet default; Talk mode and Hands-free mode one switch away.
9. D2 Push-to-talk by default — definition: push-to-talk by hotkey or click, wake word opt-in and off; today wake word always on. Recommendation: push-to-talk default, wake word into Hands-free.
10. D3 What "read only when asked" means — recommendation: split sensors into metadata (always on) vs content (on request / explicit opt-in).
11. D4 Plans and what each includes — adopt Free / Pro $6.99 (₹199) / Power $14.99 (₹599) vs today's six daily-cap plans from $5 to $200.
12. D5 Which phone next — iPhone (US students) vs the existing Android chat app.
13. D6 When the friend network starts — recommendation: after the 18+ gate and account data layer, with rate limits, block and report from day one.

From the Road doc ("Decisions for Shravan"; Phase 0 cannot finish until the first three are settled):
14. How she listens — push-to-talk default, wake word opt-in and accessibility mode (recommended) vs wake word on by default (built).
15. When she reads the screen — only on request by default; proactive screen awareness as an opt-in rung on the permission ladder.
16. What she says aloud — "Decide which product Iris is first: a voice companion, or a visual one with voice as a mode. Everything in §4 and §5 of the definition assumes the second." Called "the largest" decision.
17. Which phone first — iPhone for the US student segment, Android continuing for the India beta.
18. Background watchers — clipboard history and "catch last download" as explicit opt-ins, off by default (two Pro features).
19. Budget per tier — definition: daily limits per tier, top-ups for Power; build: one quota per user. Set step caps and token budgets per task for Free, Pro and Power before the agent loop ships.

From "Watching Iris in Beta":
20. Decide the privacy position on transcripts deliberately (recording of everything near a microphone at home, sent to server and mirrored to CloudWatch); testers should know. Redaction mode exists and is off.

---

## C. Closing the Iris Gaps (27 Sep)

Header facts: "Sixty features are missing or partial." About a third are small add-ons that can start now; the rest wait on six product decisions, because three rules in the document contradict how Iris works today: "she talks on every reply, listens all the time, and reads the screen continuously" — those three rules are most of the fix for the cost problem in §6. Work count: 58 pieces — 22 add-on, 23 feature, 9 architecture, 4 platform.

Order: (1) Make the six decisions; (2) Ship Wave 1 meanwhile; (3) Build the foundations each wave needs; (4) Then the features on top.

Sizing vocabulary: Add-on = days, inside today's architecture; Feature = 1–2 weeks, a new module/service; Architecture = weeks, changes a contract others depend on, done once before what depends on it; Platform = months, a new app, a network, or billing; "Your call" = a product choice several builds wait on.

### Decide first (D1–D6)
- D1 Quiet by default — Recommendation: replies go on her card, reactions stay as body and short sounds; Talk mode (today's behaviour) and Hands-free mode (accessibility) one switch away. Speech is about 87% of what a turn costs, so this is the biggest cost cut in §6. New filler lines and thinking gestures stay: gestures in every mode, spoken fillers in Talk and Hands-free only. Waiting on it: Speaks only three things · Daily greeting · Free tier cost.
- D2 Push-to-talk by default — Recommendation: push-to-talk default; wake word moves into Hands-free mode; microphone streams only while you hold the key or after you click her. Removes continuous listening, most self-echo and room-noise problems and the transcription bill. Needs the speech connection warmed on key-down so the first word is not lost. Waiting: Listening is visible · Push-to-talk · Cost.
- D3 What "read only when asked" means — Recommendation: split sensors in two. Metadata (which app, window title, idle time, battery, weather) stays on; content (screen text, clipboard, file contents) read only on request or with explicit opt-in on the permissions screen. Proactive lines get shallower ("forty minutes in Figma" not what is on the canvas). Clipboard history and Downloads catch become opt-ins under the same rule. Waiting: Read only when asked · Clipboard history · Catch last download.
- D4 Plans and what each includes — Definition: Free, Pro $6.99 (₹199), Power $14.99 (₹599). Built: six daily-cap plans from $5 to $200, no payments. Recommendation: adopt the three plans; Free runs Quiet with the Mac voice and capped chat, so a free user costs ₹2–8 a month; Pro adds pockets, caught downloads, Iris-to-Iris notes, screen and file errands, and cross-device, as §6.3 lists. Needs an entitlements layer (today a plan only caps usage). Waiting: Pricing · Payments · Trial.
- D5 Which phone next — Definition: iPhone in Phase 1 with the Mac. Android chat app exists; no iOS app. Recommendation: iPhone next for the US student segment; keep Android at current chat level until Phase 2 on the same API. iOS reuses the phone contract proven on Android; iOS cannot float over other apps, so widgets, Live Activities and alarms carry her there. Waiting: iPhone app · Widgets · Wake-up alarm.
- D6 When the friend network starts — Iris-to-Iris notes are the students' growth engine (§5.3) but §7.2 says prove the core first. Recommendation: after the 18+ gate and the account data layer, with rate limits, block and report from day one. First feature where one user's content reaches another's device: brings abuse handling and SB 243 exposure. Waiting: Iris-to-Iris notes · Announcing a message · Friend messages stay short.

### Foundations (architecture, each done once)
- A1 Mode layer — one policy object every speaking path asks before it speaks (replies, fillers, proactive lines, finished tasks, sounds); Quiet, Talk and Hands-free are settings of it. When: after D1 and D2. Unblocks: speaks only three things, push-to-talk, daily greeting, accessibility mode, free-tier cost.
- A2 Sensor consent — every sensor declared once with its class (metadata or content) and its consent; every reader checks it; permissions dashboard shows it. After D3. Unblocks: read only when asked, clipboard history, catch last download, typing stillness.
- A3 Account data layer — memory, to-dos, reminders, alarms, timers, bond counters and the pocket index move to one account store on the server; Mac and phone both read and write it. Independent. Unblocks: portable memory, account sync, item-by-item memory delete, set here rings there, bond, daily brief on every device.
- A4 Presence — server knows which device she is on right now, from heartbeats the Mac already sends and the phone would send. After A3. Unblocks: one place at a time, she hops devices, no double notifications, alarms ring on the right device.
- A5 Entitlements — plan to features, checked on the server and cached on each device. After D4. Unblocks: Pro features, trials, founding-member rate, payments.
- A6 Portable character — character engine already runs in a web view on the Mac; package it so Android and iPhone apps show the same Iris. Independent. Unblocks: Android floating bubble, character in the phone apps, §7.6.
- B1 Behaviour lock — single "stay still" flag the walker, props, reactions and proactive lines all respect. Wave 1. Unblocks: stay still while typing, focus sessions, meetings, screen share.

### Where new features collide with what exists (how to fit both)
- Speaks only three things vs voice-first replies and new spoken fillers → A1 modes; Quiet: body, card and short sounds; fillers speak only in Talk and Hands-free.
- Push-to-talk default vs always-on listening, the "was that for me?" judge, barge-in, the echo guard → A1 modes; on-demand speech connection with warm start on key-down; always-on stack stays for Hands-free.
- Read only when asked vs screen-aware proactive lines, the context system, trouble detection → A2 split: metadata stays, content on request; proactive lines ground on app and dwell only.
- Clipboard history, catch last download vs read only when asked → opt-in on the permissions screen; kept on the Mac only; password copies (concealed pasteboard types) never captured.
- Auto-hide on screen share vs own screenshot checks and intentional screen recordings → hide from capture by default, with a developer switch for tests and an "appear in recordings" setting.
- Stay still while typing, focus sessions vs walking, props, reactions, proactive lines → B1 behaviour lock.
- Late-night doze vs never refuse or delay a task → doze is visual only; any input wakes her at once.
- Set here, rings there vs timers ring inside the Mac app; an offline Mac must still ring → server schedule plus a local copy, de-duplicated by id; A4 picks the device; Mac falls back to ringing locally.
- Portable memory vs two stores (Mac memory service and phone agent memory) → A3 becomes the one store; migrate both; both clients read it.
- Three plans with features vs six cap-only plans and the testers on them → A5 entitlements; map existing testers to the nearest new plan; keep caps as the cost guard inside each plan.
- Drag pockets out of her vs hold-and-shake and fling gestures → drag starts only from the pocket badge, never from her body.
- A few hats vs her crown already on her head → the crown becomes the default hat in the hat slot.
- Iris-to-Iris notes vs never auto-send, speaks only three things, minors law → sender confirms every note; receiver chooses to play it; requires the 18+ gate first.

### The waves (in order; sizes for sequencing, not dates; every wave checked live on a real Mac before it counts as done)
- Wave 1 "Quick wins and the non-negotiables" (about 1–2 weeks; nothing waits on a decision): Auto-hide on screen share and recordings (Feature; non-negotiable; hide from capture, verified on Zoom, Meet and Teams); 18+ confirmation at sign-up (Add-on); AI disclosure at first run and in settings (Add-on); Behaviour lock B1 (Add-on); Stay still while you type fast (Add-on; idle-time signal; check it needs no Input Monitoring permission); Random walk avoids the cursor; Late-night doze, poke to wake, yawn at night; Time-of-day behaviour; Low battery look and one line; Cap when hot, shiver when cold; Dance on good news; Peek-hide at the edge, click to return; Head pat as a stroke, varied giggles; Pocket badge and drag out from it; Screenshots into the pocket; Choose her home spot; Wi-Fi on and off; Bluetooth on and off (Feature; needs a small helper, macOS has no command); Do not disturb (Feature; through a Shortcut; macOS Focus not directly scriptable); Intel Mac release (Add-on; Intel is on 0.2.4).
- Wave 2 "Voice and privacy rules" (about 2 weeks, after D1–D3): Mode layer A1; Quiet mode: speaks only three things; Push-to-talk default, wake word in Hands-free (on-demand speech connection); Daily greeting, once a day, weather-aware (one of the three spoken moments); Sensor consent A2; Clipboard history (opt-in, local only); Catch last download (opt-in).
- Wave 3 "One account, one memory" (about 3 weeks; can start alongside Wave 2): Account data layer A3; Portable memory (migrate both stores); View and delete memory item by item; To-dos; Reminders, alarms and timers on the account; Bond level, milestones, evolves over time (never falls; no streaks); Adapts tone and timing (learns from ignored lines).
- Wave 4 "What the lead segments open her for" (about 3–4 weeks): Focus timer and study breaks (uses behaviour lock); Calendar: read and create (Mac calendar first; Google for the phone); Daily brief (after calendar and to-dos); Share schedule; Deadline tracking (Canvas calendar feed first, no OAuth); Email drafts (Mail.app draft on the Mac); Message drafts for iMessage and Slack; Find files by description (Spotlight plus judgement); Quick search; Notification summary (through connected mail and calendar); A few hats and colour variants (art plus a picker).
- Wave 5 "Every screen" (about 6–8 weeks; the iPhone app is most of it): Presence A4; One place at a time, she hops devices; iPhone app: chat, widgets, Live Activities, alarms (Platform); Portable character A6; Android floating bubble (Platform); Wake-up alarm rings on the phone (after A3 scheduling and calendar).
- Wave 6 "Friends" (about 3 weeks, after D6): Friend list, Iris-to-Iris notes (Platform; rate limits, block and report built in); Announcing a message, play or leave; Friend messages stay short (a length rule on the note).
- Alongside "Plans and payments" (after D4, parallel with Waves 2–4): Entitlements A5; Free / Pro / Power with India prices; Payments: web checkout, Play billing, App Store (iOS subscriptions must go through the App Store); 21-day Pro trial, founding-member rate.

### Risks to watch
- Hide-from-capture on current macOS: newer capture paths have not always honoured it; if a meeting app still shows her, fall back to detecting the share and hiding the window.
- Quiet mode feels flat: Talk mode one switch away; sounds and gestures still carry her; test with users before the default ships wide.
- Memory migration: two stores become one; run both in parallel for a release and compare before switching reads.
- iPhone scope: largest single item; ship chat, alarms and a widget first; Live Activities after.
- Friend network abuse: rate limits, block and report are part of the first version, not a follow-up.

---

## D. The Road doc — "Iris: the road from today's build to the product" (25 Sep)

### The product we are reaching
- Iris "lives on every screen you own, knows your day, and carries your errands to the right app." Work is the product, character is the interface: "roughly 65–70% utility and 30–35% personality and presence."
- She owns memory, judgement and character and delegates everything else: "memory must travel, judgement must be cheap, and character must never cost a model call."
- Commitments → what they demand:
  - Conductor, not orchestra → a small, reliable set of actions (experts) plus a way to handle anything they don't cover.
  - Mac + iPhone first, Windows + Android in Phase 2 → rendering, behaviour and memory that do not assume macOS.
  - She follows you across screens → one account, one memory, one pocket, one task queue shared by every device.
  - Useful with the laptop closed → work that can run in the cloud, with results delivered to the phone.
  - Free tier costs about ₹2 (India) / ₹8 (US) a month to serve → character, timers, reminders and alarms run as local code, never as model calls.
  - Pro $6.99 / ₹199, Power $14.99 / ₹599 → metering per tier and per user, with the heavy tail capped.
  - Never guilt, never auto-send, read only when asked, invisible when it matters → rules the system enforces and tests, not guidelines in a prompt.
  - Eventually her own device → a device-agnostic memory format and behaviour engine from day one.
- Ladder: stage 1 is "paying users keep her open daily and errands work reliably" on Mac, iPhone and iPad; every other stage is gated on that one.

### Where the build stands
- Character essentially finished; product around her not. Of 116 checklist rows: Built 48 (all ten expressions, touch map, pockets, sounds, weather and umbrella, drafts-then-confirm); Add-on 24; Feature 19 (screen-share hide, calendar, email drafts, to-dos); Platform 19 (accounts, sync, cloud execution, mobile); Owner decision 6 (push-to-talk default, what she speaks aloud, background screen reading). Ledger: https://claude.ai/code/artifact/e1524a05-5eb6-4685-ada1-b17a91bbb207
- Shipping state: Mac (Apple Silicon) 0.2.11, notarised, self-updating, published 24 September; Mac (Intel) 0.2.4, behind by seven releases; Windows 0.2.10, built and published, not tested on real hardware; Android app exists with sign-in, push (FCM) and a phone relay; iPhone no app yet although the definition makes it Phase 1.
- Four gaps that matter: (1) anything no expert covers is refused for every user but the owner (fallback spawns Claude Code, which only exists on the dev machine); (2) nothing crosses devices (memory, pocket and tasks live on the Mac); (3) two rules broken by default (watches the screen continuously; wake word on by default rather than push-to-talk); (4) serving cost unaudited (~₹2,000 per user per month vs a free-tier ceiling of ₹2–8).

### The four architectural moves (stack; each makes the next cheaper)
- Diagram: iPhone/Android (capture, chat, alerts) and Mac/Windows (character, local hands) → iris-api "the brain" = Account + memory + library; Task queue; Agent loop (Claude API + tools); Connected services (OAuth). Queue → portable → Loop; Queue → machine-bound → Mac; Loop → OAuth. "Every device talks to one brain; work runs wherever it can, and the Mac only does what genuinely needs the Mac."
- 1. One account, one brain — memory, the pocket (as a synced library), conversation history and the task registry move server-side, keyed to the account; devices become views. Resolves about twenty checklist rows: account sync, portable memory, "she hops devices", the library on the phone, alarms that ring on the right device.
- 2. A task queue with two executors — every task carries a locality. Portable tasks (research, drafting, Drive, Gmail, Calendar, anything over an API) run in iris-api immediately, laptop shut. Machine-bound tasks (Mac apps, local files, logged-in browser) queue durably, run when the Mac wakes, result pushed to the phone. Expert catalog already declares a platform capability per function; locality is one more field.
- 3. An agent loop on the Claude API — Claude Code fallback removed entirely; bounded tool-use loop drives existing experts as tools: shortlisted tools (router's top two or three experts, not all 54 functions; about 400 tokens instead of 2,100); prompt caching on system prompt and tool definitions; small model first, escalating only when a step stalls or fails verification; verification on every step (each expert function gains a `verify` beside its `run`); a hard stop (step cap, token budget per task, honest report of what was and wasn't done). Chrome is the first capability: page sent as a compact list of interactive elements with reference ids; actions are `click(ref)` and `type(ref, text)`.
- 4. Connected services through OAuth — iris-api brokers per-service authorisation (Google Drive, Docs, Gmail and Calendar first) with narrow scopes, encrypted refresh tokens, one-tap disconnect in settings. Credentials scoped and revocable; Iris never holds a user's browser sessions.

### The plan, phase by phase (five phases; each ends on a test a user could run)
- Phase 0 "Trustworthy on the Mac" — builds: auto-hide on screen share; still while typing; push-to-talk and screen-reading decisions applied; the add-on pile (Do Not Disturb, Wi-Fi and Bluetooth, screenshots into the pocket, missing animation triggers, late-night doze); a counter for every request she declines. Done when: every feature rule in §3.5 passes its automated test, and real serving cost per active user is measured. Size: 2–3 weeks.
- Phase 1 "The agent loop" — tool-use endpoint in iris-api; bounded loop in agent-svc; `verify` on every expert; Chrome through element references; Claude Code removed from the product. Done when: a request declined today completes for a user who has never installed Claude Code, inside its token budget, with the result verified. Size: 3–4 weeks.
- Phase 2 "One brain" — account-owned memory, library and task registry; the queue with portable and machine-bound executors; OAuth broker; Drive, Docs, Gmail and Calendar as the first cloud experts. Done when: with the Mac shut, a phone request creates a document and files it in Drive; a Mac-only request queued from the phone runs on wake and reports back. Size: 5–6 weeks.
- Phase 3 "iPhone, and Android parity" — iPhone app with share-sheet capture, voice notes, the library, widgets and Live Activities; the floating Iris on Android. Done when: the definition's stage-1 gate — paying users open her daily on Mac and iPhone, and errands work reliably. Size: 6–8 weeks.
- Phase 4 "The definition's Phase 2" — Windows validated on real hardware; Intel Mac brought level; India beta on Windows and Android. Done when: a Windows user and an Android user complete the same daily errands as a Mac user. Size: 4–6 weeks.
- Dependencies: Phases 0 and 1 can run side by side (Phase 0 Mac-side, Phase 1 mostly new code); Phase 2 needs Phase 1's loop; Phase 3 needs Phase 2's account. Sizes are rough, tighten once Phase 0's cost audit and decline counter produce real numbers.

### Decisions for Shravan
- See section B items 14–19. Phase 0 cannot finish until the first three (listening, screen reading, what she says aloud) are settled. The third is the largest: visual, mostly quiet familiar with voice as accessibility mode (definition) vs voice-first companion (build).

### Risks, and how we'll know it's working
- Serving cost stays high (~₹2,000/user/month vs ₹2–8 for free) — early warning: cost per active user from the Phase 0 audit, tracked every release — do: character and timers local; shortlisted tools, prompt caching, small-model-first; per-tier caps.
- Agent loop does less than Claude Code did — warning: completion rate on previously declined requests; verify failures per task — do: recurring fallbacks become new experts.
- Siri does errands for free (announced WWDC 2026 across Mac and iPhone) — warning: "Siri already does this" in interviews — do: lead with memory that travels, judgement, and the character.
- Holding users' documents (synced library stores files, photos, notes; DPDP applies in India) — warning: any access outside the owning user — do: encryption at rest, per-user isolation, item-level delete, reviewed before Phase 2 ships.
- One person deploys iris-api — warning: merged changes waiting on deploy — do: an agreed deploy branch and a regular deploy slot.
- Presence fatigue — warning: rising use of hide and mute — do: quiet by default; invisible in meetings and while typing (Phase 0).
- Five numbers, each phase should move at least one: (1) daily opens per paying user (stage-1 gate); (2) verified errand completion rate (errands that pass `verify`, not attempted); (3) declined-request rate (should fall sharply after Phase 1); (4) serving cost per active user, by tier (should fall every release); (5) hide and mute usage (presence fatigue signal).
- Sources cited: Product Definition draft 22 Sep 2026 (§1–7); Iris gap ledger 24 Sep 2026; codebase as of 0.2.11.

---

## E. Watching Iris in Beta (21 Sep 2026, 0.2.7)

Verdict: "Can you diagnose a reported problem? Yes, and well" (tester logs reach the server with transcripts, timings, stack traces). "Would you know it happened? No. Nothing tells you" — a tester was ignored 35 times out of 63 across three days; every one logged; nothing raised a flag.

### What already exists (keep)
- Tester logs ship to the server: agent batches 20 lines or 15 seconds, drops oldest under backlog, tags every line with a machine id, flushes on exit.
- Read any tester's session on demand: one authenticated call (`/admin/logs`, email + admin_key) returns the last 5,000 lines per email; mirrored to CloudWatch at `/iris/agent`.
- Transcripts included verbatim (a redaction mode exists; it is off).
- Health endpoint `/v1/pet/health` with a timestamp on every row.

### Gaps (ordered by cost)
- Nothing tells you when a tester is in trouble (blocks beta) — no alerting of any kind; "am i audible", "i just can you listen to me" etc. all discarded as background noise, surfaced nowhere. Survivable with five testers, silence with fifty.
- The app itself reports nothing (blocks beta) — log shipping lives in the Python agent; Electron side has no crash reporter and ships no renderer errors; a white window, failed update or dead main process leaves no trace. `chat.js:61` prints "Iris is not responding — is she running?" for any non-JSON reply, including a 500, and it never leaves the laptop.
- No numbers, only prose (fix soon) — latency percentiles, the 56% discard rate, TTS timings were computed by hand with awk once; nothing records them; no regression visibility. Figures: median 0.0s model, p90 1.3s; median 1.5s mic-gate lateness; p90 2.5s uncached voice.
- No list of who your testers are (fix soon) — finding an account needed SSH and SQL; no endpoint listing users or last seen.
- Retention thinner than it looks (fix soon) — 5,000 lines per tester; one session produced 400; a talkative day rolls evidence off before a weekend report; CloudWatch holds overflow but nothing routinely reads it.
- Decide the privacy position deliberately (fix soon) — transcripts are a recording of everything said near a microphone at home, sent to the server and mirrored to CloudWatch; should be a decision, and testers should know.

### Before widening the beta (smallest set)
- Daily digest per tester — turns, ignored rate, errors, slowest turn; mailed or pushed to Telegram (half a day).
- Alert on a stack trace — any traceback or HTTP 500 in a shipped log pings with tester and line (an hour).
- Ship the app's own errors — Electron `crashReporter` plus renderer `window.onerror` through existing `/v1/logs` (half a day).
- Record turn timings as data — one structured line per turn: heard, routed, first sound (a few hours).
- `/admin/testers` — email, version, last seen, turns today, error count (a few hours).

### Runbook: chasing a report
1. Find the account (match on domain, email often approximate). 2. Pull their log (`/admin/logs`, ~400 lines). 3. Count what she did with what she heard (group `wake:` lines: dispatched, conversed, discarded). 4. Read the discarded transcripts. 5. Reproduce against the real detector with the exact transcript. 6. Check the build they are on against the fix date (half of the reported bugs were already fixed and unshipped).
- Trap: twice a check reported success looking at the wrong thing (count over a persisting log file; a time filter comparing clock strings across midnight). Before believing any monitoring, make it fail on purpose once and confirm it says so.

---

## F. Requirement candidates (non-checklist)

Excludes the 110 checklist features (§3 groups: Expressions, Movement, Touch, Voice, Personality, Context reactions, System actions, Communication, Productivity, Memory, Looks, Cross-device, Social, Privacy and safety, Promises). Source key: Deck = A (slide id), Gaps = C, Road = D, Beta = E.

### Principles and positioning (§1)
1. Conductor, not orchestra — Deck `what`, §1 — Iris owns only memory, judgement and character; every other capability is delegated to the app best suited for it.
2. Familiar/friend split — Deck `spectrum`, §1 — Product targets about 65–70% familiar (work/utility) and 30–35% friend (character/presence); work is the product, character the interface.
3. Filter principle — Deck `what` notes, §1 — Iris decides how much gets through to the user (the iris of the eye); she is not a chatbot and not a virtual pet.
4. Character never costs a model call — Deck `features` + Road "product we are reaching" — Character, timers, reminders and alarms run as local on-device code, never as model calls.
5. Memory must travel, judgement must be cheap — Road "product we are reaching" — Engineering constraint derived from the ownership sentence.
6. Small expert set plus universal fallback — Road commitments table — A small, reliable set of experts plus a way to handle anything they don't cover.
7. Cut features — Deck `features` notes — AI delegation and bring-your-own-subscription are cut; Iris Park (Social) parked until the core is proven.
8. Position against Siri — Road risks — Lead with what Siri lacks: memory that travels, judgement, and the character.
9. Rules enforced and tested — Road commitments + Phase 0 gate — Never guilt / never auto-send / read only when asked / invisible when it matters are system-enforced rules with automated tests (every §3.5 rule passes its test), not prompt guidelines.

### Platforms and phases (§2)
10. Phase 1 platforms — Deck `rollout`, Road — Launch on Mac + iPhone (Phase 1); Windows + Android in Phase 2; watches and beyond later (four-phase rollout).
11. Platform-agnostic core — Deck `orbit`, Road — Rendering, behaviour and memory must not assume macOS; a device-agnostic memory format and behaviour engine from day one.
12. Portable character engine (A6) — Gaps foundations — Package the web-view character engine so the Android and iPhone apps show the same Iris.
13. iPhone app scope — Gaps D5/Wave 5, Road Phase 3 — iPhone app with chat, share-sheet capture, voice notes, the library, widgets, Live Activities and alarms; iOS cannot float over other apps; ship chat, alarms and a widget first, Live Activities after; reuse the Android phone API contract.
14. Android scope — Gaps D5/Wave 5, Road Phase 3 — Keep Android at chat level on the same API until Phase 2, then add the floating Iris bubble and errand parity.
15. Intel Mac parity — Gaps Wave 1, Road Phase 4 — Bring the Intel Mac build level with Apple Silicon (Intel is on 0.2.4, seven releases behind).
16. Windows validation — Road Phase 4 — Validate the Windows build (0.2.10) on real hardware; a Windows user completes the same daily errands as a Mac user.
17. India beta shape — Deck `rollout`/`next`, Road Phase 4 — India runs as a beta (Mac + iPhone reaches ~1 in 10 young Indians); Phase 4 puts the India beta on Windows and Android.
18. Bedside mode test — Deck `stages` notes — Cheapest test of stage 4 (own device) is bedside mode on an old phone before building hardware.
19. Hardware rules — Deck `orbit` — Never replace the phone; software before hardware; nothing ever bricks.
20. Four stages, one gate each — Deck `stages`, Road — Stage 1 gate: paying users keep her open daily and errands work reliably on Mac, iPhone and iPad; every later stage is gated on it; never skip a gate.
21. Long-term vision — Deck `vision` — Iris on laptop, phone, tablet, watch, car screen, then a small Iris screen by the bed; the device changes, she does not.

### Segments (§4–5)
22. Primary segment — Deck `segments` — US college and grad students (19.4M), designed with people who struggle to focus in mind.
23. Secondary segment — Deck `segments` — Early-career professionals and creators (they pay the most).
24. India beta segment — Deck `segments` — Premium campuses and young tech workers on Mac.
25. Accessibility as a mode — Deck `segments`/`rules` — Accessibility (hands-free, voice replies) is a built mode, not a marketed segment.
26. No under-18s — Deck `segments`, Gaps Wave 1 — Under-18s are excluded (companion-chatbot laws target minors); 18+ confirmation at sign-up.
27. Lead-feature rule — Deck `matrix` — A feature leads for a segment when it is why they open Iris daily; held back when it would embarrass them at their desk.
28. Segment lead packages — Deck `matrix` — Students: deadlines, study-with-me, alarms, Iris-to-Iris messages; Pros: daily brief, drafts, pockets, hide on screen share; Creators: clipboard, screenshots, file errands; India: WhatsApp drafts, notes to a friend's Iris.
29. Character-loop proof — Deck `next` — Run ten users for four weeks: measure whether they keep her open and send notes to a friend's Iris.

### Pricing, billing, cost (§6)
30. Three tiers — Gaps D4, Road — Free, Pro $6.99 (₹199), Power $14.99 (₹599); two markets (US and India prices).
31. Free-tier cost ceiling — Road, Gaps D4 — Free tier must cost about ₹2 (India) / ₹8 (US) per user per month to serve; free runs Quiet with the Mac voice and capped chat; free tier kept off the model entirely.
32. Free-to-paid economics — Deck `tiers` — At 2.1% conversion one paying user carries about 47 free users; Free must be almost free to serve.
33. Pro entitlements — Gaps D4 (§6.3) — Pro adds pockets, caught downloads, Iris-to-Iris notes, screen and file errands, and cross-device.
34. Cost audit — Deck `cost`/`next`, Road Phase 0 — Audit the ₹2,000/user/month figure, split into free-user and paying-user cost; measure real serving cost per active user, tracked every release by tier.
35. Cost levers — Deck `cost` notes, Road — Route by task, shrink context, cap and meter, cache and batch; shortlisted tools; prompt caching; small model first.
36. Metering per tier — Road commitments/decisions — Metering per tier and per user with the heavy tail capped; daily limits per tier; top-ups for Power; step caps and token budgets per task for Free, Pro and Power set before the agent loop ships.
37. Entitlements layer (A5) — Gaps foundations — Plan-to-feature mapping checked on the server and cached on each device; plans can switch features on and off, not just cap usage.
38. Tester migration — Gaps collisions — Map existing testers on the six cap-only plans ($5–$200) to the nearest new plan; keep caps as the cost guard inside each plan.
39. Payments — Gaps "Alongside" — Web checkout, Google Play billing, App Store; iOS subscriptions must go through the App Store.
40. Real price day one — Deck `launch` — Launch at the real price; no cheap launch price.
41. Founding-member rate — Deck `launch`, Gaps — 40% off, locked 12 months, clearly time-boxed.
42. 21-day Pro trial — Deck `launch`, Gaps — Long trial (converts 42.5% vs 25.5% short).
43. Freemium test — Deck `launch` — Test a hard paywall on one cohort; keep free for the friend loop.
44. India year-one stance — Deck `launch` — India in year one is land, not revenue (rivals give a full year away).

### Architecture and delivery (Gaps foundations, Road moves)
45. Mode layer (A1) — Gaps — One policy object every speaking path (replies, fillers, proactive lines, finished tasks, sounds) consults; Quiet, Talk and Hands-free are its settings.
46. Quiet-by-default rollout — Gaps D1/risks — Quiet default with Talk mode one switch away; gestures in every mode, spoken fillers only in Talk and Hands-free; test Quiet with users before the default ships wide.
47. Push-to-talk plumbing — Gaps D2/collisions — On-demand speech connection warmed on key-down so the first word is not lost; microphone streams only while key held or after click; always-on stack retained for Hands-free.
48. Sensor consent (A2) — Gaps — Every sensor declared once with its class (metadata vs content) and consent; every reader checks it; the permissions dashboard shows it; proactive lines ground on app and dwell only.
49. Content-sensor opt-ins — Gaps D3/collisions, Road decisions — Clipboard history and catch-last-download ship as explicit opt-ins, off by default, kept on the Mac only; concealed pasteboard types (password copies) never captured.
50. Account data layer (A3) — Gaps, Road move 1 — Memory, to-dos, reminders, alarms, timers, bond counters, pocket index / library, conversation history and task registry move to one server-side account store; Mac and phone both read and write it; devices are views.
51. Memory migration — Gaps risks — Merge the Mac memory service and phone agent memory into one store; run both in parallel for a release and compare before switching reads.
52. Presence (A4) — Gaps — Server knows which device she is on from heartbeats (Mac already sends; phone would); drives one-place-at-a-time, no double notifications, alarm routing.
53. Alarm scheduling — Gaps collisions — Server schedule plus a local copy, de-duplicated by id; presence picks the device; an offline Mac still rings locally.
54. Behaviour lock (B1) — Gaps — A single "stay still" flag respected by walker, props, reactions and proactive lines; shared by typing stillness, focus sessions, meetings and screen share.
55. Hide-from-capture implementation — Gaps collisions/risks — Hide from capture by default with a developer switch for tests and an "appear in recordings" setting; verify on Zoom, Meet, Teams; fall back to detecting the share and hiding the window if capture paths don't honour it.
56. Doze never delays a task — Gaps collisions — Late-night doze is visual only; any input wakes her at once.
57. Task queue with locality — Road move 2 — Every task carries a locality (portable vs machine-bound); portable tasks run in iris-api immediately with the laptop shut; machine-bound tasks queue durably, run when the Mac wakes, result pushed to the phone; locality is a field beside the expert catalog's platform capability.
58. Agent loop on the Claude API — Road move 3 / Phase 1 — Replace the Claude Code fallback with a bounded tool-use loop in agent-svc via a tool-use endpoint in iris-api; Claude Code removed from the product.
59. Shortlisted tools — Road move 3 — Router's top two or three experts offered as tools, not all 54 functions (~400 tokens vs 2,100).
60. Prompt caching — Road move 3 — Cache the system prompt and tool definitions, identical on every loop step.
61. Small model first — Road move 3 — Escalate to a larger model only when a step stalls or fails verification.
62. Verify on every expert — Road move 3 — Each expert function gains a `verify` beside its `run`; the loop acts on the world's answer, not its own claim.
63. Hard stop — Road move 3 — Step cap, token budget per task, and an honest report of what was and wasn't done.
64. Chrome via element references — Road move 3 — Page sent as a compact list of interactive elements with reference ids; actions `click(ref)` and `type(ref, text)`.
65. OAuth broker — Road move 4 — iris-api brokers per-service authorisation (Google Drive, Docs, Gmail, Calendar first) with narrow scopes, encrypted refresh tokens, one-tap disconnect in settings; Iris never holds a user's browser sessions.
66. Fallbacks become experts — Road risks — Recurring agent-loop fallbacks are promoted to new experts so the long tail shrinks instead of being paid for each time.
67. Decline counter — Road Phase 0 — Count every request she declines; declined-request rate should fall sharply after Phase 1.
68. Phase gates — Road plan — Phase 0 (2–3 wks): §3.5 rules pass automated tests and cost measured; Phase 1 (3–4): declined request completes without Claude Code, within budget, verified; Phase 2 (5–6): phone creates a doc in Drive with Mac shut, Mac-only request queued from phone runs on wake; Phase 3 (6–8): stage-1 gate on Mac and iPhone; Phase 4 (4–6): Windows and Android users complete the same daily errands.
69. Phase dependencies — Road plan — Phases 0 and 1 run in parallel; Phase 2 needs Phase 1's loop; Phase 3 needs Phase 2's account; sizes tighten after Phase 0's cost audit and decline counter.
70. Wave order — Gaps — Six waves plus "Alongside": decisions first, Wave 1 (quick wins, 1–2 wks), Wave 2 (voice/privacy, 2 wks after D1–D3), Wave 3 (account/memory, 3 wks), Wave 4 (segment features, 3–4 wks), Wave 5 (every screen, 6–8 wks), Wave 6 (friends, 3 wks after D6), plans/payments alongside Waves 2–4.
71. Foundations before features — Gaps — Architecture changes are done once, before the features that sit on them (building features first would mean building them twice).
72. Live verification per wave — Gaps — Every wave is checked live on a real Mac before it counts as done.
73. Bluetooth helper — Gaps Wave 1 — Bluetooth toggling needs a small helper (macOS has no command); Do Not Disturb via a Shortcut (macOS Focus not directly scriptable); typing-stillness must not require Input Monitoring permission.
74. Deploy ownership — Road risks — An agreed deploy branch and a regular deploy slot for iris-api work (single deploy owner is a risk).
75. Calendar and deadline sources — Gaps Wave 4 — Calendar: Mac calendar first, Google for the phone; deadline tracking via Canvas calendar feed first (no OAuth); email drafts as Mail.app drafts; notification summary through connected mail and calendar.

### Legal, privacy, safety
76. AI disclosure — Gaps Wave 1 — Disclose that Iris is an AI at first run and in settings.
77. 18+ gate — Gaps Wave 1/D6 — 18+ confirmation at sign-up; friend network requires the gate first.
78. Friend-network safety — Gaps D6/Wave 6/risks — Rate limits, block and report in the first version; sender confirms every note; receiver chooses to play it; friend messages have a length rule; SB 243 exposure acknowledged.
79. Data protection for the library — Road risks — Synced library (files, photos, notes) needs encryption at rest, per-user isolation, item-level delete, reviewed before Phase 2 ships; DPDP applies in India.
80. Item-level memory delete — Gaps Wave 3, Road — Users can view and delete memory item by item.
81. Beta transcript privacy — Beta — Decide deliberately whether verbatim transcripts are shipped to the server and CloudWatch; inform testers; redaction mode exists (currently off).
82. Credential handling — Road move 4 — Credentials stay scoped and revocable; no stored browser sessions.

### Observability, support, beta operations
83. Tester-in-trouble alerting — Beta (blocks beta) — Alert when a tester is repeatedly ignored or in trouble; today 35 of 63 turns ignored with no flag.
84. App-side error reporting — Beta (blocks beta) — Electron `crashReporter` plus renderer `window.onerror` shipped through `/v1/logs`; white window, failed update, dead main process must leave a trace.
85. Honest chat error text — Beta — "Iris is not responding — is she running?" (chat.js:61) fires for any non-JSON reply including a 500; needs correct error surfacing.
86. Structured turn metrics — Beta — One structured line per turn (heard, routed, first sound) so latency and discard rate are charted, not hand-computed; baseline: median 0.0s model / p90 1.3s; median 1.5s mic-gate lateness; p90 2.5s uncached voice; 56% discard rate.
87. Daily digest per tester — Beta — Turns, ignored rate, errors, slowest turn; mailed or pushed to Telegram.
88. Alert on stack trace / 500 — Beta — Any traceback or HTTP 500 in a shipped log pings with tester and line.
89. `/admin/testers` — Beta — Endpoint listing email, version, last seen, turns today, error count.
90. Log retention — Beta — 5,000 lines per tester is too thin (one session ≈ 400 lines); routinely read the CloudWatch overflow or raise retention.
91. Keep existing telemetry — Beta — Log shipper (20 lines/15 s batches, machine id, flush on exit), `/admin/logs`, CloudWatch `/iris/agent`, `/v1/pet/health` remain in place.
92. Monitoring must be failure-tested — Beta — Before trusting any monitor, make it fail on purpose once and confirm it reports the failure.
93. Report runbook — Beta — Keep the six-step report-chasing procedure (find account by domain, pull log, count wake: outcomes, read discarded transcripts, reproduce against the real detector, check build vs fix date).
94. Version check before fixing — Beta — Compare the tester's version to the fix date first; half of reported bugs were already fixed and unshipped.
95. Product KPIs — Road — Track five numbers: daily opens per paying user; verified errand completion rate; declined-request rate; serving cost per active user by tier; hide and mute usage.
96. Presence-fatigue guard — Road risks — Quiet by default and invisible in meetings/while typing; rising hide/mute usage is the early warning.
