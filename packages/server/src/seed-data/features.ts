import type { AssignmentState, Evidence } from '@jkj/shared';

/**
 * The first real feature on the board: the phone→Mac errand flow. It crosses
 * errands (experts), the cloud agent (server), Android and iOS (mobile), the
 * desktop and the voice confirmation (conversation). The statuses below are
 * Iris's real state on 27 Sep 2026 from the checklist, the Road doc and the
 * experts docs; nothing here is verified by the Workplace itself yet.
 */

export const SEED_FEATURE = {
  key: 'phone-mac-errand-flow',
  title: 'Phone→Mac errand flow',
  body:
    'The owner states an errand on the phone ("tidy my Chrome tabs", "make me a doc about X"); it runs on the Mac ' +
    'through the cloud agent when the Mac is awake, is queued durably when it is not, and the result comes back to ' +
    'the phone, with one spoken sentence on the Mac when it lands. Machine-bound tasks run on the Mac; portable ' +
    'tasks (documents, answers) run in iris-api with the laptop shut. Road doc move 2: every task carries a locality.',
  spec: [
    'AC1. An errand typed on the iPhone or Android app appears as a Mac task within 5 s while the Mac is awake (GET /v1/errands/next long-poll).',
    'AC2. A machine-bound errand stated while the Mac is asleep is queued durably and runs when the Mac wakes; the phone shows "queued" then the result.',
    'AC3. A portable errand (document, answer) completes in iris-api with the Mac shut and the result shows on the phone.',
    'AC4. The Mac reports the result honestly: "Done" only after the expert verified it (dispatch_policy.result_line); a failure is admitted on the phone.',
    'AC5. When a result lands and the owner is at the Mac, Iris says one sentence (Speaker delivery gate), never a stale "Done".',
    'AC6. The iPhone app has the errand composer and the result view; the Android app keeps parity.',
    'AC7. Evidence: agent-svc tests for phone.py and the task registry, iris-api tests for /v1/errands*, one live run phone→Mac→phone recorded with timestamps.',
  ].join('\n'),
  requirementTitles: ['She hops between devices', 'Set here, rings there', 'Account sync', 'One place at a time'],
  platformIds: ['ios', 'android', 'mac', 'server'],
  paths: ['iris:services/agent-svc/phone.py', 'iris:services/cloud-agent/worker.py', 'iris-mobile:mobile/ios', 'iris-mobile:mobile/android'],
  /** Real state per charter on 27 Sep, with the evidence that exists. */
  statuses: {
    experts: {
      state: 'review' as AssignmentState,
      plan: 'Mac side exists: phone.py long-polls /v1/errands/next, runs the expert through the task registry, posts status. Verify against the real router and the honesty guard; add locality to the catalogue.',
      evidence: { tests: { passed: 0, failed: 0, command: 'cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests' }, commits: [], liveVerified: [], notVerified: ['phone→Mac→phone round trip with timestamps', 'queued-while-asleep path'], notes: 'Per "Iris Against Its Definition" §7.6 (27 Sep): "Phone errands run on the Mac; Mac turns mirror into the phone chat" is Partial. Test counts not yet re-run by the Workplace.' } as Evidence,
    },
    server: {
      state: 'review' as AssignmentState,
      plan: 'iris-api relay (/v1/errands*, relay.py) and the cloud agent worker exist; task locality and durable queueing for the asleep Mac are missing (Road move 2).',
      evidence: { tests: { passed: 0, failed: 0, command: 'cd services/iris-api && ../../.venv/bin/python -m pytest -q test_relay.py' }, commits: [], liveVerified: [], notVerified: ['durable queue while the Mac sleeps', 'portable tasks with the Mac shut'], notes: 'relay.py and test_relay.py exist on feat/iris-character; not deployed from ~/claude-dev-deploy since 22 Sep.' } as Evidence,
    },
    mobile: {
      state: 'building' as AssignmentState,
      plan: 'Android chat app has the Mac link (phone→Mac errands); the iOS app exists on feat/mobile but the definition counted "no iPhone app" on 25 Sep. Build the errand composer and result view on iOS; keep Android parity.',
    },
    'desktop-mac': {
      state: 'planned' as AssignmentState,
      plan: 'Make sure phone.py and its long-poll ship inside the PyInstaller agent bundle (iris-agent.spec) and survive the app being asleep/awake; no release until the owner approves.',
    },
    conversation: {
      state: 'proposed' as AssignmentState,
    },
  } as Record<string, { state: AssignmentState; plan?: string; evidence?: Evidence }>,
};
