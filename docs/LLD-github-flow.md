# LLD — GitHub pull-request flow, two approvals, local quality checks

Implements `docs/HLD-github-flow.md`. Files are under `packages/server/src/services/` unless noted.

## 1. Data

`WorkItem.pr?: PrRecord` (shared `workplace.ts`, optional and additive; stored in the item JSON):

```ts
interface PrApproval { by: string; at: string; sha: string; episode: string; note?: string }
interface PrRecord {
  number: number; url: string; branch: string; base: string;
  headSha: string; pushedAt: string;
  devApproval?: PrApproval; qaApproval?: PrApproval;
  evidence: 'pending' | 'stale' | 'success' | 'failure';
  tests?: { state: 'pending' | 'success' | 'failure' | 'error'; sha: string; at: string; summary: string; details?: string };
  sendBack?: { by: string; at: string; note: string; disputedAt?: string };
  evidenceNote?: string;
  posted?: Record<string, string>;                             // context -> "sha|state|description" last posted
  merged?: { at: string; sha: string; by: string };
}
```

`WorkItem.prRefused?: { at, sha, reasons }` — the last push refusal (there may be no PR yet).

Settings rows: `github:mode` (`local|shadow|on`, absent = `local`), `github:failures` (ISO times,
pruned to 5 min), `github:fallback` (`{at, from, reason}`).

Config (`config.ts`, env overrides): `github.org` (`shravan0001jha-iris-hq`), `github.repo` (`iris`),
`github.trunk` (`feat/iris-character`), `github.tokenScript` (`<opsDir>/github/token.py`), `github.python` (`<opsDir>/github/.venv/bin/python`,
which has PyJWT),
`github.pushApp` (`iris-workplace`), `github.reviewApp` (`iris-review`), `github.linkBase`
(`http://127.0.0.1:<port>`).

## 2. `github-port.ts`

```ts
interface PullRequest { number: number; url: string; headSha: string; state: 'open' | 'closed'; merged: boolean }
interface GitHubPort {
  push(repoDir: string, branch: string): Promise<void>;                  // never forced
  findOpenPr(branch: string): Promise<PullRequest | null>;
  openPr(pr: { title: string; body: string; head: string; base: string }): Promise<PullRequest>;
  getPr(n: number): Promise<PullRequest>;
  setStatus(sha: string, s: { context: string; state: StatusState; description: string }): Promise<void>;
  merge(n: number, sha: string, title: string): Promise<{ merged: boolean; sha?: string }>;  // merge commit
  deleteBranch(branch: string): Promise<void>;
  pullFfOnly(repoDir: string, branch: string): Promise<void>;            // throws NotFastForward
}
```

`RealGitHub`: tokens from `python3 token.py <slug>` (20 s timeout, stdout only, cached 50 min, never
logged); REST via fetch with `x-github-api-version: 2022-11-28`; git with `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_COUNT=2`, `credential.helper=` and `http.https://github.com/.extraheader=AUTHORIZATION:
basic <b64(x-access-token:token)>` in the child's environment only. Every error message passes
through `redact()` (strips `gh[a-z]_…`, `x-access-token:…`, `basic …`). `openPr` falls back to
`findOpenPr` on 422 (a PR for that head already exists).

Registry: `setGitHubPort(wp, port)` / `gitHubPort(wp)` (WeakMap; the real one is built lazily).

## 3. `review-policy.ts` (pure)

- `isDeveloper(emp)`: `roleId === 'lead'`. Dev approver: a developer, not the author (a lead's own
  story: another lead — the same rule).
- `isQa(emp)`: `roleId === 'qa'` or holds the quality charter `qa-release` (Zoya). QA approver: QA,
  not the author, not the developer approver.
- `holds(approval, w)`: `approval.sha === w.pr.headSha && approval.episode === w.statusSince &&
  w.status === 'in-review'`.
