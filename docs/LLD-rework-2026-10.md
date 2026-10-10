# LLD: Workplace rework (October 2026)

Companion to `HLD-rework-2026-10.md`. The test plan is in `TDD-rework-2026-10.md`.

Paths are relative to `packages/` unless noted. Each workstream (W1–W8) owns the files listed in it. When a workstream must touch another's file, it keeps the edit minimal and confined to the region named here.

## Shared contract (everyone builds against this)

### Statuses (`shared/src/workplace-v2.ts`)
```ts
export type ItemStatus = 'backlog'|'ready'|'in-progress'|'in-review'|'waiting'|'parked'|'blocked'|'done';
```
- **`waiting`:** the item has `waiting: { on: string /* employee id | 'owner' | 'coo' */, reason: string, since: string }`.
- **`parked`:** the item has `parked: { reason: string, resumeWhen: string, by: string, since: string }`.
- **`blocked`:** external causes only. Keeps the existing `blocked: {reason, waitingOn, since}`, where `waitingOn` is `'external' | 'release' | <item id>`.
- **`TrueStatus`** gains `'waiting' | 'parked'`, and `TRUE_STATUS_LABEL` gains `Waiting on` and `Parked`.
- **Item types:** `type?: 'bug' | 'rca'`. An `rca` story is done when the RCA is posted.
- **New `WorkItem` fields:**
  - `rca?: { text: string; at: string; by: string }`
  - `docUrl?: string`
  - `docId?: string`
  - `extraReviewers?: { id: string; files: string[]; approvedAt?: string }[]`

### Update request
`UpdateItemRequest` gains:
- `reason?: string`. This is required whenever `status` or `assigneeId` changes. The existing `note` is accepted as an alias.
- `waitingOn?: string`
- `resumeWhen?: string`

### Item detail response
`ItemDetail` gains `audit: AuditEntry[]` and `chain: StoryChain`.
```ts
export interface AuditEntry { at: string; by: string; kind: 'created'|'assigned'|'status'|'reviewer'|'parked'|'reopened'|'doc'; from?: string; to?: string; reason?: string /* undefined → "not recorded" */ }
export interface StoryChain { developer?: string; devReviewer?: string; extraReviewers: string[]; qa?: string; charterId?: string; charterTitle?: string; lead?: string; chiefOfStaff: string; cto?: string }
```

### Plan response
`EpicCard` gains `finished: boolean`, which equals `planTier === 4`.

### Settings
`superFocus: { until: string | null }`, read and written through the routes listed in W4.

## W1: Org tree, item model, permissions, audit
**Owns:**
- `server/src/services/org.ts` (helpers)
- `items.ts`
- `trail.ts` (audit)
- `v2-map.ts`
- `lifecycle.ts`
- `waits.ts`
- `shared/src/workplace-v2.ts`
- In `employees.ts`, **only** the tool definitions `item_update`, `item_create`, `escalate` and `ask_owner`.
- In `routes.ts`, item detail.

1. **`org.ts` helpers.** Each takes `(org, id)`:
   - `managerOf` returns `reportsTo`.
   - `ancestors` returns the ids from the manager up to the root.
   - `isAbove(org, a, b)` is true if `a` is in `ancestors(b)`.
   - `subtree(org, id)` returns everyone whose ancestors include `id`.
   - `teamOf(org, id)` returns the lead id. That is the employee themselves if their role is `lead` or `qa`, otherwise the first ancestor whose role is `lead` or `qa`.
   - `teamMembers(org, leadId)` returns the lead plus their direct reports.
   - `leadOfCharter(org, charterId)` returns the holder whose role is `lead`/`qa`, otherwise the `teamOf` of the first holder.
   - The pseudo-ids `owner` and `coo` are above everyone. `coo` is the root employee.
