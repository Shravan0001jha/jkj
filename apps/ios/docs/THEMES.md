# Themes — Default and Sci-fi

Owner, 1 Nov 2026: *"one is the default which is current and add one sci-fi theme, should be
switchable … so as not to lose the current structure if the sci-fi version doesn't work, or if I
want more themes later … I want the app to feel like it's from the future."* Follow-up the same
day: *"work on the CX as well for sci fi details not just UI."*

Build order: this document (HLD → LLD → Sci-fi CX), then tests, then code.

---

## 1. HLD

### 1.1 Goals and hard rules

| # | Rule | How it is met |
|---|---|---|
| G1 | **Default is pixel-identical to today.** | Every themed modifier is an identity transform when the theme has no chrome (`theme.chrome == nil`): it either returns the content untouched or passes SwiftUI's own default value (`.automatic`, `nil`). Default's tokens equal today's literals (unit-tested). Proven by a pixel diff of every main screen, light and dark, against a build of `45dc1d8` (§8). |
| G2 | **More themes are cheap.** | A theme is one value: `Theme` (tokens + an optional `ThemeChrome`). Adding a theme = one new `static let` and, if it wants custom chrome, one `ThemeChrome` conformance. No screen changes. |
| G3 | **Switchable live, no relaunch.** | `ThemeStore` (`@Observable`, UserDefaults key `iris.theme`) at the root; `RootView` injects `\.theme`. Settings → Appearance → Theme. |
| G4 | **Sci-fi never breaks function.** | Same navigation, same data, same accessibility labels and identifiers; the native tab bar stays (UI tests and VoiceOver use it). The UI test suite runs under both themes (`WORKPLACE_THEME`). |
| G5 | **Accessible.** | Body text ≥ 4.5:1 on Sci-fi surfaces (unit-tested), Dynamic Type styles everywhere (no fixed sizes for text), Reduce Motion → static/fades, Low Power Mode → heavy effects off. State stays shape + colour + label. |
| G6 | **Smooth.** | Effects are Canvas/TimelineView at ≤ 30 fps, drawn behind lists (not per row), paused when the scene is inactive or the view is off screen. No Metal, no per-row timers. |

### 1.2 Architecture

```
WorkplaceApp ─ ThemeStore (@Observable, UserDefaults "iris.theme", DEBUG env WORKPLACE_THEME)
   └─ RootView
        .themeRoot(store)   → \.theme, \.motionLevel, preferredColorScheme, tint, boot overlay
          └─ screens read tokens through shared modifiers:
             .themedList()  .themedRow()  .themedCard(radius:)  .themedBar(_:)
             .themedTabChrome()  SectionHeader / Pill / ChatPalette / ChatWallpaper read \.theme
```

- **`Theme`** (struct, `Equatable` by id): `id`, `name`, `palette`, `type`, `radii`, `motion`,
  `chrome: ThemeChrome?`, `colorScheme: ColorScheme?`.
- **`ThemeChrome`** (protocol, class-bound, optional per theme): the view-builder hooks —
  `background`, `cardBackground`, `rowBackground`, `bubble(mine:)`, `wallpaper`, `tabChrome`,
  `bootOverlay`. Default has none, so the hooks are never called for it.
- **`MotionLevel`** (`full` / `reduced` / `off`), resolved once at the root from the theme's motion
  token, `accessibilityReduceMotion` and `ProcessInfo.isLowPowerModeEnabled`, and put in the
  environment; every effect reads it rather than the raw settings.
- **CX features** (Sci-fi only, §3) are separate views gated by `theme.features`, so Default never
  builds them.

### 1.3 Light mode

Sci-fi is **always dark** (`preferredColorScheme(.dark)`): deep space and neon do not survive a white
background, and a light variant would double the contrast work for no owner value. The system
appearance setting keeps working for Default. Documented in Settings' footer.

---

## 2. LLD

### 2.1 Tokens (Default = today's literal values)

