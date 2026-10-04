# DRAFT (not applied) — handbook section: pull requests and the two approvals

For `~/iris-workplace/handbook.md`. It uses the same terms as the COO's draft in
`~/iris-workplace/next/handbook.md` ("A story's life") and adds what the server actually does, so the
two can be merged into one section. Apply only with the owner's go-ahead, together with
`POST /api/coo/github {"mode":"shadow"}` or `"on"`.

## Pull requests and the two approvals

- **You never push.** When you call `report_done` (or `request_review`), the Workplace checks your
  branch `emp/<you>/<story id>` and, if it is clean, pushes it and opens a pull request to
  `feat/iris-character`. The reply gives the pull request number.
- **The checks before any push** (what is refused never leaves the Mac):
  - the branch must be exactly `emp/<you>/<story id>`;
  - no build output (`dist-*`, `node_modules/`, `__pycache__/`, `.pyc`, installers) added or changed;
    delete it on your branch and commit, then call `report_done` again;
  - no file over 5 MB; same fix;
  - no leaked secret anywhere in your branch's commits, even one you deleted later. Escalate to the
    COO at once: the key must be rotated and the commit removed from your branch history, which only
    the COO can do.
- **The tests check** (`workplace/tests`) then runs on the Mac: lint, type checks and the suites of
  the areas your branch touches (`~/iris-workplace/quality.yaml`). A failure is posted on your story
  with what failed; fix it on your branch and call `report_done` again.
- **Approval 1 of 2: the developer approver**, a lead who is not the author (another lead for a
  lead's own story), calls `review_approve` or `review_send_back` with exactly what to change.
- **Approval 2 of 2: QA** (Nikhil, or Zoya for the quality charter), only after the developer
  approval. `review_approve` marks the story done; `review_send_back` carries the root cause.
- **Any new commit resets both approvals**, and the evidence becomes stale (`run_evidence` again).
  The Workplace notices a new commit within a minute and pushes it.
- **A QA send-back you disagree with:** `review_dispute` once, with your reason. Asha decides; if she
  can't, the COO; then the owner.
- **Merging is the COO's.** Approved is not merged: check the trunk before you call anything shipped.
- **Local mode** (GitHub off, or after GitHub failed three times in five minutes): nothing is
  pushed, and the review tools answer "local mode". Review as before: the reviewer marks the story
  done with `item_update`, or moves it to in-progress with what to change.
