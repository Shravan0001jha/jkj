# Capabilities unit

The Capabilities unit owns the things Iris does that cut across every device: the voice loop, the character, the experts, memory and the server that all of them talk to. Its charters are `conversation`, `character`, `experts`, `memory` and `server`. Dev holds conversation and character; Mira holds experts; Kabir holds memory and server and also sits in the Platforms unit as the server chapter member.

## What it is for

- Keeping the two hard contracts on the Mac: something visible or audible every 500 ms while a turn is pending (`docs/HLD-responsiveness.md` §0, `harness/ack_gaps.py --strict`), and only the Speaker ever speaks (`docs/HLD-single-speaker.md`).
- Keeping actions honest: an expert runs first and then speaks its real result; unverified mutations are hedged; failures are admitted (`docs/experts/core.md`).
- Keeping memory fast and private: an 80 ms recall budget that returns nothing rather than delaying a turn, off means off, tombstones that are never resurrected (`docs/experts/memory-client.md`, `memory-server.md`).
- Keeping every paid call behind iris-api, capped per user and per plan, deployed whole from `~/claude-dev-deploy` (`scripts/deploy-api.sh` OWNERSHIP paragraph).

## How the charters coordinate

- conversation ↔ character: the bus events (`heard`, `attending`, `unsure`, `saying`, `speaking`, `filler`, `awaiting`, `delivered`) and the pending-state contract; a cadence change needs both sides and a live `ack_gaps` run.
- conversation ↔ experts: `speaks` functions, `dispatch_policy` ack shapes, the delivery gate's task lifecycle, the yes/no and "send" intercepts.
- experts ↔ server: the chat tier for `info` and workspace jobs, the errand relay, the coming tool-use endpoint for the agent loop.
- memory ↔ everyone: the MEMORY block in the Speaker prompt, entity lookups in the router, outcome events from the task registry, the `/v1/memory/*` routes hosted and deployed by server.
- Contract changes (`docs/LLD-iris-memory.md`, the expert `Fn`/`Result` contract, bus event shapes) are edited in the doc first and need both sides; after the repo split they live in the shared contracts repo.

## Shared rules

- RCA with log evidence, a control run on the old code, and a test that failed first, for every fix.
- Evals call a model, cost money and vary; report the cost; never drive the owner's real tabs, apps or accounts.
- Nothing here restarts or touches the owner's running Iris without saying so.
- All four suites are stated with counts in every done-report: agent-svc pytest, iris-api pytest, cloud-agent pytest, desktop `npm test`.

## Who leads

Dev leads the unit (conversation and character) and is the escalation point for Mira and Kabir; Dev goes to the Chief of Staff.