2. **Permission (`items.ts`, new `checkActor(wp, actor, prev, patch)`)**, applied when the actor is an employee id. The actors `owner`, `coo` and `workplace` are exempt; the internal system passes `'workplace'`.
   - **Status or field change:** the actor is the assignee, or `isAbove(actor, assignee)`, or the actor is the item's current reviewer and is moving `in-review` to `in-progress` or `done` (the review tools already pass through). Otherwise the call throws `Forbidden: only <assignee> or someone above them can change this story`.
   - **Assignee change:** the new assignee must be in `subtree(actor)`, or equal `managerOf(actor)`. When the actor is the chief of staff, the new assignee must have role `lead`/`qa`, or be the actor themselves ("route to the charter lead; the lead assigns within the team").
   - **Items assigned to `coo` or `cto`:** only the owner, the COO, or the person themselves may change them. This falls out of the tree once the CTO is no longer under Asha.
3. **Reasons.** If `status` or `assigneeId` changes and the actor is not `'workplace'`, the patch must include `reason` or `note`, at least 3 characters long. Otherwise the call throws `Bad request: give a reason for this change`. Every internal call site passes a `note` of the form `"system: <why>"`. The call sites are listed in the map:
   - `watch.ts`
   - `handoff.ts`
   - `lifecycle-watch.ts`
   - `github-flow.ts`
   - `employees.ts:573`
   - `work.ts`
   - `dispatch.ts`
4. **Waiting and parked.**
   - A status of `waiting` requires `waitingOn`, which must be an existing employee, `owner` or `coo`, plus a reason. When `waitingOn` is the owner, a recommendation is also required, as in today's rule.
   - The `waits.ts` rewrite to review or handoff now happens **only** when `kind` is given explicitly. Without `kind`, the status stays `waiting`.
   - Old callers that send `blocked` with a person in `waitingOn` are mapped to `waiting`.
   - A status of `parked` requires `reason` and `resumeWhen`.
   - The legacy `hold` stays readable. New holds map to `parked`.
5. **Transitions (`TRANSITIONS`).**
   - `waiting` and `parked` can be entered from `ready` or `in-progress`.
   - From either, the item can go to `ready`, `in-progress` or `backlog`.
   - `trueStatus` maps them straight through.
6. **Audit.** `audit(wp, itemId)` builds the list from `activity` rows of kinds created, assigned, status, reopen and reviewer, plus note rows written for hold, parked or doc.
   - The reason is the activity `text`, unless the text is the auto-generated `'a → b'`, in which case the reason is undefined.
   - Every new status or assign row stores the reason as its `text`.
   - Existing stories therefore show "created by X / assigned to Y" with no extra seed, and the backfilled reason is "not recorded".
7. **Chain (`chain(wp, item)`).**
   - `developer` is the assignee.
   - `devReviewer` is `pr.devReviewer ?? (author's manager if a lead, else a team member)`.
   - `extraReviewers` and `qa` come from `pr.qaReviewer ?? reviewer if QA`.
   - `charterId` and `charterTitle` come from the item.
   - `lead` is `leadOfCharter`.
   - `chiefOfStaff` is the CoS id, and `cto` is the CTO's id.
   - **Gap: the chain helper needs the PR's reviewer data.** That data lives in `github-flow`, and `github-flow` reads `items`, so importing it from `items.ts` would be circular. Read the PR record through the existing settings key that `github-flow` uses, instead of importing it.
8. **Tools.**
   - **`item_update`** accepts `reason`, `waitingOn` and `resumeWhen`, plus the status enum with the two new values. Its description is: "Every change needs a reason; you can change your own stories and those of people below you; reassign only to someone below you or to your manager."
   - **`item_create`:**
     - Anyone can file a `story` or a `bug`. A bug is assigned to the QA lead. A story filed by a non-CoS is assigned to the filer's manager, Ready, with the reason "filed by X".
     - Epics stay CoS-only. Tasks stay with the story's assignee.
     - `type: 'rca'` is allowed.
   - **`escalate`:** anyone can call it.
     - The CoS and the CTO keep today's path, which goes to the COO.
     - Everyone else is routed to `managerOf(caller)`: a message wakes that manager with the item and the text, and a comment is recorded on the item.
   - **`ask_owner`:** only the CoS, the CTO and the COO. Anyone else gets the refusal "Ask your manager: owner decisions go up the chain (escalate)."
