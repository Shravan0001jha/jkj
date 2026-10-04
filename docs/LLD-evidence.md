# LLD — `run_evidence`

Implements `docs/HLD-evidence.md`. Files are under `packages/server/src/` unless noted.

## 1. Data

Shared (`packages/shared/src/workplace.ts`, optional and additive):

```ts
type EvidenceState = 'success' | 'failure' | 'stale' | 'error';
interface EvidenceRunRecord {            // WorkItem.evidenceRun: the item's latest finished run
  run: string;                           // "<sha12>-<yyyymmddHHMMSS>", the run directory's name
  sha: string; state: EvidenceState;
  platforms: string[]; features: string[];
  passed: number; failed: number;        // checks, from results.json
  failures: string[];                    // one line each, from summary.txt (max 10)
  durationS: number;                     // queue start → report (build + run)
  report: string;                        // the route path /api/evidence/<item>/<run>/index.html
  by: string; at: string;
  note?: string;                         // why stale / error / build failure
}
```

A job (`EvidenceJob`, server only) is persisted as a settings row `evidence:job:<id>`:
`{ id, itemId, by, platforms, features, state: 'queued'|'building'|'running'|'done', slot?,
queuedAt, startedAt?, finishedAt?, sha?, run?, pid?, attempts, phase?, result?: EvidenceRunRecord }`.
Finished jobs are kept (the newest 30) for `GET /api/coo/evidence`.

Config (`config.ts`, `evidence`; env overrides):
| key | default | env |
|---|---|---|
| `dir` | `<workplaceDir>/evidence` | `WORKPLACE_EVIDENCE_DIR` |
| `stagingUrl` | `https://staging.irisforu.com` | `WORKPLACE_STAGING_URL` |
| `stagingScript` | `~/claude-dev/scripts/staging.sh` | `WORKPLACE_STAGING_SCRIPT` |
| `runnerFallback` | `~/iris-e2e/scripts/local-run.sh` | `WORKPLACE_EVIDENCE_RUNNER` |
| `runnerInRepo` | `e2e/scripts/local-run.sh` | — |
| `androidHome` | `/opt/homebrew/share/android-commandlinetools` | `ANDROID_HOME` |
| `developerDir` | `/Applications/Xcode.app/Contents/Developer` | `WORKPLACE_DEVELOPER_DIR` |
| `slots` | 2 | — |
| `keepBuilds` | 4 per platform | — |
| `appPaths` | android `mobile/android`, ios `mobile/ios` | — |

## 2. Ports (`services/evidence-ports.ts`)

```ts
interface RunnerRequest { runner: string; platforms: string[]; features: string[]; api: string;
  apps: Partial<Record<'android'|'ios', string>>; slot: 1|2; out: string; cwd: string; log: string;
  onSpawn?(pid: number): void }
interface RunnerOutcome { exitCode: number | null; signal?: string; stderrTail: string }
interface EvidenceRunner { run(r: RunnerRequest): Promise<RunnerOutcome> }

interface BuildRequest { platform: 'android'|'ios'; checkout: string; appDir: string; api: string;
  out: string /* dir for the artifact */; log: string; onSpawn?(pid: number): void }
interface AppBuilder { build(r: BuildRequest): Promise<string /* artifact path */> }  // throws BuildError

interface Staging { ensureUp(): Promise<void> }   // throws StagingError
```

- `RealRunner`: `bash <runner> --platforms … --features … --api … [--app-android …] [--app-ios …]
  --slot n --out …`, `detached: true` (own process group), allow-listed env (PATH, HOME, USER,
  LOGNAME, SHELL, LANG, LC_ALL, TMPDIR, TERM, AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION,
  AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE, JAVA_HOME, plus ANDROID_HOME, DEVELOPER_DIR,
  IRIS_API = staging); stdout+stderr go to a log outside `--out` (the runner wants it empty) and are
  moved to `<run>/workplace/runner.log` afterwards, with the build logs; hard timeout 100 min (group
  SIGTERM, then SIGKILL after 20 s).
- `RealBuilder`:
  - android: writes `local.properties` (`sdk.dir=<androidHome>`) when missing; gradle init script
    (in the evidence dir) that sets `buildConfigField("String","API_URL","\"<api>\"")` in
    `afterEvaluate`; `./gradlew --no-daemon -I <init> :app:assembleDebug`; verifies
    `app/build/generated/source/buildConfig/debug/**/BuildConfig.java` contains the API; copies
    `app/build/outputs/apk/debug/app-debug.apk` to `<out>/Iris.apk`.
  - ios: `xcodegen generate` (the project is generated), patches the one line
    `static let base = "https://api.irisforu.com"` in `Iris/Net/Api.swift` (exactly one match, else
    BuildError), `xcodebuild -project Iris.xcodeproj -scheme Iris -configuration Debug -sdk
    iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/evidence-dd
    build` with `DEVELOPER_DIR`, restores the file (`git checkout --`) in `finally`, verifies the
    binary contains the staging host, copies `Iris.app` to `<out>/Iris.app` (`ditto`).
  - Each command: detached process group, 30 min timeout, output appended to the build log.
