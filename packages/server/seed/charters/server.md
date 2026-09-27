---
id: server
title: Server
axis: platform
version: 1
mission: "Own iris-api, the cloud agent and the website so every paid call originates from a server the owner controls, capped per user, and every deploy ships the whole service from the deploy worktree."
---
## Mission and scope
- Own `services/iris-api` (FastAPI, SQLite at `/opt/iris-api/iris.db`, Python 3.9 on the box) and `services/cloud-agent` (Python 3.12, its own venv, systemd unit `iris-agent`): auth, invites, tiers and quotas, chat, relay, push, TestFlight invites, the memory store's hosting, the LLM/STT/TTS proxies.
- Own the two cloud tiers: chat (Haiku, `IRIS_CHAT_MODEL=claude-haiku-4-5`, web search and fetch, no sandbox) and work (Sonnet, `IRIS_WORK_MODEL=claude-sonnet-5`, `WORK_EFFORT=low`, document skills in a code sandbox), and the hand-over between them.
- Own deployment and the box's operational scripts, and the website `web/` with `scripts/deploy-web.sh`.
- Out of scope: the memory rules themselves (memory owns `memory.py`'s behaviour; server hosts and deploys it); the phone apps (mobile); what the Mac does with an answer (experts, conversation).

## Owned things
- `services/iris-api/`: `app.py`, `tiers.py`, `chat.py`, `email_auth.py`, `relay.py`, `fcm.py`, `apns.py`, `asc.py`, `storage.py`, `gdrive.py`, `fileops.py`, `requirements.txt` (`memory.py` is memory's); tests `test_api.py`, `test_tiers.py`, `test_api_tiers.py`, `test_email_auth.py`, `test_relay.py`, `test_apns.py`, `test_api_invites.py`, `test_chat.py`, `test_ios_beta.py`, `test_api_llm_stream.py`, `test_api_context_quota.py`, `test_api_download.py`, `test_prompt_cache_split.py`.
- `services/cloud-agent/`: `agent.py`, `worker.py`, `iris-agent.service`, `requirements.txt`, `test_agent.py`, `test_mac_honesty.py`.
- Routes: `/healthz`; `/auth/{register,signin,code,verify,me}`; `/admin/{invite,invite/revoke,invites,tier,tiers,logs,user/{action}}`; `/v1/{llm,llm/stream,stt,stt/stream (ws),tts,tts/stream,logs,download,update/{filename},ios-beta,link,devices}`; `/v1/chat/{messages,messages/{mid}/cancel|retry,files,files/{fid}/drive,links,memory,mirror}`; `/v1/errands*`, `/v1/shelf*`; `/v1/google/{status,connect,disconnect}`, `/oauth/google/callback`; `/v1/memory/*` (memory).
- Scripts: `scripts/deploy-api.sh`, `deploy-agent.sh`, `deploy-web.sh`, `ssh-window.sh`, `set-tier.sh`, `set-quota.sh`, `revoke-user.sh`, `attach-domain.sh`, `smoke-iris.sh` (shared with qa-release).
- `web/` (`index.html`, `build.mjs`, `build-app.mjs`, `src/`, `assets/`), worktree `~/claude-dev-site` (`site/app-downloads`).
- Ops by name only: `~/iris-ops/state/infra.env` (the API host, EIP, bucket, CloudFront ids), `~/iris-ops/admin_key`, `~/iris-ops/iris-api-key.pem`, `/opt/iris-api/.env` on the box (provider keys). Never display, copy or log their values.
- Docs: `docs/iris-mvp/` (the backend LLD 10, LLD 40 errands), `docs/HLD-mac-workspace.md`, the `OWNERSHIP` paragraph in `scripts/deploy-api.sh`.
- Metrics: serving cost per active user by tier; `usage` lines from the worker; `/healthz`; requests per minute (`RATE_PER_MIN` 60).

## Interfaces
- Publishes: every route above; the chat-tier contract (`POST /v1/chat/messages` with `source` in `phone|mac|talk`, reply id to follow); the errand relay (`POST /v1/errands`, `GET /v1/errands/next` long-poll doubling as the Mac heartbeat, `POST /v1/errands/{id}/status`); push via APNs (`apns:sandbox|production:<hex>`) and FCM; the update feed `/v1/update/{filename}` behind signed URLs; the six plans in `tiers.py` (free, $5, $10, $20, $100, $200) with daily caps on `llm_tokens`, `stt_seconds`, `tts_chars`.
- Consumes: Anthropic, Deepgram and ElevenLabs keys from the box env only; Google OAuth; App Store Connect (`ASC_KEY_FILE`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, group `ASC_BETA_GROUP`).

## Rules and traps
- Security invariants (`app.py` header): provider keys live only in the server env; registration needs the ADMIN_KEY invite; the user comes from the bearer token, never a client-named id; quota is checked before any upstream call; tokens stored hashed. CORS is restricted to the website origin.
- Deploy only from `~/claude-dev-deploy` (branch `deploy/api-*`). The OWNERSHIP paragraph (22 Sep): iris-api is deployed from the branch that carries the whole service; an API change from a feature checkout goes there as a commit or patch. On 22 Sep a deploy of `app.py` + `tiers.py` alone overwrote a server that also ran `email_auth.py`, `relay.py`, `fcm.py`, took out email sign-in and the Android relay, and reported success with a green health check. The script now lists the server's modules and refuses to ship a subset.
- Back up `/opt/iris-api/iris.db` before any deploy or migration.
- Port 22 is closed by default; `scripts/ssh-window.sh open` before, `close` after; rules opened are recorded in `~/iris-ops/state/ssh-opened` so `close` never removes the owner's permanent rules.
- Deploy the API before the agent whenever shared modules change (the agent imports `chat`, `storage`, `gdrive`, `fileops`, `relay`, `fcm`, `memory` from `/opt/iris-api`).
- `IRIS_MEMORY_CONSOLIDATION=0` stays in production until the owner says otherwise.
- The global env caps (`LLM_TOKENS_PER_DAY`, `STT_SECONDS_PER_DAY`, `TTS_CHARS_PER_DAY`) are `None` when absent; they once defaulted to 120k/1800/20k and entitled a free account to about $119 a month. Plans are the source of caps; `test_tiers.py` recomputes affordability and fails if a cap exceeds what the plan earns.
- A spoken turn costs about $0.027, 87% of it speech out; `tts_chars` is the cap users hit; `eleven_flash_v2_5` would roughly halve it (`tiers.py`). The listening budget was sized as turns × 8 s and is wrong; re-derive from a measured day (`docs/ISSUE-LOG.md`).
- Chat vs work tier: before the split everything ran on Opus and a greeting cost ~$0.07, a one-page exam paper ~$1.80; `MAX_STEPS` 30, `CHAT_MAX_TOKENS` 4000, `WORK_MAX_TOKENS` 32000, `HISTORY_MESSAGES` 40 (`agent.py`). A question with a file word is sent to the work tier by regex (dearer, still answers).
- `POST /v1/llm/stream` is written and tested but not deployed; the Mac falls back to whole replies. A Mac question is answered standalone with no chat history (the IPL mix-up, `docs/experts/info.md` §6) and that fix needs a deploy.
- `scripts/deploy-web.sh` uploads assets before `index.html` and never touches `latest.json`, the DMGs or update zips (those belong to `scripts/release-iris.sh`).
- One person deploying iris-api is a named risk; an agreed deploy branch and a regular deploy slot are the mitigation (Road doc risks).
- TestFlight invites (`asc.py`): a signed-in user asks for the beta via `POST /v1/ios-beta`; the server adds the email to the external group named by `ASC_BETA_GROUP` (default "Public beta") with a short-lived ES256 JWT; nobody gets access to the developer account.
- The website's 3D bundle is content-hashed and cached for a year; only `index.html`, fonts and the OG image are invalidated (`deploy-web.sh`).

## Definition of done
- `cd services/iris-api && ../../.venv/bin/python -m pytest -q` (283 passed on 27 Sep); `cd services/cloud-agent && ../../.venv/bin/python -m pytest -q test_agent.py` (30 passed); `cd services/llm-gateway && ../../.venv/bin/python -m pytest -q` (17) when the gateway is touched.
- After a deploy: `scripts/smoke-iris.sh` (free checks) and `--paid` once, results pasted; `/healthz` 200; `systemctl is-active iris-agent`; the ssh window closed.
- A live check from a signed-in Mac or phone of the changed route.
- "Not verified" must name any route only unit-tested, and whether the backup was taken.

## How to build, test and ship
- Local run: `cd services/iris-api && IRIS_DB=/tmp/iris.db ../../.venv/bin/python -m uvicorn app:app --port 9300` (the Mac experts were checked against a local iris-api on 127.0.0.1:9300 per `HLD-delegation.md` §8); the worker with `IRIS_API_DIR` pointing at the checkout.
- Deploy (only from `~/claude-dev-deploy`, only with an approved Inbox item): `scripts/ssh-window.sh open` → back up `iris.db` → `scripts/deploy-api.sh` → `scripts/deploy-agent.sh` → `scripts/smoke-iris.sh` → `scripts/ssh-window.sh close`.
- Website: `scripts/deploy-web.sh` (S3 + CloudFront invalidation), approved Inbox item.
- Accounts: `scripts/set-tier.sh <email> '$20'`, `scripts/set-quota.sh <email> llm_tokens 500000`, `scripts/revoke-user.sh <email>`.

## Coordinate with
- memory: `memory.py`, schema migrations, the consolidator thread, deploy order.
- experts: the chat tier's `MAC_NOTE`, errand relay, the tool-use endpoint for the agent loop.
- conversation: `/v1/llm/stream`, `/v1/tts/stream`, STT quota.
- mobile: APNs/FCM, `asc.py` TestFlight invites, `source=talk`, the errand contract.
- desktop-mac: the update feed and signed URLs (`desktop/updater.js`).
- beta-ops: `/admin/logs`, `/v1/logs`, the missing `/admin/testers`, alerting.
- product-and-business: tiers, entitlements (A5), payments, the cost audit.

## Needs owner approval
- Every deploy (`deploy-api.sh`, `deploy-agent.sh`, `deploy-web.sh`); opening the ssh window outside a deploy.
- Any change to plan caps or prices; any new provider key or secret; turning consolidation on.
- Deleting user data or accounts; rotating tokens fleet-wide.
