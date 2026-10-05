# Jira-style lifecycle and the hygiene monitor (HLD + LLD)

Owner, 5 Oct: the board must show the **true** state of every item. A blocked item is fine (it is a
queue), but it always says what it waits on, why, and where that blocker stands. An item at the top of
someone's queue that nobody is working on is not fine. Asha hears of violations often (10 min), the
COO rarely (60 min).

## 1. Model

**Types.** `epic`, `story`, `task`, `bug`. A bug is a story-level item (`level: 'story'`, `type: 'bug'`):
it sits under an epic, gets a PR and goes through the same review. `type` is additive; rows without it
read as their level.

**Statuses** (`trueStatus`, computed on every read; the stored `status` is unchanged):

| trueStatus   | stored as                                                                  |
|--------------|----------------------------------------------------------------------------|
| Backlog      | `backlog`, not held                                                        |
| On hold      | `backlog` + `hold` (+ `holdReason`)                                        |
| Ready        | `ready`, any `startsAfter` satisfied                                       |
| In progress  | `in-progress`                                                              |
| In review    | `in-review`; with an open PR (mode shadow/on): no developer approval yet   |
| QA           | `in-review`, open PR, developer approval holds, QA's does not              |
| Approved     | `in-review` or `done`, open PR, both approvals hold (waiting on the merge) |
| Merged       | `done` + `pr.merged`, not yet closed by Asha (`closedAt` absent)           |
| Done         | `done` (no PR, or merged and closed, or any non-done resolution)           |
| Blocked      | `blocked`; or `ready` with an unsatisfied `startsAfter`                    |

**Resolutions** (on Done): `done`, `wont-do`, `duplicate`, `cant-reproduce` (new; bugs).

**Transitions and who makes them** (the stored machine, `items.ts` TRANSITIONS, is unchanged):

| From → To                         | Who                                                                     |
|-----------------------------------|-------------------------------------------------------------------------|
| Backlog ↔ Ready                   | Asha (routing), the owner, the COO                                      |
| Ready → In progress               | the assignee (or the dispatcher starting their session)                 |
| In progress → In review           | the assignee (`report_done`); needs a reviewer                          |
| In review → QA → Approved         | derived: `review_approve` by a developer, then QA                       |
| Approved → Merged                 | the COO's merge (`POST /api/coo/github/merge`): automatic               |
| Merged → Done                     | Asha closes it (`item_update status done`), or the owner/COO/reviewer   |
| In review → In progress           | the reviewer's send-back                                                |
| any open → Blocked                | anyone on it; needs `waitingOn` + `blockedReason` (or `startsAfter`)    |
| Blocked → previous / Ready        | anyone, or automatic when the `startsAfter`/`waitingOn` item finishes   |
| any open → On hold                | owner or COO, with a reason (`note`)                                    |
| Ready/Backlog → Done              | the owner only (won't do / duplicate / can't reproduce)                 |
| Done → In progress                | anyone, with a note (a reopen)                                          |

**Asha's queue is a routing queue.** An item assigned to Asha is hers to route to the owning developer,
never to build. Its "work" is the reassignment.

## 2. Blockers

`waitingOn` is one of: an employee, `owner`, `coo`, `external`, `release`, or an **item id**.
`startsAfter: <itemId>` is an explicit dependency (a "blocks" link). The payload's `blocker` says:

```
blocker: { kind: 'person'|'owner'|'coo'|'external'|'release'|'item', id, label, status, reason?, since? }
```

`status` is computed on read, so it is always current: the linked item's trueStatus ("In review"),
"release 1.4 approved" / "no release planned", the person's state. When the linked item finishes
(Merged, or Done with resolution done when it has no PR), every item with `startsAfter` or `waitingOn`
on it flips to Ready (held Backlog stays held) and its assignee is told, once.

## 3. Enforcement (refusals carry one next step)

- Blocked without `waitingOn` + `blockedReason` (and no `startsAfter`): refused.
- On hold (`hold: true`) without a `note`: refused. Implicit holds keep the note as `holdReason`.
- While an item stays Blocked, `waitingOn`, `blockedReason` and `startsAfter` can be edited in place
  (the block keeps its `blockedSince`; a teammate wait still converts to a review or a handoff).
- `startsAfter` must name an existing story/task and must not loop.
- In review without a reviewer: refused (unchanged).
- PR merged: the story is set Done (resolution done) if it was not, trueStatus Merged, and Asha is told
  to close it. A sweep repairs a merge that happened outside the Workplace.

## 4. Hygiene monitor (`services/hygiene.ts`)

A sweep every 2 min, silent (and its clocks reset) while the floor is paused.

| rule | violation                                                                                       | after   |
|------|-------------------------------------------------------------------------------------------------|---------|
| a    | top of a person's queue (highest-ranked Ready/In-progress) has no live session on it while they are idle or on a lower item; for Asha: not routed | 10 min |
| b    | In progress with no live session (the stuck watchdog's rule)                                     | 10 min  |
| c    | Blocked without a concrete blocker, or blocked on a closed item                                  | at once |
| d    | In review with no reviewer, or (mode `on`, a story) no PR                                        | at once |
| e    | Done with an unmerged PR that is not approved                                                    | at once |
| f    | an unassigned Ready item at the top of the global queue                                          | 15 min  |
| g    | someone other than the assignee has the live session on it                                       | 10 min  |

Queue order: the epic's place in the focus (non-focus last), then rank, then age; items whose
`startsAfter` is open are not startable and skipped.

Each violation: `{ key, rule, itemId, title, assigneeId, what, since, minutes, fix }`.

- **Asha**, every 10 min: only violations new or changed since her last report (fingerprint =
  rule + item + what), one message through the manager (`hygiene:<at>` record); no session when
  nothing is new.
- **COO**, every 60 min: one bridge item (`coo_items` kind `hygiene`): a summary line, counts per
  rule, the 3 oldest. Nothing when clean.

State in `settings`: `hygiene:seen` (first-seen per key), `hygiene:asha` (`at` + sent fingerprints),
`hygiene:coo` (`at`).

## 5. API

- `GET /api/hygiene` → `{ at, paused, cleanPct, open, clean, counts, violations }`.
- Every item payload: `type`, `trueStatus`, `blocker`, `startsAfter` (`{ id, title, status }`),
  `holdReason`, `closedAt`, and `pr` (`{ number, url, branch, stage, tests, evidence, merged }`).

## 6. Tests (`test/jira-lifecycle.test.ts`)

One per rule a–g; the paused floor (silent, clocks reset); Asha dedupe (same violation not re-sent,
changed one re-sent, nothing new → no session); Asha 10-min and COO 60-min cadence; COO silent when
clean; trueStatus mapping incl. PR stages; refusals (blocked, hold); merge → Merged → Asha closes →
Done; `startsAfter` flips the dependent to Ready and tells its assignee; blocker status follows the
linked item.