9. **`charterId` on reassign.** A reassignment no longer rewrites `charterId` unless the item has none. A misroute leaves the charter alone.

## W2: Dispatch, sessions, stall chain
**Owns:**
- `dispatch.ts`, `watch.ts`, `stuck.ts`, `hygiene.ts` (alerts only), `manager.ts` (alert routing only)
- the new `stall-chain.ts`
- `lifecycle-watch.ts` (session end)
- in `employees.ts`, the session regions: `startSession`, `handOver`, `moveSession`, `redirectTo`, `resumeInProgress`, `close`
- `index.ts` wiring for the stall chain

1. **Focus is priority, not a filter.** In `queue()`, a story outside the focus is ordered after the focus stories instead of being skipped. An empty focus means order by rank.
2. **One story per person.**
   - When a session takes a new assignment (`handOver`/`moveSession`/`redirectTo`), the story it leaves goes to `ready` if it is still `in-progress`. The reason is `system: <emp> moved to <new title>`.
   - `resumeOrphan` resumes only when the person has no live session bound to another unfinished story.
   - Remove `watch.ts`'s idle re-assign and its not-started auto-assign. It must never move the person's session.
3. **Reassigning ends the old session.** The listener is `work.updated` with an assignee change. If the old assignee's open session is bound to that item, call `employees.endSession(old, 'reassigned')`.
4. **A merge ends the session.** `lifecycleWatch.onMerged` calls `endSession(author)` when the author's open session is bound to the merged item.
5. **Leads start work.**
   - The dispatcher still starts the next queued story for any free person, leads included.
   - Routing is enforced by W1: Asha can only assign to leads, and leads assign within their team.
   - Stories newly assigned to a lead by the CoS carry `routedAt`. The lead's start prompt opens with: "Routed to your team: assign each to a team member (item_update assigneeId + reason) or keep it with a reason." Routed stories sort to the top of the lead's queue.
6. **`stall-chain.ts`** (new). It sweeps every 60 s, wired in `index.ts`.
   - **A stalled story:**
     - is `ready` or `in-progress`;
     - has an agent assignee;
     - has no unfinished `startsAfter`;
     - the floor is not paused;
     - there is no pace hold;
     - and the assignee is free: no running turn, and no live session bound to a different unfinished story;
     - and either no live session is bound to this item, or the bound session has been idle with no activity on the item for 10 minutes or more.
   - **Record:** `stall-chain:<itemId>` = `{ since, notified: number }`. It is cleared when the condition ends.
   - **Levels and targets:**
     - L1 at 10 min: `teamOf(assignee)`. If that is the assignee, use their manager instead.
     - L2 at 20 min: the CoS.
     - L3 at 30 min: the COO, through a bridge line with kind `stall`.
     - L4 at 40 min: the owner, by ring.
   - **Notifying an employee:** call `employees.talk(target, text, {from:'workplace', probe:true})` with the text `Stalled <n> min: "<title>" (<assignee>) — <reason>. Get it moving or say why.` Record a comment on the item as well.
   - **Ring:** emit `alert {level:'ring', text, itemIds}`.
     - At most one ring per sweep, listing every L4 item.
     - Rings are suppressed in quiet hours (`WORKPLACE_PUSH_QUIET`) unless super focus is active.
     - A suppressed ring is retried on the first sweep after quiet hours end, if the item is still stalled.
   - **Old detectors:**
     - In `watch.ts` (idle, unreviewed, not-started), `stuck.ts`, `dispatch.idleAlerts` and `manager.escalate` for stall keys: stop the alerts. Keep their non-alert bookkeeping only where other code depends on it.
     - hygiene keeps computing (the COO endpoint is used) but stops sending notices to Asha.