| Token | Default (today) | Sci-fi |
|---|---|---|
| `palette.accent` | `Color.accentColor` (asset) | `#38E8FF` cyan |
| `palette.accent2` | `Color.accentColor` | `#B26BFF` violet |
| `palette.accent3` | `Color.accentColor` | `#FF4FD8` magenta |
| `palette.background` | system grouped background | `#05070F` → `#0B1430` space gradient |
| `palette.surface` | system (cells) | `#0E1A33` @ 0.72 (holo glass) |
| `palette.textPrimary` / `textSecondary` | `.primary` / `.secondary` | `#E8F6FF` / `#9FB7CC` |
| `palette.success/warning/danger/info` | `.green/.orange/.red/.blue` | system dark variants (unchanged hues, so state colours stay distinguishable) |
| `type.sectionHeader` | `.subheadline.weight(.semibold)`, secondary, no case | `.caption.monospaced().weight(.semibold)`, uppercase, tracking 1.6, accent |
| `type.timestamps` | proportional | monospaced digits |
| `radii.card` | 14 | 16 |
| `radii.bubble` / `bubbleTight` | 18 / 6 | 14 / 3 (angular, "HUD") |
| `radii.composer` | 20 | 12 |
| `radii.pillPaddingH` / `V` | 8 / 3 | 8 / 3 |
| `radii.progressHeight` | 6 | 6 |
| `motion.ambient` | none | starfield drift, radar sweep, pulse |
| `motion.spring` | `.snappy` | `.spring(response: 0.42, dampingFraction: 0.78)` |
| `features` | `[]` | `bridge, decisionQueue, commandPalette, quickReplies, transmission, haptics, boot, heroTransition` |

### 2.2 Modifiers (the only API screens use)

