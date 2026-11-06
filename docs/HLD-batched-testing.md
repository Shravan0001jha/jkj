# HLD: batched pre-merge testing + fast lane

Owner decision, 4 Nov (Telegram). Design brief: `~/iris-ops/coo/designs/batched-pre-merge-testing.md`.

## Problem
Each story proves its own fix with its own robot run (`run_evidence`) after both approvals. On 2–3 Nov that meant 24 GitHub robot runs and about ₹300 a day on the staging key. A bad build (a76c0833) also reached the trunk before it was proven live, and broke staging chat twice.

## Goal
- A PR that needs live or device proof is proven **before** it merges, inside a **batch**: one combined build, one staging deploy, one robot run.
- Each PR gets its own verdict.
- Spend is capped:
  - batch testing: about ₹3,000 a month;
  - fast lane: ₹1,000 a month, owned by Vikram (CTO);
  - both inside the ₹5,000 a month real-money cap.

## Flow
1. **Ask.** A developer or QA calls `run_evidence` as today. If the run is Android-only, the story is not a release gate, and the caller is not using the fast lane, it joins the **batch queue** instead of starting its own run. The answer says so, with the queue position and the next trigger.
   - iOS and Mac are refused as today: they go to the Mac agent (owner, 3 Nov).
   - A release-gate story (ios allowed) keeps today's per-story path.
2. **Waiting.** While queued, the PR's evidence is unset, so the existing auto-merge stays `waiting` exactly as it does today while a run is pending. No new merge path.
3. **Trigger.** A sweep (every minute) starts a batch when any of these holds, and no batch is running:
   - 10 requests are queued;
   - the oldest has waited 60 minutes;
   - a fast-lane request is waiting.

   It does not start while a COO evidence hold is active. Once the month's batch spend reaches its cap, the 60-minute trigger becomes 4 hours: batches slow down but never stop.
4. **Combined build.** The batch creates `batch/<id>` from the current trunk, then merges each queued PR head in queue order (no fast-forward).
   - A PR that conflicts is dropped from this batch. Its story gets a comment with the conflicting files; the author resolves it and asks again.
   - The rest go on. A batch left with nobody is closed.
5. **One run.** The batch hands the evidence engine one job for the combined commit:
   - features: the union of all requests;
   - platform: android;
   - the engine does what it does today: staging lock, a server deploy when the build changes iris-api or cloud-agent, the GitHub suite, result scoring.
   - The deploy runs its full tests: `DEPLOY_SKIP_TESTS` is valid only for trunk commits, and the combined build is not one. This is the price of proving code before it merges; it is still one deploy per batch, not one per story.
6. **Verdicts.** Each failing case names its feature (`android <feature>.<row> FAIL ...`).
   - A failure whose feature exactly one PR declared fails that PR.
   - A failure whose feature several PRs declared is ambiguous: the batch is **split once**. It reruns without the most recently queued of those PRs. A pass blames that PR; a repeat failure fails all the remaining claimants, with the shared failure text.
   - A failure in a feature nobody declared fails no PR. It goes to the COO as a trunk problem.
   - Each PR whose head is unchanged since it was queued gets `setEvidence(success|failure)` with the batch report. A passing PR's existing auto-merge then runs as usual.
   - A PR that moved during the batch gets nothing; it re-queues.
7. **Run error** (the run could not run): the batch re-queues all its requests once, at the front. A second error alerts the COO.

## Fast lane (Vikram)
- Only the CTO may pass `fast: true` to `run_evidence`. He decides per request whether a blocked committed deliverable is worth money now, or waits for the batch.
- A fast request starts its own batch of one at once, ahead of the queue.
- Its estimated cost is charged to the fast-lane month budget (₹1,000). Once that is spent, `fast` is refused with the month's figure, and the request can still join the normal batch.

## What does not change
- Approvals, workplace/tests, the spend hold and the CTO-comment hold in auto-merge are untouched.
- Docs-only and unit-only PRs never call `run_evidence`, so they merge as today.
- The COO's `evidence/hold` and `evidence/cancel` still work, on the batch job too.

## Interactions
- **Staging no-rollback guard (06/14 UTC batch script).** After a batch, staging serves the combined commit. A signed trunk sha that is an ancestor of it is refused as a rollback, which is correct: the batch already carries it. The next trunk (with the merged PRs) is not an ancestor, so it deploys.
- **Pace cap.** Batch runs are Workplace runs, not agent turns: they run while agents are parked.

## Failure modes
| Failure | Behaviour |
|---|---|
| Merge conflict | That PR is dropped and its author told; the batch goes on. |
| The combined build breaks the deploy | Run error: re-queued once, then the COO is alerted. |
| A flaky failure | Shows as a PR failure. The author can ask again; it joins the next batch. |
| A PR pushes during its batch | No verdict; it re-queues. |
| The Workplace restarts mid-batch | The batch row is `running` with an evidence job id. On start, a batch whose job is gone is treated as a run error. |

## Cost estimate
About 1 run an hour at most, typically 4–8 a day, against 11–13 a day today. Per run: about ₹10 of GitHub time plus about ₹10–20 of staging model turns.

## Added on 4 Nov (owner-approved settings)
- **Cheaper model for robot runs.** A batch whose requests touch no model-choice feature (today `phoneasks`), and where no request sets `modelChoice`, runs with `robotModel: cheap`. The GitHub runner sends the suite input `robot_model=cheap`, but only if suite.yml declares it. **Not built yet on the other side:** iris-e2e must declare `robot_model`, and the staging chats must honour it (for example a header or the pool plan). Until then the input is simply not sent and the run uses the default model.
- **A QA story on every batch staging deploy.** Each batch, including a split rerun, files one story under the staging QA epic (`ft_mux2bymofcokx`, or the setting `batch-test:qa-epic`), assigned to QA. It lists every carried PR and its features. QA checks what the robot cannot: model-decided rows and device-only cases.
- **Caps:** batch ₹3,000 a month (at the cap the trigger slows from 60 to 240 min); fast lane ₹1,000 a month, CTO only.