7. **`watch.ts` and the floor.** When the floor is paused, nothing is parked or moved.

## W3: Review, QA, RCA gate, comments, prompt layers
**Owns:**
- `github-flow.ts`, `review-policy.ts`, `qa-doc.ts`, `evidence.ts` (gating only)
- `one-line.ts` callers in `trail.ts` (the comment path)
- `read-tools.ts`, `work.ts` (plan and RCA capture), `guards.ts`, `context-layers.ts`
- in `employees.ts`: plan capture `:280-299`, the `item_comment` tool, `report_done` checks, and the review tools

1. **Comments.** For an agent, `item_comment` and `trail.comment` reject text over 1200 characters with: `Not posted: comments are capped at 1200 characters (yours: N). Put the detail in a doc (doc_write) and link it.` Accepted text is stored whole, with no `short()`. The owner and the COO are uncapped.
   - Inbox replies (`inbox.ts:395`) get the same cap and rejection.
   - Room posts keep the 600-character rejection.
   - `read-tools`: `COMMENT_MAX` is 1200 and `DETAILS_MAX` is 4000. `fit()` never drops comments whose text starts with `## Plan` or `## RCA`. It pins them after the head.
2. **Plan and RCA capture.**
   - An `item_comment` from the assignee that contains a line `## Plan` triggers `work.attachPlan`.
   - A line `## RCA` triggers `work.attachRca`, which sets `item.rca`, but only when all five parts are present.
   - The five parts are matched case-insensitively by line starts: `Symptom`, `Root cause`, `Why it escaped` (or `Why QA missed`), `Fix`, `Regression`.
   - `parsePlan` also accepts `## Plan:` headings.
   - **`planWarning`** stops warning when `item.plan` exists. It only warns when there is no plan at all.
3. **RCA gate (`guards.ts`).** A new `guard.rcaGate: 'none' | 'until-rca' | 'rca-only'` is set at spawn and on every assignment change, from the item's type and `rca`.
   - When the gate is not `'none'`, the guard denies `Edit|Write|MultiEdit|NotebookEdit`, and any Bash command matching `/\bgit\s+(commit|add)\b/`, with: `RCA first: post a 5-part "## RCA" comment on the story before changing code` (or, for `rca-only`: `This is an RCA ticket: no code changes; post the RCA and report_done`).
   - The `until-rca` gate lifts on RCA capture. `employees.refreshGuard` is called from W3's capture.
   - **`report_done`:**
     - for `rca`, requires `item.rca` and no commits since base, then sets the story done (resolution done) without a PR;
     - for `bug`, requires `item.rca`.
4. **Developer approval by team.** `canApproveAsDeveloper(org, actor, author)` is true when the actor is in `teamMembers(teamOf(author))` and is not the author, or is the CTO.
   - **`devReviewer`:** for an engineer author, it is their lead. For a lead author, it is a member of their team with the fewest open reviews, falling back to the CTO.
5. **Extra reviewers.** In `onReview`, after the push, compute the changed files with `git diff --name-only base..head` in the worktree.
   - A file counts when its `git diff -w --ignore-blank-lines base..head -- <file>` has at least one +/- line that is not a comment line. Comment lines start with `//`, `#`, `*`, `/*` or `<!--`. Files `*.md` and `docs/**` never count.
   - Each counted file is owned (`primary` via `ownership.resolve`) by some charter.
   - Every charter whose team lead differs from the author's team lead adds `{id: that lead, files}` to `pr.extraReviewers`.
   - The author can add one with `request_review` and an `extraReviewers: [id]` parameter.
   - `review_approve` by an extra reviewer sets `approvedAt` on their entry.
   - QA stage 2 is refused until the developer approval **and** every extra reviewer has approved: `Waiting for <names> to approve their files`.
