---
id: memory
title: Memory
axis: capability
version: 1
mission: "Own the one account memory Iris shares across devices, so she knows the person without re-asking, never delays a turn, and forgets what she is told to forget."
---
## Mission and scope
- Own account memory end to end: the Mac client (profile cache, recall, events, the memory expert, the desktop Memory view) and the server (store, API, consolidator).
- Own beliefs, episodes and events, the 80 ms recall budget, off-means-off, tombstones, and the scrub of secrets and sensitive categories.
- Own the migration from two stores (the Mac memory service and the phone agent memory) to one, run in parallel for a release before switching reads (extract §C risks).
- Out of scope: the Speaker prompt as a whole (conversation); deploying iris-api or the worker (server); the phone MemoryScreen UI (mobile).

## Owned things
- Client: `services/agent-svc/memory_client.py` (one process-wide `CLIENT`), `memory_api.py` (agent routes `/v1/memory/{state,beliefs,beliefs/{id},settings}`, `DELETE /v1/memory?confirm=yes`, proxying so the renderer never holds the token), `memory_intent.py`, `memory_lookup.py`, `experts/memory.py` (`remember`, `forget`, `list`), the `memory_*` functions in `cloud_client.py`, `iris_settings.py` key `memory_enabled`; `desktop/chat/memory-view.js`, the Memory view in `desktop/chat/chat.html` / `chat.js`.
- Server: `services/iris-api/memory.py` (Python 3.9-safe SQLite, FTS5 with a term-scan fallback), the `/v1/memory/*` handlers in `app.py`, `/v1/chat/memory` kept in shape for the phone, the consolidator thread in `services/cloud-agent/worker.py` (`MEMORY_ON`), `tiers.py` `memory_consolidations_per_week`.
- Tables: `mem_beliefs` (+FTS), `mem_episodes` (+FTS), `mem_events` (with `ref` for idempotent retries), `mem_settings` (`version`, `last_attempt`), `mem_runs`, `mem_meta`; `usage.memory_llm_tokens`.
- Docs: `docs/HLD-iris-memory.md`, `docs/LLD-iris-memory.md` (the contract; change it first), `docs/experts/memory-client.md`, `docs/experts/memory-server.md`, `docs/HLD-memory.md` (the Hivemind tiered design the consolidator was adapted from).
- Tests: `services/agent-svc/tests/test_expert_memory.py` (13), `test_memory_round3.py` (37), `test_memory_outcome_once.py`, `tests/memory_fake_api.py` (a real loopback server), `test_memory_contract_live.py`; `services/iris-api/test_memory.py`, `test_api_memory.py`; `desktop/tests/memory-view.test.js`.
- Requirements: the Memory group of the checklist; portable memory, account sync, item-by-item view and delete, "adapts tone and timing", A3 account data layer.
- Metrics: recall p95 (2–3 ms server-side at 500 beliefs), client budget misses, clarifying questions per 100 tasks memory on vs off, consolidation runs and tokens per plan.

## Interfaces
- Publishes (server, bearer auth, additive): `GET /v1/memory/profile?limit=15`, `POST /v1/memory/recall {query,k}`, `POST /v1/memory/remember {text,source}`, `POST /v1/memory/events` (≤50), `GET /v1/memory/beliefs?cursor=`, `GET/DELETE /v1/memory/beliefs/{id}`, `GET/PUT /v1/memory/settings {enabled}`, `DELETE /v1/memory`. `Belief = {id, topic_key, category, what, confidence, sensitivity, pinned, first_seen, last_seen}`.
- Publishes (client): the `MEMORY:` block for the Speaker (profile ≤15, recalled ≤5, sensitive only when recalled and marked private); entity lookups for the router (names, "my sister", "my project", "the usual").
- Consumes: `said` / `outcome` / `feedback` events from the turn loop and `task_registry.on_finish`; `cloud_client.cloud_enabled()`; the worker's Anthropic client for one Haiku call per consolidation.

