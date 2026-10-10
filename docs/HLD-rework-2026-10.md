# HLD: Workplace rework (October 2026)

Source of every decision: the owner's 10 Oct session, recorded in `~/iris-workplace/plans/workplace-rework-owner-points.md` (the "points" file below). This HLD turns those decisions into a system design. The owner delegated the design to the COO and will not review it.

Scope covers the Workplace only: the server, the iOS Workplace app, the org data, the rules, and Notion docs. Iris product work and Iris's robot suite (voice suite, virtual audio) are out of scope.

## 1. Goals

1. **One org tree drives everything.** It decides who can move a story, reassign it, approve it, and who hears about a stall.
   - The tree is owner → COO → (Asha, Vikram).
   - Asha → charter leads and the QA lead → their team members.
   - Vikram is a peer of Asha. He has technical authority but sits outside the assignment chain.
2. **Stories explain themselves.** Every story shows its explicit state, the reason for every change in an audit section, and its full chain (developer, reviewers, QA, charter, lead, Asha).
3. **Rules are enforced in code, not just written.** That covers:
   - RCA before code;
   - RCA-only tickets;
   - reassigning a story ends the old session;
   - one story per person;
   - QA proof;
   - no silent truncation.
4. **The owner sees only what needs him:**
   - finished epics are hidden;
   - the COO is copied on and works down the owner's Inbox;
   - agent chat older than 3 days is deleted;
   - notifications are sent only for real decisions, approvals, stall level 4, or super focus mode.
5. **Stalls climb a 10-minute chain** (lead, then Asha, then COO, then a ring to the owner). This replaces five overlapping detectors.
6. **Plain services replace the COO's manual work:**
   - a queue for the owner's Mac;
   - a test-account pool;
   - automatic merges;
   - a GitHub cost watcher.
7. **Big documents live in Notion,** written and commented on through Workplace tools. Comments are capped at 1200 characters and are never cut silently.

## 2. Components and what changes