6. **One QA per story.** Once `pr.qaReviewer` is set, only that person can give approval 2. Asha can change it with `item_update` on `reviewerId` plus a reason.
7. **QA proof (`qa-doc.ts`).** Every `PASS` or `FAIL` case line must contain `evidence:` followed by a path that exists (absolute, or relative to `~/iris-workplace/evidence/` or the worktree) or an `http(s)` URL. Otherwise: `Each case needs proof: add "evidence: <screenshot/log path or URL>"`.
   - An `N/A` line needs no proof.
   - A line `Evidence: n/a — <why>` is allowed only together with `Tests: <command> <counts>`.
8. **Evidence before merge.** `merge` and `autoReady` require `pr.evidence === 'success'`, or a QA doc that contains `Evidence: n/a`.
9. **Trunk catch-up keeps approvals.**
   - In `onReview` and `syncHeads`, when the head moved, keep the approvals if `git log --no-merges <approvedSha>..<newHead>` is empty and the merge parents are reachable from trunk. Rerun the tests status by carrying the previous tests status over, with the note `carried: trunk-only merge`.
   - When trunk advances, a `syncHeads` pass calls GitHub `PUT /repos/{o}/{r}/pulls/{n}/update-branch` for open PRs that are behind and in review. It goes through github-port, with a new method `updateBranch`.
   - A conflict means GitHub returns 422. The existing `reopenForConflict` path handles it.
10. **Merges without the COO.**
    - Drop the `DESIGN_DOC` hold. Design docs merge after both approvals, like any other change.
    - Add a spend hold: a PR touching `.github/workflows/**`, `infra/**` or `**/*.tf` waits for `POST /api/coo/approve-spend {itemId}`, which sets `pr.spendApprovedAt`. The hold appears as a comment.
11. **Prompt layers (`context-layers.ts`).**
    - The assignment and workspace layers are rendered first among the variable layers and are never dropped. Handoff is trimmed to its last 6000 characters before any drop.
    - Line 75–77 now reads: "Commit on your branch; never push or rebase; merging the trunk into your branch is allowed. The Workplace merges after both approvals."
    - `PLAN_FIRST` adds: "For a bug: post the 5-part ## RCA first; code edits unlock after it."

## W4: Inbox copy, push policy, super focus, Talk retention, Plan finished
**Owns:**
- `inbox.ts` (copy and hold), `coo.ts` (the new endpoints), `push.ts`, `telegram.ts` (filter)
- the new `retention.ts`
- `items.plan` (the `finished` field), `routes.ts` (the new routes)
- `config.ts` (super focus is not config; it is the setting)

1. **Copy to the COO.**
   - **On insert:** `inbox.insert` of an owner-facing item whose `raisedBy` is not `owner` or `coo` appends a COO bridge line: `{kind:'owner-inbox', inboxId, title, raisedBy, summary}`. It sets `item.cooHold = {until: now+15m}`. No `needs-you` alert is emitted yet.
   - **Hold sweep:** a 60-second sweep raises `alert {level:'needs-you', inboxId}` for held items whose `until` has passed and that are still open. It then clears `cooHold`.
   - **`GET /api/coo/owner-inbox`:** lists the open owner items, including held ones.
   - **`POST /api/coo/owner-inbox/:id/resolve {text, optionId?}`:** the COO answers on the owner's behalf. The item becomes answered `by: 'coo'`, and the reply is delivered to the raiser through the existing `reply-delivery`. No push.
   - **`POST /api/coo/owner-inbox/:id/needs-you {text}`:** adds a COO note to the item (`cooNote`, shown at the top in iOS) and clears the hold, so the alert goes out now.
   - **Items the COO raises himself:** they push immediately.