- `RealStaging`: `GET <stagingUrl>/healthz` (5 s); if not 200: `bash <stagingScript> start` (12 min
  timeout; it waits for health itself), then health again. Concurrent callers share one attempt.
  Never stops staging.

Registry: `useEvidencePorts(wp, partial)` / `portsOf(wp)` (WeakMap, real ones built lazily).

## 3. Service (`services/evidence.ts`)

`request(wp, {itemId, by, platforms, features}) → { job, position, message } | { refused }`:
1. Parse `platforms`/`features` (comma list or array; lowercased; `all` passed through).
   `mac|desktop|macos` → refused `DESKTOP_REFUSAL`. Unknown platform (not android/ios) → refused.
   Empty platforms → refused. Features: `^[a-z][a-z0-9-]*$` each, at least one.
2. Item exists, is not an epic, has an agent assignee; caller is the assignee, the reviewer, a lead
   or QA. The branch `emp/<assignee>/<item>` exists in the assignee's repo with commits past the trunk.
3. Duplicate (same item, platforms, features, branch head, still queued or active) → its position.
4. Persist the job (`queued`), append to the FIFO, `pump()` on the next tick, return
   `queued (position N)` where N is its 1-based place among queued jobs at the call.

`pump(wp)`: while a slot (1..slots) is free and the FIFO is not empty, take the head job and
`execute(wp, job, slot)` (not awaited; its promise is tracked for `settled()`).

`execute(wp, job, slot)`:
1. `state=building`; `sha = rev-parse refs/heads/<branch>`; `run = <sha12>-<ts>`; run dir
   `<dir>/<itemId>/<run>` must not exist (the runner wants an empty `--out`; created by it).
2. Checkout `<workDir>/_evidence/<repo>/slot-<n>` (worktree, detached, forced, `git clean -fdq`).
3. `stagingUp = ports.staging.ensureUp()` started now (awaited before the run).
4. Per platform (in order): `plan = buildPlan(repo, trunk, sha, platform)` →
   `{ source: sha|trunkHead, key }`; cache hit → artifact path; miss → under the build lock: checkout
   at `source`, `builder.build`, store `<dir>/_builds/<platform>/<key>/` (+ `build.json`), prune to
   `keepBuilds`, checkout back at `sha`. A BuildError → outcome `failure` (story code) with the log
   tail; anything else → `error`.
5. Runner path: `<checkout>/<runnerInRepo>` if present (and `npm ci` in its dir when
   `package-lock.json` hash ≠ `node_modules/.workplace-lock`), else `runnerFallback`; neither →
   `error`.
