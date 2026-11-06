# LLD: batched pre-merge testing + fast lane

## 1. Module `services/batch-test.ts` (new)

### Storage (in the `settings` table, no new table)
- `batch-test:queue`: JSON list of `BatchRequest`, in queue order.
- `batch-test:current`: JSON `Batch` or absent.
- `batch-test:spend:<YYYY-MM>`: JSON `{ batchInr, fastInr }`.
- `batch-test:mode`: `on` (default) or `off`. With `off`, `run_evidence` behaves as before.

### Types
```ts
interface BatchRequest { itemId; headSha; by; features: string[]; at: ISO; fast?: true; attempt: number }
interface Batch { id; at; requests: BatchRequest[]; dropped: { itemId; why }[]; branch?; sha?; jobId?;
                  split?: { left: string[]; suspect: string; failures: string[] }; fast?: true; state: 'assembling'|'running' }
```

### Pure functions (unit-tested)
- `featureOf(failure)`: `"android reminder.complete.nomac FAIL ..."` → `reminder`; null if unparseable.
- `verdicts(requests, failures, state)` → `{ pass: string[]; fail: Record<string, string[]>; ambiguous: { feature; claimants; failures }[]; orphan: string[] }`.
- `due(queue, nowMs, capReached)`: the trigger rule (10 requests / 60 min, or 240 min at cap / any fast).
- `modelFor(requests)`: `cheap` unless a request has `modelChoice` or a feature in `MODEL_CHOICE_FEATURES` (`phoneasks`).
- `Deps.qaStory(batch)`: files the batch QA story (`items.create` under the QA epic, assigned to QA) on every batch start; its id is `Batch.qaStoryId`.
- `EvidenceJob.robotModel` and `RunnerRequest.robotModel`: the `robot_model` suite input, sent only when declared.
- `estimateInr(durationS)` = `ceil(durationS / 60 * 0.5 + 15)`. The Linux minute is $0.006 ≈ ₹0.5; plus about ₹15 of model turns.

### Effectful functions
- `request(wp, { itemId, by, features, fast? })` → `{ ok, message, position? }`:
  - refuses an unknown item or one with no PR head;
  - `fast` from anyone but the CTO;
  - `fast` when the month's fast spend plus 25 would pass 1000;
  - a duplicate (the same item queued) refreshes headSha and features instead.
- `tick(wp, nowMs, deps)`: if no current batch, not on hold, and `due` → assemble and start.
  - `deps.assemble(requests)` → `{ branch, sha, dropped }` (port: git in the trunk repo).
  - `deps.enqueue(spec)` → jobId (port: `evidence.enqueueBatch`).
- `onResult(wp, batchId, rec, deps)`: verdicts, split or error handling, spend recording.
  - `deps.verdict(itemId, state, note)`: real = `githubFlow.setEvidence` + a trail comment, then `githubFlow.autoMerge`.
- `state(wp)` for the API.

## 2. `services/evidence.ts` (small changes)
- `EvidenceJob.batch?: { id; repo; trunk; branch; sha }`.
- `enqueueBatch(wp, { batchId, repo, trunk, branch, sha, features, by })`: pushes a queued job with `itemId = 'batch-<id>'`, platforms `['android']`, `requestedSha = sha`, and the batch fields. It skips the per-story request checks.
- `execute`: when `job.batch` is set, the context is `{ repo, trunk, branch, head: sha }` from the batch, not `storyOf(item)`.
- `finish`: when `job.batch` is set, it calls `batchTest.onResult(wp, job.batch.id, rec)` and skips per-story recording. The shared link, slimming and the delivered summary still happen.

## 3. Real ports (`services/batch-test.ts`)
- `gitAssemble(repo, trunk, requests)`:
  - `git branch -f batch/<id> <trunk>` in a scratch worktree (`<repo>/../.batch-wt`);
  - per request, `git merge --no-ff --no-edit <headSha>`; on conflict, `git merge --abort`, then record it as dropped with the conflicting files (`git diff --name-only --diff-filter=U`);
  - returns the final sha.
- The batch branch is pushed by the GitHub runner exactly as story branches are (`RunnerRequest.branch`).

## 4. Agent tool `run_evidence` (`services/employees.ts`)
- New optional arg `fast: boolean` (CTO only).
- The handler: when `batchTest.routes(wp, item, platforms, by, fast)` is true (mode on, android-only, not a release gate), it calls `batchTest.request` and answers with the queue position and the trigger. Otherwise `evidence.request` as today.

## 5. HTTP (`http/routes.ts`)
- `GET /api/coo/batch-test`: queue, current batch, month spend, mode.
- `POST /api/coo/batch-test` with `{ mode?: 'on'|'off', startNow?: true }`. `startNow` triggers a batch on the next tick regardless of size or age (COO).

## 6. Sweep
`startBatchTest(wp)` runs `tick` every 60 s. It is started next to `startEvidence` in `index.ts`.

## 7. Events
`batch.started { id, itemIds, sha }`, `batch.finished { id, pass, fail }` via `wp.emit` (added to WorkplaceEvent).

## Tests (`test/batched-testing.test.ts`)
- `featureOf` parsing.
- `verdicts`: single claimant fails; ambiguous; orphan; all pass; error.
- `due`: 10 queued; 60 min; cap slows to 240 min; fast is immediate.
- `request`: refuses fast from a non-CTO, and fast over budget; a duplicate refreshes.
- `tick` with fake ports: assembles, enqueues, records the current batch; a conflict drops one PR and continues.
- `onResult`:
  - pass → a verdict per item, spend recorded;
  - single fail;
  - ambiguous → split batch queued once, and its result resolves blame;
  - error → re-queued once, then a COO alert;
  - a head that moved → re-queued, no verdict.