2. **Push policy (`push.ts intentFor`).**
   - **Keep:** `WP_INBOX` for `needs-you` alerts with an `inboxId` (after the hold), plus `WP_ALERT` for `cap`, failed `blocked` releases, COO pickup, and `ring`.
   - **Drop:** `WP_UPDATE` and `WP_ROOM`.
   - **Tool-approval alerts** (`health.ts:63`): `WP_ALERT` only during the day.
   - **`ring`:** pushes with `sound: 'critical'` when supported, otherwise the default. Quiet hours do not drop it; the stall chain already filtered it.
   - **Telegram:** only `cap` and `ring`.
3. **Super focus.**
   - `GET /api/settings/super-focus` returns `{until}`.
   - `POST /api/settings/super-focus {hours: number | 0}` sets `until = now + hours` (0 clears it). The actor must be the owner or the COO.
   - `push.inQuietHours` is false while super focus is active.
4. **Talk retention (`retention.ts`).** It runs daily from the rhythm timer (once per IST day) and once at boot, 5 minutes after start.
   - It deletes `talk_messages` rows where `from_who` is an employee id (not owner, coo or workplace), `direction = 'out'`, and `at < now - 3 days`.
   - It also deletes their `talk_attachments` rows and files.
   - The COO thread is untouched. It logs the count.
5. **Plan.** `items.plan()` sets `EpicCard.finished = planTier(card) === 4`.

## W5: iOS Workplace app (`~/jkj-ios/apps/ios`)
1. **Model** (`ContractV2.swift`).
   - `ItemStatus` gains `.waiting` and `.parked`.
   - `Item` gains `trueStatus`, `waiting`, `parked`, `blocked`, `type`, `docUrl` and `rca` (present or absent).
   - `ItemDetail` gains `audit: [AuditEntry]` and `chain: StoryChain`.
   - `EpicCard` gains `finished`.
   - `InboxItem` gains `cooNote`.
   - Decode leniently, with unknown → `.unknown`.
2. **Plan.** In `PlanView`, finished epics are removed from each area's list and collected into a single collapsed section, "Done (N)", at the bottom. Tap to expand. The status filter keeps working.
3. **Story detail** (`ItemDetailView`).
   - **New "Chain" section:** Developer, Reviewer, Extra reviewers, QA, Charter, Charter lead, Asha, CTO. Each is a tappable person row that opens that employee's Talk thread, so the owner can tag them.
   - **New "Audit" section:** every entry, newest first, as `when · who · what` with the reason. A missing reason shows "not recorded".
   - **Status changes:** every change, including the existing state menu, opens a sheet with a required reason field.
     - The Waiting sheet also has a person picker (employees plus owner and COO).
     - The Parked sheet also has a "Resume when" field.
     - Send `{status, reason, waitingOn?, resumeWhen?}`.
   - **Doc link:** shown when `docUrl` is set, and opens in Safari.
4. **Inbox.** Show `cooNote` ("COO: needs you because…") at the top of an item.
5. **Settings.** A "Super focus" toggle with 2 h, 4 h, 8 h and off, using the W4 routes. It shows the active-until time.
6. **Mac queue.** A small section in Settings or Ops that lists the queue (`GET /api/mac-queue`) with a "Grant now" button on the head entry.

## W6: Services (Mac queue, test accounts, GitHub cost watcher)
1. **`mac-queue.ts`.** The table `mac_queue(id, emp, item_id, minutes, why, at, state)`, where state is `queued|granted|done|expired`.
   - **Tool `request_mac {itemId, minutes ≤ 45, why}`:** queues the request and returns its position.
   - **Tool `release_mac`:** ends the grant.
   - **The 30-second sweep:**
     - If no grant is active, it takes the head of the queue whose requester has a live session bound to that item. Requests that don't meet this are skipped, and after 6 skips they expire.
     - It calls `coo.openLiveWindow(emp, minutes)` and messages the person.
     - On expiry or release it marks the entry done. A new `coo.closeLiveWindow(emp)` clears the setting.
   - **Routes:** `GET /api/mac-queue`, plus `POST /api/mac-queue/:id/grant` for the owner or COO, which grants now.
   - **The handbook line becomes:** "Ask for the Mac with `request_mac`". Retire `~/iris-ops/coo/window_queue.sh` from `coo-watchers.sh`; this is a COO ops edit.