| Modifier | Default | Sci-fi |
|---|---|---|
| `.themedList()` | `.scrollContentBackground(.automatic)` (SwiftUI's default) | hides the system background, puts the space backdrop behind |
| `.themedRows()` (on a List's content) | `.listRowBackground(nil)` (default) | holo-glass row background with a neon edge |
| `.themedCard(radius:fill:)` | `background(fill, in: RoundedRectangle(radius))` — the exact call it replaces | glass + animated gradient border |
| `.themedBar(_ fill)` | `background(fill)` — the exact call it replaces | translucent HUD bar with a hairline |
| `.themedTabChrome()` | nothing | glowing dock underlay with a sweep on tab change |
| `.themedHaptic(_:trigger:)` | `sensoryFeedback` whose condition is always false | fires |
| `.themedProminent()` | `.buttonStyle(.borderedProminent)` | same, label in dark navy (white on neon cyan is 1.5:1; navy is 13:1) |
| `.themedScreen()` (non-list full screens: sign-in, offline states) | nothing | edge-to-edge backdrop |
| `.glow(on, color)` | nothing | neon shadow |

Lists are wrapped mechanically: `List { Group { …rows… }.themedRows() }.themedList()` — the row
background is a trait that a Group passes to every row of every Section inside it.

`SectionHeader`, `Pill`, `ChatPalette`, `ChatWallpaper`, `TypingBubble`, chat corner radii and
`ConnectionStrip` read the tokens directly.

### 2.3 ThemeStore

`ThemeStore(defaults:env:)`; `selected: ThemeID` (`default`, `scifi`), persisted on set; unknown
stored values fall back to Default; DEBUG env `WORKPLACE_THEME=default|scifi` overrides for scripted
runs without persisting. `uiSounds: Bool` (default **off**).

### 2.4 Motion catalogue (Sci-fi)

| Effect | Where | Full | Reduced (Reduce Motion) | Off (Low Power) |
|---|---|---|---|---|
| Starfield drift + twinkle | every list/chat backdrop | 2 layers parallax, 24 fps | static stars | static stars |
| Nebula | backdrop | static radial gradients | same | same |
| Holo border shimmer | cards, bridge | angular gradient rotates 8 s | static gradient | static |
| Radar sweep + blips | Bridge: live agents | 4 s sweep, 30 fps | static blips | static blips |
| Presence ping | online / working dots | ring scales out every 2 s | none | none |
| Status lock-in | item turns Done | flash + scale 1.15 → 1 | fade | none |
| Transmission arrival | new incoming chat message | scan line + blur-in 0.45 s | fade 0.2 s | none |
| Typing | chat | waveform bars | static dots + label | static |
| Tab switch | dock underlay | glow sweep 0.35 s | none | none |
| Boot | cold launch | "SYSTEM ONLINE" scan 0.9 s, tap-through, never blocks | 0.25 s fade | skipped |
| Hero transition | Plan epic → page | `.zoom` navigation transition (iOS 18+) | system push | system push |

All decorative layers are `accessibilityHidden` and `allowsHitTesting(false)`.

### 2.5 Perf and accessibility budget

- At most **one** TimelineView-driven Canvas per screen (the backdrop) plus the Bridge radar when
  visible; both pause on `scenePhase != .active` and `onDisappear`.
- Rows never own timers; per-row animation is limited to presence pings (repeat-forever transforms,
  composited by Core Animation) and is off below `full`.
- Contrast: `textPrimary`, `textSecondary` and `accent` ≥ 4.5:1 on both `background` stops and on
  `surface` composited over the background (unit test `SciFiContrastTests`).
- Dynamic Type: only text styles; the Bridge reflows to a vertical stack at accessibility sizes.

---

## 3. Sci-fi CX — "the command bridge"

The owner wants it to *feel* like the future, not just look it. Principle: **the app should already
know what you want to look at.** Every addition is Sci-fi only, uses data the app already has (plus
the dashboard snapshot), removes nothing and adds no taps to a common flow.

| Feature | What | Why this one (and not the alternatives) | Tested logic |
|---|---|---|---|
| **Bridge HUD** (top of Plan) | One glass panel: *system pulse* (socket live / offline, server version, Mac link), *needs you* (open Inbox count + the top item with its recommended answer as one button), *since you last looked* (what changed), *live agents* (radar + who is doing what, tap → Talk), *state counts strip*, and a command prompt. The normal Plan follows unchanged. | The owner opens the app to ask "what changed and what needs me". Today that is three tabs. Now it is the first screen. | `BridgeDigest` — the since-last-look diff; `BridgeSnapshot` persistence |
| **Since you last looked** | Diff of a saved snapshot (epic/story counts by state, open Inbox ids, last update id, blocked ids) against now: "+2 done · 1 newly blocked · 3 new decisions · 5 updates". Snapshot saved when the app goes to the background after the Plan was seen. | Cheap, local, honest — no new server API. | `BridgeDigestTests` |
| **Decision queue** (top of Inbox) | Open items as a card stack, one card at a time: swipe right (or its button) = the recommended option (only when it is neither `danger` nor `needsNote`), swipe left / "Later" = moves to the back (local only), "All options" opens the item with every option (unchanged rules: danger confirms, needsNote asks). A 4-second **undo window** before the answer is sent; device auth still runs where the server requires it (inside `AppModel.answer`); haptic on commit. The full list stays below. | Fastest safe decision path. A swipe never declines and never runs a danger option. | `DecisionQueueTests` (order, defer, eligibility, staged answer + undo + commit) |
| **Command palette** | Prompt in the Bridge (`> jump to…`) opens a sheet: type to find any epic, story, Inbox item, person or room, or run an action (Settings, Spend, Alerts, Office, Ship a release, New request, switch theme). Local search over cached data. | Replaces hunting through menus; no server work. | `CommandSearchTests` (ranking: exact > prefix > word prefix > substring > subsequence; kind tiebreak) |
| **Quick replies** | In the COO chat: chips above the composer that send at one tap. If the COO's last message asks something: "Yes, go ahead" / "Hold off" / "Explain more"; otherwise "Status?" / "Thanks". | The COO thread is the most-used chat; most replies are one of these. | `QuickRepliesTests` |
| **Transmission feel** | New incoming messages arrive with a scan-line decode, typing shows as a waveform, chat times are monospaced mission time (`09:41`). | Makes a live conversation feel live. | layout only (no logic) |
| **Ambient awareness** | Backdrop pulse dims when the socket is offline; presence and working states ping; an item that becomes Done "locks in". | Status changes are noticed without reading. | `MotionLevel` resolution |
| **Micro-interactions** | Haptics on tab switch, send, answer, swipe commit; spring physics; hero zoom from a Plan epic to its page; **interface sounds off by default** (Settings toggle, system tick sounds). | Physicality without noise. | `ThemeStore` (sounds default off) |
| *Future, out of scope* | Live Activity / Dynamic Island for a running decision; widgets. Need app extensions and App ID changes. | — | — |

Changed while building: the queue card shows only the safe recommended answer as a button —
replicating the full option rules (confirm, note) on a card would fork that logic; the item page
keeps them, one tap away, exactly as in Default.

Rejected: a custom tab bar (would break VoiceOver order and every UI test that taps
`tabBars.buttons[…]` — the native bar is kept and dressed instead); decoding/scrambling text
animations (would change accessibility labels mid-animation); always-on particle effects in rows
(scroll cost).

---

## 4. Tests (written before the code)

| Test file | Covers |
|---|---|
| `ThemeTests` | Default tokens equal today's literals; ThemeStore persistence, fallback, env override; sounds off by default; theme switch updates `\.theme` in a rendered view; `MotionLevel` (reduce motion → reduced, low power → off, Default → off) |
| `SciFiContrastTests` | WCAG contrast of the Sci-fi palette ≥ 4.5:1 for body text and accent |
| `BridgeDigestTests` | since-last-look diff, snapshot round trip |
| `DecisionQueueTests` | ordering, swipe eligibility, defer, staged answer with undo, commit |
| `CommandSearchTests` | ranking and action entries |
| `QuickRepliesTests` | suggestions by context |
| UI tests | whole existing suite under `WORKPLACE_THEME=default` and `=scifi` |

---

## 5. Running it

```
node mock/server.mjs --port 4413 --reusable-code --quiet --no-live      # screenshots (deterministic)
node mock/server.mjs --port 4415 --reusable-code --quiet                # UI tests
node mock/server.mjs --port 4416 --talk-threads --reusable-code --quiet # UI tests (AppFixes)
TEST_RUNNER_MOCK_PORT=4415 TEST_RUNNER_TALK_MOCK_PORT=4416 TEST_RUNNER_THEME=scifi \
  xcodebuild -scheme IrisWorkplaceUI … test                              # UI suite under Sci-fi
scripts/theme-diff.sh <baseline.app> <new.app> build/diff 4413 "iPhone 17"   # Default proof
scripts/shots-themes.sh <app> <out> dark scifi 4413                       # Sci-fi screens
```

## 8. Evidence and results (1 Nov 2026)

`docs/evidence/themes/` (README.txt lists the folders). Scripts: `shots-themes.sh`, `theme-diff.sh`,
`theme-diff-dash.sh`, `imagediff.swift`, `anim-frames.sh`, `ui-themes.sh`, `idle-frames.sh`.

**Default is unchanged** — new build (theme = default) vs the baseline build of `78b0bfe`
(45dc1d8 + Dashboard v2), same mock (`--no-live`), status bar pinned, full 1206×2622 pixels:
- 16 screens × light/dark: 30 of 32 identical (0 px). Talk thread: 26 px (light) / 2 px (dark),
  every one off by exactly 1/255 in one channel on text anti-aliasing — compositing rounding, not
  visible. Inbox item first showed ~850 px at the card corners (themedCard passed a corner style
  the original call did not); fixed, now 0 px light and dark.
- Dashboard v2 (7 frames × light/dark, scrolled by a UI test): earlier run 13 of 14 identical, the
  14th 9 px of chart anti-aliasing; in the final run three light frames landed a few points apart
  (drag offset, same content).
- Settings gains the Appearance section at the bottom (by design); the first screen is identical.

**Tests**: unit 295/295, `make check` ok. UI suite (34 tests) per theme: baseline 33/34, Default
33/34, Sci-fi 32-33/34; the steady failure, `RelayUITests.testMacOfflineIsShownAndRecovers`,
fails on the untouched baseline too. AppFixes needs a fresh `--talk-threads` mock per run (it does
not reset it; replies pile up).

**Performance** (simulator, DEBUG frame probe, slow = frame > 1.5× interval): idle Plan 0.0-0.2%
both themes (Sci-fi was 7.6% before the shimmer rewrite); scrolling the Plan, Default ~2.1%,
Sci-fi ~3.3%, and still 3.2% with every Sci-fi effect off — the gap is the Bridge's extra content,
not the effects. Device check with Instruments recommended.