## Rules and traps
- The client may never delay or break a turn: recall has a hard 80 ms budget and returns `[]` when it runs out; the profile is served from cache and refreshed off the critical path; events queue and flush in the background; nothing on the read or note paths raises (`memory-client.md` §0).
- One keep-alive `httpx.Client` for memory calls; a new TLS handshake per recall would use the 80 ms by itself.
- Off means off: signed out, `memory_enabled` false, or off on the server means no requests, no queued events, no MEMORY block, no router lookups; a server `{"enabled": false}` (or 403/409) drops the queue and does not retry.
- Delete is a tombstone with no words: `deleted=1`, `what=''`, `evidence='[]'`, topic key kept; the consolidator never resurrects a tombstoned key or a subject whose words contain one; `DELETE /v1/memory` wipes everything including tombstones (`memory-server.md` §2).
- "Forget everything" is refused by voice and pointed to the view so a mishear cannot wipe a memory; `forget` names what it deleted only after the delete returns ok; `remember` confirms only after the server returns the stored belief.
- Sensitive categories (health, finance, sexuality, religion, ID numbers) are never inferred; stored only on explicit ask; never in `profile`. Scrub on inputs and outputs: card numbers, Aadhaar, SSN, PAN, OTP/PIN/CVV, passwords, account numbers, API keys → `[redacted]`.
- Raw screen text is never stored; the 969 existing captures are to be deleted with a retention rule (M0, `HLD-iris-memory.md` §3, §7).
- `IRIS_MEMORY_CONSOLIDATION=0` stays set in production until the owner says otherwise (the kill switch in `worker.py`; `IRIS-WORKPLACE-PROMPT.md` §4).
- `version` moves only on content writes; recall's `uses` bump does not, or the client's 10-minute profile cache would be defeated.
- The MEMORY block sits directly after the fixed rules so rules plus profile form the stable, cacheable prefix; today the Speaker prompt (~2.1k tokens) is under Haiku's 4,096-token cache minimum.
- Consolidation budget per plan: free 1, p5 3, p10 7, p20 15, p100/p200 42 runs a week, bounded at 5,000 tokens a run and 2% of a plan's price; an explicit remember bills to the conversation half, not context (free's context half is 240 tokens/day).
- Low-confidence beliefs are hedged or left out and never drive a consequential action without confirmation; connectors still confirm every time (`HLD-iris-memory.md` §4).
- Changing the contract means changing `docs/LLD-iris-memory.md` first; server and client build against it.

## Definition of done
- `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests` (state the count) including the loopback-server tests; `cd services/iris-api && ../../.venv/bin/python -m pytest -q test_memory.py test_api_memory.py` (283 passed for the whole API suite on 27 Sep); `cd desktop && npm test` for the view.
- The contract test against the real iris-api in a subprocess (`test_memory_contract_live.py`) green.
- A live check: "remember …", "forget …", "what do you know about me" spoken on this Mac; recall timings from the log under 80 ms; the Memory view listing and deleting one belief.
- Cost stated: `$0` when no model call was made (the server build spent $0); tokens per consolidation otherwise.
- "Not verified" must name the consolidator on a real worker if only unit-tested.

## How to build, test and ship
- Client tests as above; server: `cd services/iris-api && ../../.venv/bin/python -m pytest -q`; worker: `cd services/cloud-agent && ../../.venv/bin/python -m pytest -q test_agent.py`.
- Ship: client changes ride the desktop release (desktop-mac); server changes go as a commit or patch to the `deploy/api-*` branch in `~/claude-dev-deploy` and ship via `scripts/deploy-api.sh` then `scripts/deploy-agent.sh` (server), each needing an approved Inbox item. Back up `/opt/iris-api/iris.db` before any schema migration.

## Coordinate with
- server: schema, the `/v1/memory/*` routes, deploy order (API before agent), tiers budget.
- conversation: the MEMORY block placement, the 80 ms budget inside the turn, prefetch on interim words.
- experts: `memory_lookup` in the router, outcome events, `experts/memory.py` contract fields.
- mobile: `/v1/chat/memory` shape for the phone MemoryScreen; the migration of the phone's facts.
- product-and-business: view and delete, portable memory, transcript and sensitivity policy.

## Needs owner approval
- Turning consolidation on in production (`IRIS_MEMORY_CONSOLIDATION`).
- Any change to what is inferred, stored or scrubbed; any deletion of user data beyond a user's own request.
- Deploys carrying memory schema changes.