2. **`test-accounts.ts`.** The table `test_accounts(id, email, platform, state, leased_by, item_id, leased_at)`.
   - Accounts are created on demand through the same admin API that `e2e/scripts/local-run.sh create_account` uses. The admin key is read server-side from SSM `/iris-staging/e2e-admin-key` through `aws ssm get-parameter`. Before building, read `~/claude-dev/e2e/scripts/local-run.sh` to mirror the exact API.
   - **Tool `lease_test_account {itemId, platform}`:** returns `{accountId, email}` and never a password or token. It signs in for the agent by writing the session token into the agent's test profile when the platform is `desktop`. The test profile is `~/iris-work/<emp>/test-profiles/<accountId>`, the path the agent then passes as `--user-data-dir`. Before building, read how the e2e desktop runner seeds a profile and mirror it. If it can't be mirrored safely, return only the profile path pre-seeded by the e2e helper script.
   - **Tool `return_test_account {accountId}`.** Leases also expire after 4 hours.
3. **`cost-watch.ts`.** It runs daily at 09:00 IST from the rhythm timer.
   - It reads GitHub org billing usage for yesterday through `gh api` (the command in the points file) via github-port's shell helper, and stores `cost:github:<date>` = USD.
   - If yesterday is more than 2× the 7-day average and over $1, or the month-to-date is more than ₹5000/84 USD × (day/30), it raises an owner Inbox `cap` item: "GitHub spend jumped: $X yesterday vs $Y avg." No email for now.

## W7: Notion docs
**Owns** the new `notion.ts` and `docs.ts`, the doc tools in `employees.ts`, `config.ts` (`notionKeyPath` defaults to `~/iris-ops/notion.key`, `notionRootPageId` defaults to `3f5df729-a77e-80d6-b41c-eddb74e67ec6`), and the doc fields on items.

1. **`notion.ts`.** A thin client using `fetch`, Notion-Version `2022-06-28`, the key read from file on each call. It never logs the key.
   - Calls: `createDatabase`, `queryDatabase`, `createPage`, `updatePage`, `appendBlocks`, `listChildren`, `deleteBlock`, `createComment` (with `display_name {type:'custom', custom:{name}}`), and `listComments(blockId)`.
   - Retries once on 429, honouring `Retry-After`.
2. **The database.** `ensureDocsDb()` finds or creates the database "Iris Docs" under the root page and stores its id as the setting `notion:docs-db`. Properties:
   - `Name` (title)
   - `Type` (select: RCA, Design, Research, QA report, Release report, Incident, Decision)
   - `Charter` (select)
   - `Owner` (rich_text)
   - `Status` (select: Draft, In review, Final)
   - `Story` (url)
   - `Story id` (rich_text)
   - `Date` (date)