| Component | Today | After |
|---|---|---|
| Org (`org.ts`, `org.yaml`) | Leads report to the CTO. There are no tree helpers. People hold charters across teams. | Leads and the QA lead report to Asha. Teams are lead groups that may span charters. One person belongs to one team. Tree helpers: `managerOf`, `ancestors`, `isAbove`, `teamOf`, `leadOf`. |
| Item model (`items.ts`, shared types) | 6 statuses. "Waiting" is rewritten as a review or handoff. Reasons are optional. Anyone can move any item. | 8 statuses: `waiting` and `parked` are added. Every move needs a reason. Moves and reassignments are checked against the tree. Detail responses include an `audit` and a `chain`. |
| Dispatch and sessions (`dispatch.ts`, `employees.ts`, `lifecycle-watch.ts`) | Starts only focus work. A session moves between stories and leaves the old one In progress. Reassigning or merging leaves sessions open. | Focus is priority, not a filter. A story that is left goes back to Ready. A reassignment or a merge ends that session. Asha routes to leads, and a lead's assignment starts the engineer. |
| Stalls (`watch`, `stuck`, `hygiene`, `manager`, `dispatch.idleAlerts`) | Five detectors, mostly alerting Asha. 19% of her comments say "not a real stall". | One `stall-chain` service: at +10 min the lead, +20 Asha, +30 COO, +40 a ring to the owner. Daytime only unless super focus is on, and one ring per tick. The old detectors stop alerting. `health.ts` (killing runaway turns) stays. |
| Review and QA (`github-flow`, `review-policy`, `qa-doc`, `evidence`) | Developer approval comes from any lead. QA is picked by load and has no proof rule. Auto-merge ignores evidence. Every new commit resets approvals. | The developer approver is a member of the author's team. Extra reviewers are added from `map.yaml` for real code in other teams' charters. One QA per story. QA cases cite evidence. Merging needs evidence passed or marked n/a. A commit that only merges trunk keeps approvals, and branches are updated through GitHub's update-branch. |
| RCA (`items.type`, `guards.ts`, `work.ts`) | No RCA type and no gate. | Story types `bug` and `rca`. A bug has no write access (Edit tools and git commits) until a five-part `## RCA` is on the item. An `rca` story never gets write access, and it is done when the RCA is posted. Filed bugs go to the QA lead first. |
| Comments (`one-line.ts`, `trail`, `read-tools`) | Cut to 400 characters and moved to `details`. Plans and RCAs get dropped from context. | Agent comments are capped at 1200 characters, and longer ones are rejected with "make this a doc". The full text is stored. Plan and RCA comments are pinned in reads and captured from comments. |
| Prompt assembly (`context-layers.ts`) | The assignment layer can be dropped. Some prompt text contradicts the handbook. | The assignment and workspace layers are always kept, and the handoff layer is trimmed first. Prompt text is brought in line with the handbook. |
| Inbox, Talk and push (`inbox`, `coo`, `push`, `talk-store`) | The COO isn't copied. Every owner item, update, and room mention is pushed. Talk is kept forever. | Agent-raised owner items are copied to the COO, held 15 minutes for him to triage, then pushed. The COO can resolve them or add a note. Update and room pushes stop. A super-focus setting exists. A daily job deletes agent Talk messages older than 3 days. |
| Plan (`items.plan`, iOS `PlanView`) | Finished epics are listed. | Epics carry a `finished` flag. iOS collapses finished epics into "Done (N)". |
| Services | A shell-script window queue. A fresh test account per run. The COO merges by hand. No cost watcher. | A `mac-queue` service with `request_mac` and `release_mac` tools. A `test-accounts` pool with lease and return. Auto-merge that needs no COO (only workflow or infra changes wait for COO approval). A daily GitHub cost watcher that sends an Inbox alert on spikes. |
| Docs | Claude Docs links published by the COO. | Notion "Iris Docs" database, with the `doc_write`, `doc_read` and `doc_comment` tools. Comments are named per agent. The owner's Notion comments are relayed to the doc's owner. |
| Rules text (`~/iris-workplace`) | Contradictions, staleness, duplication. | A rewritten handbook that is the single source of truth, plus cleaned charters, roles and org. |

## 3. Key flows

1. **A bug is filed** by anyone, with `item_create type=bug`. It is assigned to the QA lead and goes Ready. QA posts an `## RCA` with a "why QA missed it" part. QA reassigns it to Asha (QA's manager), who routes it to the charter lead. The lead assigns an engineer, who builds. Write access unlocks because the RCA is present. Review and QA follow.
2. **A story moves.** The actor calls `item_update` with a status and a reason. The tree check runs, then the transition rules, then the audit row is written. Leaving In progress lets the dispatcher start the person's next story.
3. **A stall.** Each minute the stall-chain sweep evaluates every Ready or In-progress story with an agent assignee. If the story is stalled, a level is computed from `since`. Each new level notifies its target once. At level 4 (40 minutes) the owner gets one ring, combined across stalls in that tick, during the day or in super focus.
4. **An owner Inbox item from an agent.** Only Asha and the CTO may use `ask_owner`; others escalate to their manager. The item is copied to the COO bridge and held. Then one of three things happens:
   - the COO resolves it, and the owner sees it as answered;
   - the COO marks it "needs you because …", which pushes it now;
   - 15 minutes pass, and it pushes.
5. **A doc.** An agent calls `doc_write` with the item and markdown. The Workplace creates or updates the single Notion page for that story (typed template, required properties) and links it on the item. `doc_comment` posts a comment under the agent's name. The owner's Notion comments are polled every 2 minutes and relayed to the doc's owner.

## 4. Non-goals and constraints

- **No web story UI.** The web app has no v2 views, and the owner uses iOS.
- **No AI inside the services.** They are deterministic.
- **Agents never hold secrets.** Notion, GitHub and test-account credentials stay server-side.
- **Changes are additive** to the SQLite store, using JSON fields and `create table if not exists`, with no destructive migrations. The one exception is the Talk retention deletion the owner asked for.
- **The floor stays paused** until the owner says restart.
