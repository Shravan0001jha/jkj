# HLD — `run_evidence`: the robot suite on the Mac, for a story's commit, against staging

Infra checkpoint 7. The LLD is `docs/LLD-evidence.md`; the tests are
`packages/server/test/evidence*.test.ts`. It fills the hook the GitHub flow left for it
(`setEvidence`, docs/HLD-github-flow.md D7).

## 1. Problem

The handbook's step 4 ("A story's life") says: call `run_evidence` with the platforms and features
your change touches; it runs on the Mac's simulators against the staging server and links a report
with screenshots to your story. Today there is no such tool. Employees either skip phone evidence
or try to drive simulators from their worktrees, which lack Xcode (`xcode-select` points at the
command-line tools), share two emulators with everyone else, and talk to production.

The robot suite (iris-e2e, moving into the Iris repo at `e2e/`) now has a local runner,
`scripts/local-run.sh`, that runs the suite on this Mac in one of two device slots and writes
`results.json`, `index.html` and a one-screen `summary.txt`.

## 2. Goals and non-goals

Goals
- A Workplace tool `run_evidence {itemId?, platforms, features}` that returns at once with
  "queued (position N)" and never blocks the caller's turn.
- One server-side queue: FIFO, at most 2 runs at once (the runner's slots 1 and 2).
- The app is built from the story branch's head commit in a server-owned checkout, never an
  employee's worktree; Android with gradle, iOS with xcodebuild (full Xcode). Builds are cached by
  the content of the app's paths; a story that changes no app code reuses the trunk's build.
- The app talks to staging, which the tool starts if it is stopped (it idles off by itself).
- Each run is stored under `~/iris-workplace/evidence/<item>/<sha>-<ts>/`, summarised on the item,
  sent to the caller's session as a short summary, and recorded against the commit: in `shadow`/`on`
  it drives the `workplace/evidence` status; in `local` it is recorded on the item only.
- A report route on the Workplace HTTP server, safe on loopback and through the tunnel.

Non-goals
- Mac desktop features (they take over the owner's screen and speakers): refused; the COO runs
  them in a live window.
- Windows (cloud only), cloud runs, flaky-test quarantine (QA's), deploying the story's server code
  to staging (staging runs what was last deployed; server changes are evidenced by their suites).
- Editing the runner: it is owned by another charter; this wraps it behind an interface.

## 3. Flow

```
run_evidence ──► evidence.request ──► validate (desktop? item? branch? caller?)
                       │                  └─► refusal: one sentence with the next step
                       ▼
                 queue (FIFO, persisted) ──► "queued (position N)"   ◄── returns here
                       │  a slot frees (max 2)
                       ▼
   slot n: head = branch tip ─► checkout <work>/_evidence/<repo>/slot-n at head
           ├─► staging.ensureUp()  (in parallel with the build; health, else staging.sh start)
           ├─► per platform: build cache hit? else build (one build at a time) ─► cached artifact
           └─► runner: <checkout>/e2e/scripts/local-run.sh (fallback: configured iris-e2e clone)
                  --platforms --features --api <staging> --app-* --slot n --out evidence/<item>/<sha>-<ts>
                       │
                       ▼
   outcome: head moved? ─► stale │ pass ─► success │ fail / build broken ─► failure │ infra ─► error
           ├─► item: evidenceRun record + comment (counts, failures, report link, duration)
           ├─► setEvidence(item, state, note)   (shadow/on, PR on this SHA: workplace/evidence)
           └─► caller's open session: the summary only (else the item comment is the delivery)
```

## 4. Key decisions

- **D1 Ports.** `EvidenceRunner` (the runner), `AppBuilder` (gradle / xcodebuild) and `Staging`
  (health, start) are interfaces; the real ones shell out, the tests use fakes. Git is real in tests
  too (temp repos), like the GitHub flow's fake.
- **D2 Return at once.** The tool only validates and enqueues; the pump runs on the event loop.
  Results are pushed (session message + item comment), never polled. A duplicate request for the
  same item, head, platforms and features returns the existing place in the queue.
- **D3 Two slots, one build at a time.** Runs hold a slot from checkout to report, so two runs never
  share devices or a checkout (one checkout per slot). Builds also take a single build lock: with the
  quality checks' own serial queue that keeps heavy builds at 2 on the Mac (the handbook's cap).
- **D4 Head at start, stale at end.** A queued run builds the branch head when it starts (the
  newest commit is what needs evidence). If the branch head is different when the run finishes,
  the run is `stale`: never `success`, whatever the suite said.
- **D5 Build cache by content.** Key = platform + git tree id of the app's path (`mobile/android`,
  `mobile/ios`) at the build commit + a hash of the build options (staging URL, builder version). A
  tree id is exactly "the commit of the app's paths": two commits with the same app code share it.
  If the story's diff from its merge base with the trunk does not touch the app path, the build commit
  is the trunk head: such a story reuses the latest trunk build (built once per trunk app change).
  The cache keeps the newest 4 builds per platform.
- **D6 Staging, least invasive.** Android: `API_URL` is a `buildConfigField`; a gradle init script
  outside the repo overrides it after the build script, and the build is verified (the generated
  `BuildConfig.java` must name staging) so a run can never talk to production by mistake. iOS: the
  base is a Swift constant (`Api.base`) with no runtime override, so the server-owned checkout patches
  that one line for the build and restores it right after; exactly one match is required, and the
  built binary must contain the staging host. A follow-up for the mobile charter (a build setting for
  the API base) removes the patch.
- **D7 The runner comes with the code.** It runs from the checkout it built (`e2e/scripts/
  local-run.sh`), so a story that changes a robot test is evidenced with its own test. Until `e2e/`
  exists at that commit, a configured iris-e2e clone is used. Dependencies of `e2e/` are installed in
  the checkout with `npm ci` when its lockfile changes.
- **D8 Secrets stay in the runner.** The runner reads its secrets itself (`local-secrets.sh`). The
  Workplace passes it an allow-listed environment (no OAuth token, no API keys of its own), stores
  its output only in the run directory, and never logs its environment.
- **D9 Recording.** Every finished run is recorded on the item (`evidenceRun`) and commented. In
  `shadow`/`on` with a PR whose head is the run's commit, `setEvidence` posts `workplace/evidence`
  (success / failure; stale stays pending). A PR opened later on the same commit takes the item's
  evidence over (`onReview`), because the handbook runs evidence (step 4) before submitting (step 5).
  In `local` nothing is posted.
- **D10 Restarts.** Jobs are persisted (settings rows). On boot, queued jobs are queued again in
  order; a job that was building or running when the Workplace stopped has its process group killed
  and is queued again once, with a note on the item. On shutdown, running children are stopped.
- **D11 Report route.** `GET /api/evidence/<item>/<run>/<path>` serves a run's `index.html` and its
  files: read-only, ids and segments validated, the real path must stay inside the run directory
  (symlinks included), same auth as every `/api` route (loopback, the tunnel, or the bearer token).
  The report is served with `Content-Security-Policy: sandbox` so its HTML can never act as the
  Workplace origin.
- **D12 Desktop.** `mac` (or `desktop`, `macos`) in `platforms` is refused with "Mac desktop checks
  need a live window from the COO; ask on the item." The runner is never given `--allow-desktop`.
  Which features each phone platform supports is the runner's table, not duplicated here: a feature a
  platform lacks is skipped by the runner (its setup checks still run).

## 5. Risks

- A run takes minutes (Android ~9 min, iOS ~3.5 min, plus builds); the queue can grow. The queue is
  visible at `GET /api/coo/evidence`, and agents never wait on it.
- Staging runs the last deployed server code, not the story's: server changes are not evidenced by
  this tool (handbook: server suites + a check against staging).
- The iOS line patch depends on one line of `Api.swift`; it fails closed (no build) when the line
  changes, with a clear message to the COO.
- Memory: the Mac sits near 15 of 18 GB with devices up; 2 slots is the ceiling.