- `stage(w)`: `'dev' | 'qa' | 'approved'`.
- `doneGate(w, by)`: in mode `on`, for an item with a PR, `done` by anyone but the owner needs both
  approvals to hold. Called from `items.update`'s `checkMove` (reads the mode from settings; local and
  shadow return null, so `items.ts` behaves exactly as before).
- `qaReviewer(org, w, exclude)`: the item's reviewer if QA, else the `qa` role holder, else the
  quality-charter holder, never the author.

## 4. `github-flow.ts`

`mode(wp)`, `setMode(wp, mode, by)`, `state(wp)` (mode, fallback, recent failures).

`onReview(wp, itemId, by) → ReviewResult` (from `report_done` after it succeeds, and `request_review`):
1. mode `local` → `{ skipped: 'local' }`, nothing else.
2. Applies only to an agent assignee whose workspace branch is the trunk; branch =
   `branchFor(emp, itemId)`; no local branch or no commits past the trunk → skipped (non-code work).
3. Push guard (`quality.pushGuard`): branch name regex `^emp/[a-z0-9][a-z0-9-]*/[A-Za-z0-9_-]+$` and
   equal to the expected name; build output; gitleaks over `trunk..branch`; file size. Refused →
   `pr.refused`, item comment, return the reasons (the tool tells the employee). Not a failure.
4. Head SHA; if it differs from `pr.headSha`, approvals no longer hold (D3) and evidence → `stale`.
5. `push`; PR found or opened (title `<title> [<id>]`, body: id, link, author, evidence placeholder);
   `pr` saved with `work.saveQuiet`; trail note "Pushed … PR #n".
6. In `on` only, the reviewer becomes the developer approver (the author's lead, else the lead with
   the fewest open reviews); shadow leaves the reviewer as it is.
7. Statuses posted (only those that changed); `workplace/tests` from the author's pre-pr.sh result for
   the head (`pre-pr.ts`; D9; pending when there is none). Formerly: quality run queued (`tests` promise in the result) in
   a server-owned detached checkout `<workDir>/_quality/<repo>`, put on the head inside the queue;
   `settled()` waits for in-flight runs. A failed run is commented on the item.
Any GitHub error → `recordFailure` (fallback at 3 in 5 min) and a note on the item.

`approve(wp, itemId, by, note)`: local → refused; requires in-review + pr; `syncHead` first (moved
→ re-push, refuse with "new commits"); stage `dev` → `isDeveloper` and not the author → record,
reviewer becomes `qaReviewer`; stage `qa` → `isQa`, not the author/dev approver → record, then
`items.update(status done, reviewerId: by)`. Statuses re-posted.

`sendBack(wp, itemId, by, note)`: a reviewer (developer or QA, not the author) → `pr.sendBack`,
`items.update(status in-progress, note)`.

