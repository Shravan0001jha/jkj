# Iris Workplace for iPhone

The owner's phone client for the Workplace: Office, Inbox with one-tap answers, Talk to any
employee, Features with the progress pivot, and alerts. SwiftUI, iOS 17+. Design note:
`DESIGN.md`. The app is a client of the contract in `packages/shared/src`; it holds no data of
its own beyond the server address, the pairing token and this session's alerts.

## Pair the phone (what the owner does)

1. On the Mac, with the Workplace running on the LAN (`--host <LAN ip>`; loopback is the default
   and unreachable from the phone), ask it for a one-time code **from the Mac itself**:

       curl -s -X POST http://127.0.0.1:4317/api/pair

   It prints `{ "code": "123456", "expiresAt": ... }`. The code works once and for five minutes.
2. Open **Iris Workplace** on the phone. Enter the Mac's address as the server printed it at
   start (for example `172.20.10.14:4317`) and the six-digit code, then **Pair this phone**.
3. The app exchanges the code for a token, keeps it in the Keychain, and opens the Office.
   Settings (gear on the Office) shows the connection state and has **Re-pair** for a new code.

The phone and the Mac must be on the same network. Over Tailscale (not installed yet) use the
Mac's tailnet address the same way; see the ATS note in `DESIGN.md`.

## Build and run

Everything is driven by `make` (XcodeGen generates the project; the `.xcodeproj` is not committed):

    make gen        # regenerate IrisWorkplace.xcodeproj from project.yml
    make test       # contract check (TS vs Swift) + unit tests on the simulator
    make mock       # the dependency-free mock Workplace on 0.0.0.0:4399 (code 482913)
    make uitest     # XCUITest flows against the mock (needs `make mock` running)
    make shots      # screenshot every screen on the simulator against the mock
    make device     # development build, install and launch on the owner's iPhone

`xcode-select` points at CommandLineTools on this Mac, so the Makefile exports
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. Signing is automatic with team
`M9YV87TCT9`, bundle id `com.irisforu.workplace`.

Debug builds accept launch environment variables for scripted runs: `WORKPLACE_URL`,
`WORKPLACE_TOKEN` (skip pairing), `WORKPLACE_TAB`, `WORKPLACE_INBOX_ITEM`, `WORKPLACE_TALK`,
`WORKPLACE_FEATURE`, `WORKPLACE_PIVOT`, `WORKPLACE_SETTINGS`, `WORKPLACE_NO_NOTIF_PROMPT`.

## Tests

- `IrisWorkplaceTests`: contract decoding from fixtures (`fixtures/*.json`, generated from
  `mock/data.mjs` by `make fixtures`), API paths, REST client (URLProtocol stub), socket client
  (fake transport: backoff, reconnect, ping failure), stores fed with socket events, the app
  model (pairing, 401, unpair), and an integration test over real sockets against the mock
  (skipped when the mock is not running).
- `scripts/check-contract.mjs`: compares the TypeScript unions, interfaces, `WORKPLACE_API`
  keys and socket types with the Swift side; a renamed or added field fails `make test`.
- `IrisWorkplaceUITests`: danger confirm, needsNote prompt, inline approval and streamed reply,
  card → Talk → profile → charter, alert banner → Inbox item, pairing refusal. Two more run only
  with `TEST_RUNNER_REAL_URL` + `TEST_RUNNER_REAL_PAIR_CODE` (pair with the real server) and
  `TEST_RUNNER_REAL_TALK=<employee>` (one real talk).

## Not built yet

- APNs push: alerts reach the phone only while the app is open or was just backgrounded
  (local notifications while iOS keeps the socket alive). Real push needs a server-side APNs
  sender and a device-token registration route in the contract.
- Tailscale: the app parses tailnet addresses, but ATS only allows plain HTTP to local
  addresses; use `tailscale serve` (HTTPS) or add an `NSExceptionDomains` entry when the tailnet
  exists.
