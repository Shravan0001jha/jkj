# TDD: Workplace rework (October 2026)

**Test-first rule.** Every behaviour in `LLD-rework-2026-10.md` gets a test that fails on the current code before the change is made. The suite runs with `node:test` and `testWorkplace()` fakes.

**Running tests.**
- One file: `cd packages/server && node --import tsx --test test/<file>.test.ts`
- Everything: `npm test`

**Baseline.** On `ab978d2`, the suite has 553 tests and 24 fail. The failing files are listed in `docs/.baseline-failing-files.txt`. A workstream is done when:
- its new tests pass;
- no file outside the baseline list fails;
- `npx tsc -b` is clean.

## W1: Tree, model, audit (`test/rework-tree.test.ts`)

**Tree helpers:**
1. `isAbove(asha, dev-engineer)` is true.
2. `isAbove(asha, cto)` is false.
3. `teamOf(arjun)` is dev.
4. `leadOfCharter('conversation')` is dev.

**Who can change a story:**

5. An engineer moving their own story with a reason succeeds.
6. A different engineer moving that story is Forbidden.
7. Their lead moving it succeeds.
8. Asha moving it succeeds.
9. Asha moving a story assigned to cto is Forbidden.

**Reasons:**

10. A status change without a reason is a Bad request.
11. Actor `workplace` is exempt from the reason rule.

**Who can reassign:**

12. A lead can reassign to their own engineer, and to their manager.
13. A lead cannot reassign to another team's engineer.
14. Asha reassigning to an engineer is refused, and reassigning to a lead is allowed.

**Waiting and parked:**

15. `waiting` with `waitingOn` set to a teammate and no `kind` is stored as `waiting`, not rewritten.
16. Legacy `blocked` with a person in `waitingOn` maps to `waiting`.
17. `parked` without `resumeWhen` is refused.
18. From `parked`, a move to `ready` succeeds.

**Audit, chain, charter:**

19. `audit()` on a migrated-style item with created, assigned and status (`a → b`) rows reads as "created by", "assigned to", and a status entry with an undefined reason.
20. A new status row carries the reason.
21. `chain()` returns the developer, lead, chief of staff and charter.
22. Reassigning an item that already has a charter leaves `charterId` unchanged.

**Creating items:**

23. An engineer filing a `bug` with `item_create` gets it assigned to the QA lead.
24. An engineer filing a story gets it assigned to their manager.

**Escalate and ask_owner:**

25. `escalate` from an engineer messages their manager.
26. `ask_owner` from an engineer is refused, and from Asha it is allowed.

## W2: Dispatch, sessions, stall chain (`test/rework-flow.test.ts`)

**Dispatch:**
1. A non-focus Ready story is dispatched when there is no focus work.
2. Focus stories still go first.

**Sessions:**

3. When a session moves to a new story, the left story becomes `ready`, with a `system:` reason in the audit.
4. Reassigning an item whose old assignee's session is bound to it ends that session.
5. A merge ends the author's session when it is bound to that story.
6. `resumeOrphan` doesn't resume when the person's session is bound to another unfinished story.

**The stall chain:**

7. A story stalled for 9 minutes produces no notification.
8. At 10 minutes the lead is told, at 20 Asha, at 30 the COO bridge, and at 40 the owner gets a ring. Each happens exactly once.
9. During quiet hours the ring is suppressed. With super focus on, it rings.
10. Two stories at level 4 in the same sweep produce one ring listing both.

**Stopping the clock:**

11. With the floor paused, nothing fires, and the clock resets when the pause lifts.
12. Parked, waiting-on-owner and blocked stories never count as stalled.
13. An assignee busy on another story keeps their own story from counting as stalled.

**Old detectors:**

14. The old `watch` idle alert and the `stuck` alert are no longer sent to the manager.

## W3: Review, QA, RCA, comments (`test/rework-review.test.ts`)

**Comments:**
1. A 1201-character agent comment is rejected with the doc hint.
2. A 1200-character comment is stored whole, with no `…`.
3. An owner comment of any length is fine.

**Reads:**

4. `fit()` keeps a `## Plan` and a `## RCA` comment when older comments are dropped.

**Plan and RCA capture:**

5. A `## Plan` comment from the assignee sets `item.plan`, and there is no planWarning.
6. A five-part `## RCA` comment sets `item.rca`.
7. A four-part RCA does not set it.

**RCA gate:**