`dispute(wp, itemId, by, reason)`: only the author, only after a QA send-back → `manager.alert` with
key `dispute:<id>:<sendBack.at>` (Asha → COO after 15 min → owner via the COO's forward).

`setEvidence(wp, itemId, state, description)`: the evidence hook, called by `run_evidence` when a run on
the PR's head finishes (docs/LLD-evidence.md); a PR opened on a commit that already has evidence takes it
over from `WorkItem.evidenceRun`.

`syncHeads(wp)`: one-minute sweep (mode ≠ local) of in-review items: a PR whose head moved →
`onReview` again; no PR yet (the first push failed) → retried, unless that head was refused.

`merge(wp, itemId, by)`: local → refused; shadow → dry run `{ merged: false, wouldMerge, blockers }`;
on → blockers (not in a PR, already merged, head moved, GitHub head ≠ reviewed head, review not
green, tests not success) refuse with 409 text; else `merge(n, headSha)` (merge commit),
`deleteBranch`, `pr.merged`, trail `merged`, then `pullFfOnly(trunkCheckout, trunk)` only when the
checkout is on the trunk; non-fast-forward or any pull error → COO alert, `synced: false`.

## 5. `quality.ts`

`quality.yaml`:
```yaml
maxFileBytes: 5242880
buildOutput: ['(^|/)dist-[^/]+(/|$)', ...]     # regexes on repo-relative paths
secretScan: { command: gitleaks }
areas:
  desktop: { paths: [desktop/], checks: [{ name: lint, run: '…', extensions: [.js], timeoutSec: 120 }, …] }
```
- `changes(repo, base, head)`: `git diff --name-status --no-renames base...head` minus deletions.
- `buildOutputGuard`, `fileSizeGuard` (`git cat-file -s head:path`), `secretGuard` (`gitleaks git
  <repo> --log-opts=base..head --redact --no-banner --report-format json --report-path - --exit-code
  7`; findings reported as `rule in file:line` only; gitleaks missing or erroring = refused).
- `pushGuard(repo, base, branch)` = build output + secrets + size (all reported, not first-only).
- `run(worktree, base, head)`: push guard, then each check of each touched area, serially, `sh -c`
  in the worktree with `{files}` replaced by the area's changed files (shell-quoted, filtered by
  `extensions`; no files → skipped) and `CHANGED_FILES` in the env; output tail kept in `details`.
  A module-level queue makes runs serial. The worktree must be at the head SHA, else `error`.
  `QUALITY_MAIN_REPO` (the main checkout) is in every command's environment, for untracked local
  config such as Android's `local.properties`.

## 6. Surfaces

- Tools (`WORKPLACE_TOOLS`): `review_approve {itemId, note?}`, `review_send_back {itemId, note}`,
  `review_dispute {itemId, reason}`. `report_done` and `request_review` call `onReview` (they await
  push/PR; local returns at once, so their replies are unchanged in local).
- Review wake prompt: unchanged in local; with a PR (shadow/on) it names `review_approve` /
  `review_send_back`.
- Routes (loopback only): `GET /api/coo/github`, `POST /api/coo/github {mode}`,
  `POST /api/coo/merge {itemId}`.
- Boot: `startGitHubFlow(wp)` (the sweep).

## 7. Tests (written first)

- `github-flow.test.ts`: local does nothing (no push, no PR, tools refuse); shadow/on push + PR + PR
  number stored; branch name refusal; `dist-x` refusal; planted key refusal (gitleaks, real); approval
  order and identities; author cannot approve; QA first refused; head change resets both and marks
  evidence stale; `on` done-gate; dispute → manager alert; fallback after 3 failures in 5 min (not
  after 2, not when spread over 6 min) with a COO alert; merge refused when not green / in local;
  merge on GitHub (fake) + delete branch + ff pull; non-ff → COO alert, nothing forced; statuses.
- `quality.test.ts`: yaml loading (areas ignored); guards only. (Formerly: per-area command selection; `{files}` substitution; failures;)
  file-size; build output ignores already-tracked files and deletions.
- `github-port.test.ts`: the real port with a fake fetch and a fake token script — token never in
  errors or logs, PR exists fallback, merge body, status app.
- Everything else: the existing suite unchanged (local mode).

## 8. Employee-facing wording

Every reply and refusal an employee sees uses the terms of the handbook draft
(`~/iris-workplace/next/handbook.md`): "developer approver" (approval 1 of 2, a lead who is not the
author), "QA" (approval 2 of 2, only after the developer approval), "any new commit resets both
approvals", `run_evidence`, and disputes Asha → COO → owner. Each refusal ends with the next step in
one sentence. A dispute is accepted once per send-back.

## 9. Real-app trial

`packages/server/test/trials/github-sandbox.trial.mts` runs the flow once against
`shravan0001jha-iris-hq/iris-sandbox` with the real Apps (never `iris`, never `~/claude-dev`): a
planted key never pushed; push, PR, statuses from `iris-review`, approvals, merge commit, branch
deleted, and a temp clone fast-forwarded.