3. **Markdown to blocks.** Supported: `#`, `##`, `###`, paragraphs, `-` bullets, `1.` numbered lists, `- [ ]` to-dos, ``` fenced code (with language; `mermaid` stays mermaid), pipe tables (table blocks), `>` quotes, `**bold**`, `*italic*`, `` `code` `` and `[text](url)` links.
   - Text is split into chunks of up to 2000 characters, and blocks are appended in groups of up to 100.
   - Blocks to markdown is the inverse, for `doc_read`.
4. **Templates.** These are the headings inserted when a doc is created and the markdown lacks them:
   - **RCA:** Symptom, Root cause, Why it escaped, Fix at the root, Regression guard.
   - **Design:** Context, HLD, LLD, Test plan.
   - **QA report:** Cases (with evidence), Not checked, Residual risk.
   - **Release report:** Scope, Results by platform, Issues.
   - **Incident:** Timeline, Impact, Cause, Follow-ups.
   - **Decision:** Question, Options, Recommendation.
   - **Research:** Question, Findings, Sources.
5. **Tools.**
   - **`doc_write {itemId, type, title, markdown, status?}`.** One doc per story: it replaces the existing doc's content (delete children, then append) or creates a new one. It sets the properties (Owner is the caller's name), sets `item.docUrl`/`docId`, records an activity `doc`, and returns the URL.
   - **`doc_read {itemId}`.** Returns the markdown, capped at 30k characters.
   - **`doc_comment {itemId, text, quote?}`.** Posts a comment under the name `"<Name> (<role>)"`. A `quote` anchors the comment to the first block containing that text; otherwise it goes on the page.
6. **Comment relay.** A sweep every 120 s lists comments on each doc that belongs to an open item. A comment is the owner's when its `created_by` is a person (`type: person`), not the bot. Each new comment from the owner is relayed to the doc's Owner employee (`employees.talk`) and recorded as an item comment by `owner`. The seen ids are stored in the setting `notion:seen:<docId>`.
7. **Missing key.** When the key file is absent, the tools return "Docs are not set up yet", and the sweep is a no-op.

## W8: Rules and org data (`~/iris-workplace`, plus a `roles.yaml` code check)
1. **`org.yaml`.**
   - **Reporting lines:** leads (dev, mira, kabir, rohan, tara, neel) and nikhil now report to asha. The cto reports to coo.
   - **Teams and charters:**

     | Team (lead) | Charters | Members |
     |---|---|---|
     | Dev | character, conversation | arjun, sameer |
     | Mira | experts | ira |
     | Rohan | desktop-mac, windows | priya |
     | Neel | context-provider | kavya |
     | Kabir | server, memory | + 1 hire |
     | Tara | mobile-ios, mobile-android | + 1 hire |
     | Nikhil | qa-release, beta-ops | zoya, aditi |

   - Remove Sameer's experts charter and Arjun's mobile-android charter.
   - Zoya and Aditi move to role qa.
   - **Neel becomes active** if he is currently virtual or pending.
   - **Hires:**
     - `vivek`: engineer, team kabir, charters server and memory.
     - `anika`: engineer, team tara, charters mobile-ios and mobile-android.
     - Copy the field shapes from existing engineers. Note any GitHub App or worktree prerequisites in the PR, but don't create Apps.
2. **`handbook.md`.** Rewritten as the single source of truth, from the points file. Sections:
   - the rules;
   - the org tree;
   - routing and the tree;
   - statuses and reasons;
   - a story's life, including the plan-step QA cases being blind;
   - bugs and RCA (types, gate, bug→QA→Asha);
   - reviews (team, extra reviewers, one QA, proof, evidence);
   - gates (gate 1 per batch, gate 2 release);
   - stalls (the chain);
   - docs (Notion, the doc rule, comments ≤ 1200);
   - talking to the owner (Asha and Vikram only, everyone else via their manager);
   - cost (new workflows and infra need COO approval);
   - lessons learned, kept short. Each lesson becomes a check, gets folded into a rule, or is dropped after 2 weeks.

   Remove contradicted text: "rebalance", "open screenshots only for failures", the COO owning bug RCAs, "post plan then build" for bugs, and similar.
3. **Charters.** Remove the content that `mobile-ios.md` and `mobile-android.md` duplicate (each keeps its own platform). Remove stale versions, Telegram, `claude-dev-mobile`, the 27 Sep counts, and Asha's repo-split and M0–M5 plans. Fix the escalation paths. Update `qa-release.md` so QA owns the bug pipeline and inspects evidence.
4. **`roles.yaml`.**
   - Remove "rebalance" and the reassign-by-load text.
   - Lessons: Asha proposes, and the COO edits.
   - QA role: blind plan-step cases and evidence inspection.
   - Leads: distribute first, then build, and know the charter.