6. `await stagingUp` (error → `error`), `state=running`, `runner.run(...)`.
7. Outcome: read `results.json` (`verdict`, `counts`) and `summary.txt` (`FAILURES` block). Exit 2
   or no summary → `error` (the runner's last stderr line as note). Verdict PASS → `success`, else
   `failure`. Then `head = rev-parse refs/heads/<branch>`; `head !== sha` → `stale`.
8. `record(wp, job, rec)`: `WorkItem.evidenceRun = rec` (saveQuiet), item comment (summary, failures,
   report link, duration; `details` = the failure lines), trail `test` entry. In `shadow`/`on`, if the
   item has a PR with `headSha === sha`: `setEvidence(wp, id, state==='error' ? (skip) :
   state, note)` (`stale` → pending status). Infra `error` → `coo.notifyStall`.
9. `deliver(wp, job, text)`: the caller's open session (`runs.sendMessage`, from `workplace`) gets
   the summary; with no open session the item comment is the delivery. Recorded in the job
   (`delivered: 'session'|'item'`).
10. `state=done`, slot freed, `pump()`.

`state(wp)` → `{ slots: [{slot, job?}], queued: Job[] (with position), recent: Job[] }`.

`startEvidence(wp)` (boot): load jobs; `building`/`running` → kill the recorded process group if it
is still a runner/build of ours (`ps -o command=` contains the run dir or checkout path), `attempts<2`
→ queued again (front, in `queuedAt` order) with an item comment, else recorded `error`; `queued` →
FIFO in `queuedAt` order; then `pump()`. Returns `stop()` which marks active jobs for re-queue and
kills their process groups.

`settled()` (tests): resolves when every active execution has finished.

Wording (handbook, "A story's life" step 4):
- queued: `Evidence run queued (position N): <platforms> / <features> on <sha8> of <branch>. It
  runs on the Mac's simulators against the staging server and links a report with screenshots to
  your story. Don't wait for it: the summary comes back to you and onto the story when it finishes.`
- refusals, each ending with the next step: desktop (`DESKTOP_REFUSAL`), Windows (`Windows can't run
  on the Mac: Windows evidence is a cloud robot run that QA schedules; ask QA on the item.`), no
  branch / no commits (`… commit your change on emp/<you>/<story>, then call run_evidence again.`),
  not allowed (`… ask the story's author on the item.`), unknown platform, no item.
- result: `Evidence <PASS|FAIL|STALE|ERROR> for "<title>" on <sha8>: <n> passed, <m> failed
  (<duration>). Report: <link>.` + failures (max 5 lines) + the next step (`stale`: run it again on
  the new commit; `failure`: open the screenshots of the failures only, fix, commit, run again).

## 3a. The global link (`services/evidence-share.ts`, HLD D13)

- `EvidenceStore { put(file, key); presign(key, seconds) }`; real = `S3Store` (aws CLI, region
  ap-south-1; `bucket()` ensures the bucket once per process and re-applies its settings); tests
  install `FakeStore` (`useEvidenceStore`); under a test with no fake the store is unavailable, so a
  test can never reach AWS.
- `finish()`: `share()` writes `<run>/evidence.html` (`bundle()`: `<img src>` of files inside the run
  → data URIs, other relative links → `#`, a header line, `summary.txt` appended) and uploads it as
  `<item>/<run>/evidence.html`; `EvidenceRunRecord.share = {key, url, expiresAt}`. Then `slim()`.
  `summaryText` names the URL, or "link unavailable". In shadow/on the summary is also a PR comment
  (`GitHubPort.comment`, push App); a PR that takes over a run comments its link too.
- `statusesFor`: `workplace/evidence` gets `targetUrl` = the share of the run behind it.
  `postStatuses`: before posting it, `freshLink()` re-signs a link with under an hour left.

## 4. `onReview` takes over evidence (github-flow.ts)

When a PR record is created (no reuse), `evidence` starts from the item's `evidenceRun` if its `sha`
is the head and its state is `success`/`failure` (with its note); else `pending`. Statuses are posted
as before.

## 5. Routes (`http/routes.ts`)

- `GET /api/coo/evidence` (loopback only, like every `/api/coo` route): `evidence.state(wp)`.
- `GET /api/evidence/:item/:run/<path…>` (auth like every `/api` route; tunnel allowed):
  `item` `^[A-Za-z0-9_-]{1,64}$`, `run` `^[0-9a-f]{7,40}-\d{14}$`, each path segment decoded,
  non-empty, not `.`/`..`, no `\`, NUL or leading `.`; default `index.html`; resolve under
  `<dir>/<item>/<run>`, `realpath` must stay inside the run's realpath; only regular files; MIME by
  extension (html, png, jpg, jpeg, gif, webp, json, txt, log, css, js, svg, mp4); headers
  `content-security-policy: sandbox allow-scripts; default-src 'self' 'unsafe-inline' data:`,
  `x-content-type-options: nosniff`, `cache-control: private, max-age=300`. 404 otherwise.

## 6. Tool (`services/employees.ts`)

`run_evidence { itemId?: string, platforms: string, features: string }` (comma lists; a string
because `z.union`/`z.record` break MCP tool listing). In `WORKPLACE_TOOLS`. `itemId` defaults to
`session().assignmentId`; none → `Name the story: no story is attached to this session.`

## 7. Tests (fake runner, fake builder, fake staging; real git in temp repos)

`test/evidence.test.ts`:
1. Immediate return: the tool replies `queued (position 1)` while the fake runner is still blocked.
2. Two slots: three requests → two running (slots 1 and 2), the third queued (position 1 of the
   queue in `state()`); finishing one starts the third on the freed slot; FIFO order.
3. Result to a session: an open session of the caller gets one message with the summary (no
   screenshots, report link present); the item gets the comment and `evidenceRun`.
4. Result to the item when no session is open: comment + `evidenceRun`, nothing sent.
5. Stale SHA: a commit lands on the branch during the run → `stale`, never success; in `shadow` the
   PR status stays pending ("Stale").
6. Desktop refusal (`mac`, `desktop`), Windows refusal, no-branch refusal, outsider refusal.
7. Build cache: miss builds once; the same app tree again → hit (no build); a story that touches no
   app code builds from the trunk head and reuses that build; a change under `mobile/android` →
   miss.
8. Report route: serves `index.html` and a screenshot; `..` (raw and encoded), absolute, backslash,
   bad run id, and a symlink out of the run dir → 404; off-loopback without the token → 401;
   through the tunnel header → 200; `GET /api/coo/evidence` refused through the tunnel.
9. `local` mode: the run is recorded on the item and commented; GitHub is never called.
10. `shadow` with a PR on the run's SHA: `workplace/evidence` success / failure posted; evidence run
    before the PR is taken over when the PR opens.
11. Restart: a job persisted as `running` is queued again on boot with a note.

## 8. Real gate

A throwaway story branch in a temp clone of `~/claude-dev`, Android built at that commit with the
real builder, `features: setup` (or the smallest set the runner accepts) on android against staging,
with the real runner. Reported: build time, run time, result. Script:
`packages/server/test/trials/evidence-gate.trial.mts`.