8. On a bug with no RCA, Edit is denied and `git commit` is denied.
9. After the RCA, both are allowed.
10. On an `rca` story, Edit is always denied.
11. On an `rca` story with an RCA, `report_done` marks it done without a PR.

**Developer approval:**

12. A same-team engineer can give a lead's developer approval.
13. A lead from another team can't.
14. The CTO can.

**Extra reviewers:**

15. A diff touching another team's code file adds that team's lead.
16. A diff touching only a comment line or `*.md` adds nothing.
17. QA stage 2 is refused until the extra reviewer approves.

**QA approval:**

18. Approval from a second QA, when another QA is assigned, is refused.
19. A QA doc whose case lines have no `evidence:` is refused.
20. Case lines with existing paths are accepted.

**Merge:**

21. `autoReady` is false when `pr.evidence` isn't `'success'` and there's no `Evidence: n/a`.
22. A head moving through a trunk-only merge keeps both approvals.
23. A head moving through a real commit resets them.
24. A PR touching `.github/workflows/x.yml` holds until approve-spend.
25. A design-doc PR merges after both approvals.

**Prompt layers:**

26. The assignment layer survives a huge handoff.

## W4: Inbox, push, focus, retention, plan (`test/rework-owner.test.ts`)

**The COO hold:**
1. An agent-raised owner decision writes an `owner-inbox` bridge line and emits no `needs-you`.
2. After 15 minutes the sweep emits `needs-you`.
3. `resolve` answers it, `by: 'coo'`, delivers the reply to the raiser, and never pushes.
4. `needs-you` with a note pushes immediately and stores `cooNote`.

**Push:**

5. The `intentFor` update is null and the room mention is null.
6. A `ring` gives `WP_ALERT`.

**Super focus:**

7. Super focus on makes `inQuietHours` false.
8. Only the owner and the COO can set it.

**Retention:**

9. An agent `out` message 4 days old is deleted.
10. A 2-day-old message, an owner message and the COO thread are kept.
11. Attachments of deleted messages are removed.

**Plan:**

12. `plan()` reports finished epics with `finished: true`.

## W5: iOS (`IrisWorkplaceTests`)

**Decoding:**
1. `ItemDetail` with `audit` and `chain` decodes.
2. The unknown status `"foo"` decodes to `.unknown`.

**Plan:**

3. `PlanQuery` splits finished epics into a done bucket.

**Requests:**

4. A status change request without a reason is not sent: the view model refuses it.
5. A Parked request body includes `resumeWhen`.

**Build and install:**

6. The project builds for the device. Install it on the owner's iPhone (`00008140-001E50C61487001C`) with `devicectl`.

## W6: Services (`test/rework-services.test.ts`)

**Mac queue:**
1. `request_mac` queues the request.
2. The sweep grants the head only when the requester has a live session on that item.
3. Six skips expire the request.
4. Release or expiry frees the Mac for the next request.
5. `grant` from the owner opens it now.

**Test accounts:**

6. A lease returns no secret fields.
7. A second lease gets a different account.
8. A returned account is leased again.
9. A lease expires after 4 hours.

The account-creation port is faked.

**Cost watcher:**

10. Spend over 2× the average and over $1 raises one `cap` item per day.
11. Normal spend raises nothing.

The `gh` port is faked.

## W7: Notion (`test/rework-docs.test.ts`, Notion port faked)

**Markdown conversion:**
1. Headings, lists, to-dos, a mermaid code block, a table, and links all convert to blocks.
2. Converting those blocks back gives the same markdown, round-trip.
3. Text over 2000 characters is split into chunks.

**doc_write:**

4. The first call creates a page with the properties and template headings.
5. A second call on the same story updates that same page. One doc per story.
6. It sets `item.docUrl`.

**Comments:**

7. `doc_comment` sends `display_name` custom set to `"Mira (lead)"`.
8. The relay forwards the owner's comment exactly once.
9. The bot's own comments are ignored.

**Missing key:**

10. With no key, the tools return "Docs are not set up yet".

## W8: Rules and org (`test/rework-org.test.ts` on the real `~/iris-workplace`)

1. `loadOrg` validates.
2. Every lead reports to asha.
3. The cto reports to coo.
4. Every non-role charter (not CoS, CTO or product) has at least 2 people, counting the planned hires.
5. Every employee is in one team.
6. `map.yaml` lint is clean.
7. The handbook contains none of the banned phrases: `rebalance`, `screenshots only for failures`, `Telegram`, `claude-dev-mobile`.
