# HLD — GitHub pull-request flow, two approvals, local quality checks

Infra checkpoints 8 (PR flow), 9 (two approvals) and 10 (quality checks). Status: design approved by
the owner (4 Oct); this document records how and why it is built. The LLD is
`docs/LLD-github-flow.md`; the tests are `packages/server/test/github-*.test.ts` and
`packages/server/test/quality.test.ts`.

## 1. Problem

Merges into the Iris trunk (`feat/iris-character`) are local: the COO merges `emp/<name>/<story>`
branches by hand after one reviewer marks the story done. Nothing mechanical checks the review, the
tests, leaked secrets or committed build output (the trunk already tracks ~1,600 `dist-*` files from
an earlier auto-save). The handbook says "an AI manager's approval is not a safety gate; the
mechanical gates are". This adds the mechanical gates, on GitHub, without breaking today's floor.

## 2. Goals and non-goals

Goals
- A Workplace setting `github: local | shadow | on` (default `local`). `local` is exactly today.
- When a story moves to review, the **server** (never an employee) pushes its branch and opens a PR to
  the trunk, and stores the PR on the item.
- Two approvals, in order: developer (a lead who is not the author), then QA (role `qa`, or the
  quality-charter engineer). A new commit resets both.
- Commit statuses `workplace/review`, `workplace/tests`, `workplace/evidence` on the head commit.
- A COO merge endpoint that merges on GitHub when the statuses are green, then fast-forwards
  `~/claude-dev` (never forced).
- Local quality checks on the Mac (lint, type-check, tests per area; secret scan; build-output guard;
  file-size limit), configured in `~/iris-workplace/quality.yaml`.
- Automatic fallback to `local` after 3 GitHub failures within 5 minutes, with a COO alert.

Non-goals (now)
- Employees never push or use `gh`; that stays (FORBIDDEN_TOOLS and guards.ts are untouched).
- The evidence check itself (a later tool): only its hook and a pending status exist.
- GitHub rulesets/branch protection (configured on GitHub with the Apps, by another agent).
- UI for PR state (the item carries it; the web/phone views can show it later).

## 3. Modes

| | local (default) | shadow | on |
|---|---|---|---|
| Push + PR on review | no | yes | yes |
| Statuses posted | no | yes | yes |
| Approvals recorded (`review_approve`) | refused: review as before | yes | yes |
| "Done" needs both approvals | no | no (old rule) | yes |
| Merge | by hand (COO) | by hand; `/api/coo/merge` is a dry run | `/api/coo/merge` merges on GitHub |

`local` adds no code path: every hook returns before doing anything, and the existing suite (361
tests) is the proof. `shadow` lets us watch GitHub do the work for days with nothing depending on it.

Fallback: GitHub failures (an API error, a push that fails for a network/auth reason) are counted;
3 within 5 minutes switch the mode to `local`, record why, and raise a COO alert. A policy refusal
(a planted key, a `dist-*` file, a bad branch name) is not a GitHub failure and never trips it.

## 4. Components

```
report_done / request_review ──► github-flow.onReview ──► push guard ──► GitHubPort.push / openPr
                                       │                     (branch name, dist-*, gitleaks, size)
                                       ├──► statuses (iris-review App)
                                       └──► quality.run (async, serial) ──► workplace/tests
review_approve / review_send_back / review_dispute ──► github-flow (review-policy decides who)
POST /api/coo/merge ──► github-flow.merge ──► GitHubPort.merge + deleteBranch ──► git pull --ff-only
POST/GET /api/coo/github ──► mode, fallback state
```

- **GitHubPort** (interface): push, find/open PR, get PR, post status, merge, delete branch, pull.
  The real one mints App installation tokens with `~/iris-ops/github/token.py <slug>` (apps
  `iris-workplace` for push/PR/merge, `iris-review` for statuses) and talks to
  `shravan0001jha-iris-hq/iris`. Tests use a fake backed by a local bare repo, so pushes, merges and
  the fast-forward pull are real git.
- **review-policy** (pure): who may give which approval, and whether an approval still holds.
- **github-flow**: the orchestration, the mode, the fallback, the statuses, the merge.
- **quality**: loads `quality.yaml`, runs the static guards and the per-area commands.

## 5. Key decisions

- **D1 The server pushes, from the main repo's refs, with an App token passed through the
  environment** (`GIT_CONFIG_*`), never on a command line or in a remote URL, and never forced. A
  non-fast-forward push fails and is reported; force-push stays an owner action.
- **D2 The push guard runs before anything leaves the Mac**: the branch must be exactly
  `emp/<assignee>/<item id>`; no commit in `trunk..branch` may add or change `dist-*` output; gitleaks
  scans those commits (a key added and later deleted is still in history, so it is still refused); no
  file over the size limit. Pushing a leaked key to GitHub is itself the leak, so the secret scan is a
  push gate, not only a status.
- **D3 Approvals are bound to a commit and a review episode**: an approval holds only while the head
  SHA it was given on is the branch head and the item is still in the same stay in review. A new
  commit, or a send-back, invalidates both without any extra bookkeeping. The head is re-read on
  every review action, on merge, and by a one-minute sweep, which re-pushes and re-runs the checks.
- **D4 Order is enforced**: QA cannot approve before the developer approval holds. The developer
  approval hands the review to QA (the reviewer changes, so the existing review wake wakes QA). QA's
  approval marks the story done.
- **D5 Disputes** of a QA send-back go through the existing manager alert: Asha first, the COO after
  15 minutes unacted (manager.ts), and the COO forwards to the owner (`/api/coo/forward`).
- **D6 Quality checks run in the employee's worktree, serially** (heavy builds are capped on the Mac),
  only for the areas the diff touches. Commands come from `quality.yaml`; nothing is hard-coded per
  project. A missing tool fails closed (gitleaks absent = refused).
- **D7 `workplace/evidence`** is driven by `run_evidence` (docs/HLD-evidence.md) through `setEvidence`;
  it is not yet required to merge.
- **D8 The merge uses a merge commit and passes the reviewed SHA** to GitHub, so a commit that lands
  between the check and the merge makes GitHub refuse it. After the merge `~/claude-dev` is updated
  with `git pull --ff-only`; if that cannot fast-forward the COO is alerted and nothing is forced.

## 6. Risks

- The real Apps do not exist yet: everything is proven against the fake; the first real trial runs in
  `shadow`.
- The trunk already tracks `dist-*` output; the guard only judges what a branch adds or changes, so
  existing files never block a story, but they should be removed from the trunk (owner decision).
- Quality runs can be slow (pytest, gradle); they are serial and time-limited per command.
