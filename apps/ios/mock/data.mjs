// The mock Workplace: an organisation shaped like the HLD §3 seed, with work, inbox items,
// features and sessions. It feeds the unit-test fixtures (scripts/write-fixtures.mjs) and the
// mock server (mock/server.mjs). Test and preview data only; never shipped in the app.

const T0 = '2026-09-27T09:00:00.000Z';
const iso = (minutesAfter) => new Date(Date.parse(T0) + minutesAfter * 60_000).toISOString();

export const units = [
  { id: 'product', title: 'Product', parentId: null, kind: 'unit' },
  { id: 'capabilities', title: 'Capabilities', parentId: null, kind: 'unit', budget: { inrPerDay: 500 } },
  { id: 'platforms', title: 'Platforms', parentId: null, kind: 'unit', budget: { inrPerDay: 300 } },
  { id: 'quality', title: 'Quality', parentId: null, kind: 'unit' },
  { id: 'platforms-chapter', title: 'Platforms chapter', parentId: 'platforms', kind: 'chapter' },
];

export const roles = [
  { id: 'chief-of-staff', title: 'Chief of Staff', level: 0, instructions: 'Turn a stated feature into a spec with acceptance criteria; route through the map; raise real decisions only.', tools: { disallowed: ['hire'] }, permissionMode: 'plan', model: 'opus', budgetClass: 'high' },
  { id: 'lead', title: 'Lead', level: 1, instructions: 'Own the charter. Plan first, build with evidence, merge hires\' PRs.', tools: {}, permissionMode: 'acceptEdits', model: 'sonnet', budgetClass: 'medium' },
  { id: 'qa', title: 'QA', level: 1, instructions: 'Verify claims. Send back anything without evidence.', tools: { disallowed: ['hire'] }, permissionMode: 'ask', model: 'sonnet', budgetClass: 'medium' },
  { id: 'contractor', title: 'Contractor', level: 2, instructions: 'One task, one branch, no memory.', tools: { disallowed: ['hire', 'propose_org_change'] }, permissionMode: 'acceptEdits', model: 'sonnet', budgetClass: 'low' },
];

const charterDefs = [
  ['chief-of-staff', 'Chief of Staff', 'function', 'Keep the organisation coherent: specs, routing, org proposals, the owner\'s decisions.', ['asha']],
  ['product-and-business', 'Product and business', 'segment', 'Pricing, legal and privacy, growth segments and the platform roadmap; decisions go to the owner.', ['asha']],
  ['conversation', 'Conversation', 'capability', 'Voice, STT/TTS, personality and the responsiveness ladder: something visible within 500 ms.', ['dev']],
  ['character', 'Character', 'capability', 'The on-screen character: expressions, movement, moods, lip-sync, quiet by default.', ['dev']],
  ['experts', 'Experts', 'capability', 'Device actions with the no-lie guard: act first, then acknowledge.', ['mira']],
  ['memory', 'Memory', 'capability', 'Account beliefs across devices; L1/L2/L3 memory layers.', ['kabir']],
  ['server', 'Server', 'platform', 'iris-api and the cloud agent; deploy only from the deploy worktree, back up iris.db first.', ['kabir']],
  ['desktop-mac', 'Desktop (Mac)', 'platform', 'The Electron app on Apple Silicon and Intel; release via the notarised script.', ['rohan']],
  ['windows', 'Windows', 'platform', 'The Windows build. A human teammate also develops here: coordinate, never overwrite.', ['rohan']],
  ['mobile', 'Mobile', 'platform', 'iPhone, iPad and Android apps; TestFlight via App Store Connect.', ['tara']],
  ['qa-release', 'QA and release', 'function', 'The different identity on every lead\'s PR; prepares releases the owner approves.', ['nikhil']],
  ['beta-ops', 'Beta ops', 'function', 'Tester digests, alerts and crash reporting.', ['nikhil']],
];

export const charters = charterDefs.map(([id, title, axis, mission, holderIds], i) => ({
  id, title, axis, version: 1 + (i % 3), mission, holderIds, tokens: 900 + i * 120,
}));

export const charterFull = {
  ...charters.find(c => c.id === 'experts'),
  scope: ['Timer and alarm', 'Reminders', 'WhatsApp (staged send, confirm)', 'Music', 'Screen-aware lines', 'Phone→Mac errands (Mac side)'],
  owns: [
    { kind: 'path', key: 'services/agent-svc/experts/' },
    { kind: 'path', key: 'docs/experts/' },
    { kind: 'keyword', key: 'errand' },
    { kind: 'requirement-group', key: 'System actions' },
  ],
  interfaces: { publishes: ['Fn.speaks flag', 'expert result envelope'], consumes: ['STT transcript', 'cloud agent errand'] },
  rules: ['Never fire-and-forget a send.', 'Deterministic actions run, then ack.', 'Optimistic "Done" only for slow work.'],
  definitionOfDone: ['pytest green', 'a live voice run through the shipped binary', 'notVerified listed'],
  buildTestShip: ['services/agent-svc: ../../.venv/bin/python -m pytest -q tests', 'harness/live_turn.py for speech'],
  coordinateWith: ['conversation', 'mobile', 'server'],
  needsOwnerApproval: ['any message to a person', 'deleting user data'],
  body: '# Experts\n\n## Mission\nDevice actions with the no-lie guard.\n\n## Rules\n- Never fire-and-forget a send.\n- Deterministic actions run, then ack.\n\n## Traps\n- AppleScript needs the app running.\n',
  path: '/Users/shravan0001jha/iris-workplace/charters/experts.md',
};

const emp = (id, name, roleId, level, charterIds, unitId, chapterIds, reportsTo, state, extra = {}) => ({
  id, name, roleId, level, permanent: true, charterIds, unitId, chapterIds, reportsTo,
  workspace: { repo: '/Users/shravan0001jha/claude-dev', worktree: `/Users/shravan0001jha/claude-dev-${id}`, branch: `wp/${id}` },
  budget: { inrPerDay: 150, concurrentSessions: 2 },
  githubApp: level === 0 ? 'iris-chief-of-staff' : `iris-${charterIds[0]}-lead`,
  state, ...extra,
});

export const employees = [
  emp('asha', 'Asha', 'chief-of-staff', 0, ['chief-of-staff', 'product-and-business'], 'product', [], null, 'working'),
  emp('dev', 'Dev', 'lead', 1, ['conversation', 'character'], 'capabilities', [], 'asha', 'idle'),
  emp('mira', 'Mira', 'lead', 1, ['experts'], 'capabilities', [], 'asha', 'needs-owner', { stateReason: 'waiting for your approval to run the errand tests' }),
  emp('kabir', 'Kabir', 'lead', 1, ['memory', 'server'], 'capabilities', ['platforms-chapter'], 'asha', 'blocked', { stateReason: 'no Mac socket contract from experts yet' }),
  emp('rohan', 'Rohan', 'lead', 1, ['desktop-mac', 'windows'], 'platforms', [], 'asha', 'working'),
  emp('tara', 'Tara', 'lead', 1, ['mobile'], 'platforms', [], 'asha', 'paused', { stateReason: 'Paused — daily budget reached (₹150). You can still talk to Tara.' }),
  emp('nikhil', 'Nikhil', 'qa', 1, ['qa-release', 'beta-ops'], 'quality', [], 'asha', 'idle', { githubApp: 'iris-qa' }),
];

const agent = (id, name, task, status, startedAt, extra = {}) => ({
  id, projectId: 'claude-dev', name, task, model: 'sonnet', status, workspace: 'worktree',
  cwd: '/Users/shravan0001jha/claude-dev-mira', startedAt, usage: { inputTokens: 18_400, outputTokens: 6_200, costUsd: 0.41 },
  messageCount: 14, permissionMode: 'acceptEdits', alwaysAllowed: ['Read'], driven: true, ...extra,
});

export const agents = {
  asha: agent('s-asha-1', 'asha', 'Spec: phone→Mac errand flow', 'running', iso(-40)),
  mira: agent('s-mira-1', 'mira', 'Errand receiver on the Mac', 'waiting', iso(-25), {
    approval: { id: 'ap-1', tool: 'Bash', input: 'cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests/test_errands.py', reason: 'Runs a command', requestedAt: iso(-1) },
  }),
  rohan: agent('s-rohan-1', 'rohan', 'Desktop errand handler', 'running', iso(-15)),
  kabir: agent('s-kabir-1', 'kabir', 'Errand endpoint on iris-api', 'error', iso(-90), { endedAt: iso(-30) }),
};

const work = (id, kind, title, state, extra = {}) => ({
  id, kind, title, body: extra.body ?? title, state, requirementIds: [], platformIds: [],
  createdAt: iso(-120), updatedAt: iso(-5), history: [{ at: iso(-120), from: null, to: kind === 'feature' ? 'stated' : 'proposed', by: 'owner' }],
  ...extra,
});

export const feature = work('f-errands', 'feature', 'Phone→Mac errands: say it on the phone, it happens on the Mac', 'in-progress', {
  body: 'The owner says "open the deck on my Mac" on the phone. The cloud agent turns it into an errand, the Mac runs it through the experts, and the phone shows an honest result: never "Done" before it happened.',
  requirementIds: ['REQ-CROSS-01', 'REQ-CROSS-03', 'REQ-SYS-07'],
  platformIds: ['ios', 'android', 'mac', 'server'],
  spec: '## Spec\n1. Phone sends the instruction whole.\n2. Cloud agent asks the Mac (ask_mac); a busy Mac is online.\n3. No "Done" without a Mac result.\n\n## Acceptance\n- Round trip under 3 s on LAN.\n- False-done rate 0 over 20 errands.',
  history: [
    { at: iso(-120), from: null, to: 'stated', by: 'owner' },
    { at: iso(-100), from: 'stated', to: 'specced', by: 'asha' },
    { at: iso(-95), from: 'specced', to: 'decomposed', by: 'workplace' },
    { at: iso(-60), from: 'decomposed', to: 'in-progress', by: 'workplace' },
  ],
});

export const features = [
  feature,
  work('f-push', 'feature', 'Push alerts to the phone app (APNs)', 'stated', { platformIds: ['ios'], requirementIds: ['REQ-CROSS-05'] }),
  work('f-share', 'feature', 'Auto-hide on screen share', 'specced', { requirementIds: ['REQ-PRIV-01'], platformIds: ['mac', 'windows'] }),
  work('f-pricing', 'feature', 'Pricing tiers: Free / Pro / Power with India pricing', 'stated', { requirementIds: ['REQ-PRICE-01', 'REQ-PRICE-02'] }),
  work('f-lipsync', 'feature', 'Real lip-sync on the desktop character', 'built', { requirementIds: ['REQ-EXPR-04'], platformIds: ['mac'] }),
  work('f-wake', 'feature', 'Wake word on iPad talk mode', 'released', { platformIds: ['ios'] }),
];

export const assignments = [
  work('a-1', 'assignment', 'Errand receiver on the Mac (experts)', 'building', {
    featureId: 'f-errands', charterId: 'experts', employeeId: 'mira', platformIds: ['mac'], sessionId: 's-mira-1',
    plan: '## Plan\n1. Add an `errand` expert that validates the instruction.\n2. Run it through the existing act-then-ack path.\n3. Tests for a busy Mac.',
  }),
  work('a-2', 'assignment', 'Errand endpoint on iris-api', 'blocked', {
    featureId: 'f-errands', charterId: 'server', employeeId: 'kabir', platformIds: ['server'], sessionId: 's-kabir-1',
    plan: '## Plan\n1. POST /v1/errands.\n2. Persist and relay to the Mac socket.',
    history: [{ at: iso(-60), from: 'planned', to: 'building', by: 'kabir' }, { at: iso(-30), from: 'building', to: 'blocked', by: 'kabir', note: 'Needs the contract for the Mac socket from experts.' }],
    stalledSince: iso(-45),
  }),
  work('a-3', 'assignment', 'Desktop errand handler', 'review', {
    featureId: 'f-errands', charterId: 'desktop-mac', employeeId: 'rohan', platformIds: ['mac'], sessionId: 's-rohan-1',
    plan: '## Plan\n1. Wire the socket message to the expert runner.\n2. Show the result in the pet bubble.',
    evidence: {
      tests: { passed: 212, failed: 0, command: 'npm test' },
      commits: ['8034a09 Phone actions on the Mac: no false Done', 'ce943c7 Core round 9: errand lifecycle'],
      liveVerified: ['20 errands from the iPhone on LAN, 0 false done', 'busy Mac reported online'],
      notVerified: ['Android sender', 'Tailscale path'],
      notes: 'https://github.com/Shravan0001jha/hivemind-prototype/pull/41',
    },
  }),
  work('a-4', 'assignment', 'Errand sender in the iOS and Android apps', 'planned', {
    featureId: 'f-errands', charterId: 'mobile', employeeId: 'tara', platformIds: ['ios', 'android'],
    plan: '## Plan\n1. iOS: send the whole instruction, show the ask_mac state.\n2. Android: same.',
  }),
  work('a-5', 'assignment', 'Errand spoken confirmations', 'done', {
    featureId: 'f-errands', charterId: 'conversation', employeeId: 'dev', platformIds: ['mac'], verifiedBy: 'nikhil',
    evidence: { tests: { passed: 48, failed: 0, command: 'pytest -q tests/test_speaker.py' }, commits: ['46e43c1 Merge core round 9'], liveVerified: ['3 spoken confirmations through the shipped binary'], notVerified: [] },
  }),
];

export const requirements = [
  { id: 'REQ-CROSS-01', group: 'Cross-device', section: '§3 Features', title: 'Say it on the phone, it happens on the Mac', segments: ['tech workers', 'students'], status: 'partial', evidence: ['20 errands live on LAN'], charterId: 'mobile', featureIds: ['f-errands'] },
  { id: 'REQ-CROSS-03', group: 'Cross-device', section: '§3 Features', title: 'A busy Mac still counts as online', segments: ['tech workers'], status: 'built', evidence: ['8034a09'], charterId: 'server', featureIds: ['f-errands'] },
  { id: 'REQ-SYS-07', group: 'System actions', section: '§3 Features', title: 'Never claim an action before it happened', note: 'The no-lie guard.', segments: ['all'], status: 'verified', evidence: ['harness/live_turn.py run 27 Sep'], charterId: 'experts', featureIds: ['f-errands'] },
];

export const coverage = {
  total: 118, owned: 118, planned: 61, built: 52, verified: 9, released: 0,
  byGroup: {
    'Expressions': { total: 9, owned: 9, planned: 6, built: 5, verified: 1, released: 0 },
    'Voice': { total: 11, owned: 11, planned: 8, built: 7, verified: 2, released: 0 },
    'System actions': { total: 14, owned: 14, planned: 9, built: 8, verified: 3, released: 0 },
    'Memory': { total: 8, owned: 8, planned: 5, built: 4, verified: 1, released: 0 },
    'Cross-device': { total: 7, owned: 7, planned: 4, built: 2, verified: 0, released: 0 },
    'Privacy and safety': { total: 9, owned: 9, planned: 2, built: 3, verified: 1, released: 0 },
    'Pricing': { total: 6, owned: 6, planned: 1, built: 0, verified: 0, released: 0 },
  },
  byCharter: {
    'character': { total: 22, owned: 22, planned: 12, built: 11, verified: 2, released: 0 },
    'conversation': { total: 18, owned: 18, planned: 11, built: 9, verified: 2, released: 0 },
    'experts': { total: 24, owned: 24, planned: 14, built: 13, verified: 3, released: 0 },
    'memory': { total: 8, owned: 8, planned: 5, built: 4, verified: 1, released: 0 },
    'mobile': { total: 7, owned: 7, planned: 4, built: 2, verified: 0, released: 0 },
    'product-and-business': { total: 39, owned: 39, planned: 15, built: 13, verified: 1, released: 0 },
  },
};

export const spend = {
  day: '2026-09-27', companyInr: 412.5, capInr: 1000,
  bySource: { 'anthropic-api': 318.0, aws: 62.5, 'third-party': 32.0 },
  byBasis: { metered: 318.0, estimated: 62.5, reported: 32.0 },
  byEmployee: { asha: 96.2, mira: 131.8, rohan: 88.4, kabir: 74.6, dev: 21.5, tara: 0, nikhil: 0 },
  byUnit: { product: 96.2, capabilities: 227.9, platforms: 88.4, quality: 0 },
  paused: ['employee:tara'],
  subscription: {
    turns: 63, inputTokens: 412_000, outputTokens: 88_400, cacheReadTokens: 2_910_000, cacheWriteTokens: 310_000,
    equivalentInr: 1_842.6,
    byEmployee: { asha: { turns: 14, equivalentInr: 412.1 }, mira: { turns: 22, equivalentInr: 611.9 }, rohan: { turns: 15, equivalentInr: 488.3 }, kabir: { turns: 9, equivalentInr: 240.8 }, dev: { turns: 3, equivalentInr: 89.5 } },
    windows: [
      { window: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: iso(180), seenAt: iso(-2) },
      { window: 'seven_day', status: 'allowed_warning', utilization: 0.81, resetsAt: iso(60 * 24 * 3), seenAt: iso(-2) },
      { window: 'seven_day_opus', status: 'allowed', utilization: 0.35, resetsAt: iso(60 * 24 * 3), seenAt: iso(-2) },
    ],
  },
  ownerTalkInr: 18.4,
};

export const spendEntries = [
  { at: iso(-90), employeeId: 'rohan', sessionId: 's-rohan-1', source: 'anthropic-api', basis: 'metered', what: 'llm-gateway test run', inr: 318.0, detail: { usd: 3.61, tokens: 240_000 } },
  { at: iso(-60), employeeId: 'kabir', sessionId: 's-kabir-1', source: 'aws', basis: 'estimated', what: 'AWS actual (unattributed)', inr: 62.5 },
  { at: iso(-30), employeeId: 'nikhil', sessionId: '', source: 'third-party', basis: 'reported', what: 'release-iris.sh 0.2.16 notarisation', inr: 32.0 },
  { at: iso(-10), employeeId: 'dev', sessionId: 's-dev-owner', source: 'subscription', basis: 'estimated', what: 'owner talk', inr: 18.4, tag: 'owner-talk' },
];

const ownerLine = (summary, details) => ({ summary, ...(details ? { details } : {}) });
export const inbox = [
  {
    id: 'ib-1', kind: 'approval', title: 'Approve the Mac release 0.2.16', body: 'Nikhil prepared desktop-mac 0.2.16: the errand handler, the no-false-Done guard and the tab switch fix. Notarisation is ready; the script kills the running Iris and does not relaunch it.',
    summary: 'Nikhil asks you to release Mac 0.2.16 (errand handler, no-false-Done guard).', details: 'Notarisation ready. The script **kills the running Iris** and does not relaunch it.\n\n- 8034a09 Phone actions on the Mac\n- ce943c7 Core round 9\n- 46e43c1 Merge core round 9',
    context: { action: 'release', subject: 'desktop-mac 0.2.16', unreleased: ['8034a09 Phone actions on the Mac', 'ce943c7 Core round 9', '46e43c1 Merge core round 9'], link: 'https://github.com/Shravan0001jha/hivemind-prototype/compare/v0.2.15...feat/iris-character' },
    options: [{ id: 'approve', label: 'Release 0.2.16', danger: true }, { id: 'reject', label: 'Not yet', needsNote: true }],
    state: 'open', raisedBy: 'nikhil', createdAt: iso(-12),
    affects: ['nikhil', 'rohan', 'asha'],
    onApprove: 'Runs scripts/release-iris.sh 0.2.16: notarises, uploads to S3/CloudFront, kills the running Iris.',
    onDeny: 'Nothing ships; Nikhil keeps the build and waits for your note.',
    links: [{ label: 'Compare v0.2.15…feat/iris-character', href: 'https://github.com/Shravan0001jha/hivemind-prototype/compare/v0.2.15...feat/iris-character' }, { label: 'Team Room: release readiness', href: '#/room/rt-release' }],
  },
  {
    id: 'ib-2', kind: 'decision', title: 'Push-to-talk or wake word as the iPad default?', body: 'The definition leaves it open. Dev recommends push-to-talk by default with the wake word opt-in, because the wake word mis-fires in shared rooms.',
    summary: 'Dev asks: push-to-talk or wake word as the iPad default? He recommends push-to-talk.', details: 'The wake word mis-fired in 3 of 20 shared-room sessions; the definition (REQ-VOICE-03) leaves the default open.',
    context: { requirement: 'REQ-VOICE-03', recommendation: 'push-to-talk' },
    options: [{ id: 'ptt', label: 'Push-to-talk default' }, { id: 'wake', label: 'Wake word default' }, { id: 'later', label: 'Decide later', needsNote: true }],
    state: 'open', raisedBy: 'dev', createdAt: iso(-33),
    affects: ['dev', 'asha'],
    onApprove: 'Push-to-talk becomes the default in the conversation charter; the wake word stays opt-in.',
    onDeny: 'The wake word stays the default; Dev files the mis-fire fixes as a feature.',
    links: [{ label: 'Team Room: iPad voice default', href: '#/room/rt-voice' }],
  },
  {
    id: 'ib-3', kind: 'cap', title: 'Tara is at her daily cap (₹150)', body: 'The mobile errand sender is half built. Raise her cap for today, or keep it and she resumes tomorrow.',
    summary: 'Tara hit her ₹150 cap with the mobile errand sender half built. Raise it for today, or keep it.',
    context: { scope: 'employee:tara', spentInr: 150, capInr: 150 },
    options: [{ id: 'raise-today', label: 'Raise for today', needsNote: true }, { id: 'keep', label: 'Keep the cap' }],
    state: 'open', raisedBy: 'workplace', createdAt: iso(-48),
    affects: ['tara', 'asha'],
    onApprove: 'Tara resumes today up to the number you give.',
    onDeny: 'Tara stays paused until tomorrow 00:00 IST.',
  },
  {
    id: 'ib-4', kind: 'org-change', title: 'Split "mobile" into iOS and Android, hire an Android lead', body: 'The mobile queue is at 7 and Android work keeps waiting on iOS. Asha proposes two charters and one hire from the lead template.',
    summary: 'Asha proposes splitting mobile into iOS and Android and hiring an Android lead.', details: 'Queue at 7; Android waits on iOS every time. Two charters replace mobile; 6 map entries move; Arjun hired at ₹150/day.',
    context: { proposalId: 'op-1', kind: 'split', diff: '--- charters/mobile.md\n+++ charters/mobile-ios.md\n+++ charters/mobile-android.md\n map.yaml: 6 entries move to mobile-android' },
    options: [{ id: 'approve', label: 'Approve the split and hire' }, { id: 'reject', label: 'Reject', needsNote: true }],
    state: 'open', raisedBy: 'asha', createdAt: iso(-70),
    affects: ['asha', 'tara'],
    onApprove: 'Two charters replace mobile; Arjun is hired as Android lead with a ₹150/day budget; the map moves 6 entries.',
    onDeny: 'The org stays as it is; Asha records your reason in the proposal.',
    links: [{ label: 'Proposal diff', href: '#/room/rt-split' }],
  },
  {
    id: 'ib-5', kind: 'question', title: 'Kabir: which socket contract for Mac errands?', body: 'The experts charter has not published the Mac socket message shape yet. Kabir is blocked until it exists, or until you say to reuse the existing ask_mac shape.',
    summary: 'Kabir is blocked: reuse ask_mac for Mac errands now, or wait for the experts contract?',
    context: { assignment: 'a-2', blockedOn: 'experts' },
    options: [{ id: 'reuse', label: 'Reuse ask_mac' }, { id: 'wait', label: 'Wait for experts' }],
    state: 'open', raisedBy: 'kabir', createdAt: iso(-29),
    affects: ['kabir', 'mira'],
    onApprove: 'Kabir builds on the ask_mac shape today.',
    onDeny: 'Kabir stays blocked until Mira publishes the socket contract.',
    links: [{ label: 'Team Room: Mac socket contract', href: '#/room/rt-socket' }],
  },
  {
    id: 'ib-6', kind: 'release', title: 'Deploy iris-api with the errand endpoint', body: 'Done and verified; waiting on the Mac contract first.',
    summary: 'Nikhil asked to deploy iris-api with the errand endpoint. Rejected via Telegram.',
    context: { action: 'deploy', subject: 'server-api' },
    options: [{ id: 'approve', label: 'Deploy', danger: true }, { id: 'reject', label: 'Reject', needsNote: true }],
    state: 'answered', answer: { optionId: 'reject', note: 'After the Mac contract lands.', at: iso(-20), via: 'telegram' }, raisedBy: 'nikhil', createdAt: iso(-200),
    affects: ['nikhil', 'kabir'],
    onApprove: 'Deploys iris-api from the deploy worktree after a db backup.',
    onDeny: 'Nothing deploys.',
  },
  {
    id: 'ib-7', kind: 'approval', title: 'Access to the App Store Connect key for TestFlight', body: 'Tara needs the ASC key to upload a TestFlight build.',
    summary: 'Tara asked for the App Store Connect key for TestFlight. Expired.',
    context: { action: 'new-secret', subject: 'asc-key' },
    options: [{ id: 'approve', label: 'Grant' }, { id: 'reject', label: 'Deny' }],
    state: 'expired', raisedBy: 'tara', createdAt: iso(-1500),
    affects: ['tara'],
  },
  {
    id: 'ib-8', kind: 'question', title: 'Superseded: old socket question', body: 'Replaced by ib-5.',
    summary: 'Old socket question, superseded by ib-5.',
    context: {}, options: [{ id: 'ok', label: 'OK' }],
    state: 'answered', answer: { optionId: 'ok', note: 'Superseded by ib-5.', at: iso(-25), via: 'workplace' }, raisedBy: 'kabir', createdAt: iso(-100),
    affects: ['kabir'],
  },
];

const card = (e, currentWork, lastReport, session) => ({
  employee: e,
  charters: charters.filter(c => e.charterIds.includes(c.id)),
  currentWork, lastReport, session,
  spendTodayInr: spend.byEmployee[e.id] ?? 0,
  needsYou: inbox.filter(i => i.state === 'open' && i.raisedBy === e.id).length,
});

const byId = (id) => employees.find(e => e.id === id);
export const cards = [
  card(byId('asha'), feature, 'Spec written for the errand flow; decomposed into 5 assignments across 5 charters.', agents.asha),
  card(byId('dev'), null, 'Spoken confirmations done, verified by Nikhil (48 tests, 3 live).', null),
  card(byId('mira'), assignments[0], 'Errand expert validates instructions; running the test suite needs your approval.', agents.mira),
  card(byId('kabir'), assignments[1], 'Blocked: no Mac socket contract from experts yet.', agents.kabir),
  card(byId('rohan'), assignments[2], 'Desktop handler in review: 212 tests, 20 live errands, 0 false done.', agents.rohan),
  card(byId('tara'), assignments[3], 'Paused at the daily cap with the iOS sender half built.', null),
  card(byId('nikhil'), null, 'Release 0.2.16 prepared and waiting for your approval.', null),
];

export const counts = (cardList = cards, items = inbox) => ({
  working: cardList.filter(c => c.employee.state === 'working').length,
  blocked: cardList.filter(c => c.employee.state === 'blocked').length,
  stalled: assignments.filter(a => a.stalledSince).length,
  needsYou: items.filter(i => i.state === 'open').length,
  total: cardList.length,
});

export const requestStatus = (f, assignmentsList = assignments) => {
  const as = assignmentsList.filter(a => a.featureId === f.id).map(a => ({ id: a.id, title: a.title, employeeId: a.employeeId, charterId: a.charterId, state: a.state, ...(a.stalledSince ? { stalledSince: a.stalledSince } : {}) }));
  const n = (st) => as.filter(a => a.state === st).length;
  const stage = f.state === 'stated' ? 'with-asha' : f.state === 'specced' ? 'specced' : f.state === 'decomposed' ? 'routed' : f.state === 'built' ? 'built' : f.state === 'released' ? 'released' : n('blocked') ? 'blocked' : n('review') && !n('building') ? 'review' : 'building';
  const line = stage === 'with-asha' ? 'Asha is writing the spec' : stage === 'specced' ? 'Spec written; routing through the map' : stage === 'routed' ? `${as.length} assignments waiting to start` : stage === 'built' ? 'Built; waiting for a release' : stage === 'released' ? 'Released' : `${n('building')} building, ${n('review')} in review, ${n('done')} done${n('blocked') ? `, ${n('blocked')} blocked` : ''}`;
  return { stage, line, assignments: as, ...(f.id === 'f-errands' ? { askedAgentId: 's-asha-1' } : {}) };
};

export const office = () => ({
  chiefOfStaff: 'asha',
  units: units.filter(u => u.kind === 'unit').map(unit => ({ unit, employees: cards.filter(c => c.employee.unitId === unit.id) })),
  coverage,
  needsYou: inbox.filter(i => i.state === 'open').length,
  spend,
  lintErrors: 0,
  counts: counts(),
});

export const health = {
  ok: true, name: 'jkj', version: '0.3.0-mock', uptimeSeconds: 4210, claudeHome: '/Users/shravan0001jha/.claude',
  workplace: { dataDir: '/Users/shravan0001jha/iris-workplace', capInr: 1000, day: '2026-09-27', telegram: true, published: 'connected' },
};

export const signals = {
  employees: Object.fromEntries(employees.map(e => [e.id, { throughput7d: 3, rework7d: 1, falseDoneRate7d: 0.1, costPerDoneInr: 62.5 }])),
  charters: { experts: { queue: 2, contextLimitHits7d: 1 }, mobile: { queue: 7, contextLimitHits7d: 3 } },
  blockingPairs: [['server', 'experts']],
  proposalTriggers: [{ code: 'queue', subject: 'mobile', message: 'Queue length 7 > 5' }],
  stalled: [{ sessionId: 's-kabir-1', employeeId: 'kabir', reason: 'idle', since: iso(-30) }],
};

export const employeeDetail = (id) => {
  const e = byId(id);
  if (!e) return null;
  const c = cards.find(c => c.employee.id === id);
  return {
    employee: e,
    charters: c.charters,
    status: `doing: ${c.currentWork ? c.currentWork.title : 'nothing assigned'}\ndone: ${c.lastReport}\nblocked: ${e.state === 'blocked' ? 'yes, see the Inbox' : 'no'}`,
    handoff: 'Next session: continue from the plan; the test command is in the charter.',
    sessions: Object.values(agents).filter(a => a.name === id),
    assignments: assignments.filter(a => a.employeeId === id),
    spendTodayInr: c.spendTodayInr,
    signals: signals.employees[id],
    needsYou: inbox.filter(i => i.state === 'open' && (i.raisedBy === id || i.affects.includes(id))),
  };
};

export const logs = {
  's-mira-1': [
    { id: 'l-1', agentId: 's-mira-1', at: iso(-25), kind: 'user', label: '', text: 'Assignment a-1: Errand receiver on the Mac. Reply with ## Plan first.' },
    { id: 'l-2', agentId: 's-mira-1', at: iso(-24), kind: 'assistant', label: '', text: '## Plan\n1. Add an `errand` expert that validates the instruction.\n2. Run it through the existing act-then-ack path.\n3. Tests for a busy Mac.' },
    { id: 'l-3', agentId: 's-mira-1', at: iso(-20), kind: 'read', label: 'Read', text: 'services/agent-svc/experts/whatsapp.py' },
    { id: 'l-4', agentId: 's-mira-1', at: iso(-18), kind: 'edit', label: 'Edit', text: 'services/agent-svc/experts/errand.py' },
    { id: 'l-5', agentId: 's-mira-1', at: iso(-10), kind: 'search', label: 'Grep', text: 'ask_mac' },
    { id: 'l-6', agentId: 's-mira-1', at: iso(-6), kind: 'assistant', label: '', text: 'The expert is in. Running the errand tests now; this needs your approval because it is a shell command.', summary: 'Expert added; the test run needs your approval.', details: 'The errand expert validates {instruction, source, requestedAt} and runs through the act-then-ack path. Next: pytest on tests/test_errands.py, which is a shell command.' },
    { id: 'l-7', agentId: 's-mira-1', at: iso(-1), kind: 'bash', label: 'Bash', text: 'cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests/test_errands.py' },
  ],
  's-asha-1': [
    { id: 'l-a1', agentId: 's-asha-1', at: iso(-40), kind: 'user', label: '', text: 'Feature f-errands stated. Write the spec.' },
    { id: 'l-a2', agentId: 's-asha-1', at: iso(-38), kind: 'assistant', label: '', text: 'Spec written with two acceptance criteria. Decomposing through the map: experts, server, desktop-mac, mobile, conversation.' },
    { id: 'l-a3', agentId: 's-asha-1', at: iso(-37), kind: 'tool', label: 'write_spec', text: 'f-errands' },
    { id: 'l-a4', agentId: 's-asha-1', at: iso(-36), kind: 'system', label: '', text: 'Decomposed into 5 assignments.' },
  ],
  's-rohan-1': [
    { id: 'l-r1', agentId: 's-rohan-1', at: iso(-15), kind: 'user', label: '', text: 'Assignment a-3.' },
    { id: 'l-r2', agentId: 's-rohan-1', at: iso(-14), kind: 'assistant', label: '', text: '## Plan\n1. Wire the socket message to the expert runner.' },
    { id: 'l-r3', agentId: 's-rohan-1', at: iso(-8), kind: 'bash', label: 'Bash', text: 'npm test' },
    { id: 'l-r4', agentId: 's-rohan-1', at: iso(-3), kind: 'task', label: 'Task', text: 'Verify 20 errands live', subagentId: 's-rohan-1-sub' },
  ],
  's-kabir-1': [
    { id: 'l-k1', agentId: 's-kabir-1', at: iso(-90), kind: 'user', label: '', text: 'Assignment a-2.' },
    { id: 'l-k2', agentId: 's-kabir-1', at: iso(-31), kind: 'error', label: '', text: 'Blocked: the Mac socket message shape is not published by experts.' },
    { id: 'l-k3', agentId: 's-kabir-1', at: iso(-30), kind: 'system', label: '', text: 'Session ended by stall detection (idle 10 min).' },
  ],
};

export const featureBoard = (fs = features, as = assignments) => ({
  features: fs,
  byState: fs.reduce((m, f) => (m[f.state] = (m[f.state] ?? 0) + 1, m), {}),
  status: Object.fromEntries(fs.map(f => [f.id, requestStatus(f, as)])),
});

export const route = {
  primaries: [
    { charterId: 'experts', because: [{ kind: 'keyword', key: 'errand' }, { kind: 'requirement', key: 'REQ-SYS-07' }] },
    { charterId: 'server', because: [{ kind: 'platform', key: 'server' }, { kind: 'requirement', key: 'REQ-CROSS-03' }] },
    { charterId: 'desktop-mac', because: [{ kind: 'platform', key: 'mac' }] },
    { charterId: 'mobile', because: [{ kind: 'platform', key: 'ios' }, { kind: 'platform', key: 'android' }, { kind: 'requirement', key: 'REQ-CROSS-01' }] },
    { charterId: 'conversation', because: [{ kind: 'keyword', key: 'spoken' }] },
  ],
  consulted: ['memory'],
  unresolved: [{ kind: 'path', key: 'mobile/watch/' }],
};

export const featureDetail = (id) => {
  const f = features.find(f => f.id === id);
  if (!f) return null;
  return { feature: f, assignments: assignments.filter(a => a.featureId === id), requirements: requirements.filter(r => f.requirementIds.includes(r.id)), route: id === 'f-errands' ? route : { primaries: [], consulted: [], unresolved: [] }, status: requestStatus(f) };
};

const pivotItem = (a) => ({ id: a.id, title: a.title, employeeId: a.employeeId, state: a.state, href: `#/employee/${a.employeeId}?item=${a.id}`, ...(a.evidence ? { evidence: { tests: `${a.evidence.tests.passed} passed, ${a.evidence.tests.failed} failed`, commits: a.evidence.commits, liveVerified: a.evidence.liveVerified.length, notVerified: a.evidence.notVerified.length } } : {}) });
const cell = (byState, items = []) => ({ total: Object.values(byState).reduce((a, b) => a + b, 0), byState, items: items.map(pivotItem) });
export const pivots = {
  charter: {
    rows: ['experts', 'server', 'desktop-mac', 'mobile', 'conversation', 'character'],
    cols: ['f-errands', 'f-share', 'f-lipsync'],
    cells: {
      experts: { 'f-errands': cell({ building: 1 }, [assignments[0]]) },
      server: { 'f-errands': cell({ blocked: 1 }, [assignments[1]]) },
      'desktop-mac': { 'f-errands': cell({ review: 1 }, [assignments[2]]), 'f-share': cell({ planned: 1 }) },
      mobile: { 'f-errands': cell({ planned: 1 }, [assignments[3]]) },
      conversation: { 'f-errands': cell({ done: 1 }, [assignments[4]]) },
      character: { 'f-lipsync': cell({ done: 2 }) },
    },
  },
  platform: {
    rows: ['mac', 'windows', 'ios', 'android', 'server'],
    cols: ['f-errands', 'f-share', 'f-lipsync'],
    cells: {
      mac: { 'f-errands': cell({ building: 1, review: 1, done: 1 }, [assignments[0], assignments[2], assignments[4]]), 'f-share': cell({ planned: 1 }), 'f-lipsync': cell({ done: 2 }) },
      windows: { 'f-share': cell({ proposed: 1 }) },
      ios: { 'f-errands': cell({ planned: 1 }) },
      android: { 'f-errands': cell({ planned: 1 }) },
      server: { 'f-errands': cell({ blocked: 1 }) },
    },
  },
  team: {
    rows: ['capabilities', 'platforms', 'product', 'quality'],
    cols: ['f-errands', 'f-share', 'f-lipsync'],
    cells: {
      capabilities: { 'f-errands': cell({ building: 1, blocked: 1, done: 1 }, [assignments[0], assignments[1], assignments[4]]), 'f-lipsync': cell({ done: 2 }) },
      platforms: { 'f-errands': cell({ review: 1, planned: 1 }, [assignments[2], assignments[3]]), 'f-share': cell({ planned: 1, proposed: 1 }) },
      product: {},
      quality: {},
    },
  },
};

export const mapEntries = [
  { kind: 'path', key: 'services/agent-svc/experts/', primary: 'experts', contributors: [], consulted: ['conversation'] },
  { kind: 'path', key: 'services/iris-api/', primary: 'server', contributors: ['memory'], consulted: [] },
  { kind: 'platform', key: 'ios', primary: 'mobile', contributors: [], consulted: ['experts'] },
  { kind: 'requirement-group', key: 'Cross-device', primary: 'mobile', contributors: [], consulted: ['experts', 'server'] },
  { kind: 'keyword', key: 'errand', primary: 'experts', contributors: [], consulted: [] },
];

export const lint = [
  { code: 'orphan', severity: 'warn', subject: 'mobile/watch/', message: 'No path entry covers mobile/watch/' },
  { code: 'dead', severity: 'warn', subject: 'desktop/legacy/', message: 'Path does not exist on disk' },
];

const snapshot = () => ({ units: units.slice(0, 4), employees, charters, map: mapEntries });
export const proposal = {
  id: 'op-1', kind: 'split', reason: 'Mobile queue at 7; Android waits on iOS.', proposedBy: 'asha', state: 'pending',
  params: { charterId: 'mobile', into: ['mobile-ios', 'mobile-android'], hire: { roleId: 'lead', charterId: 'mobile-android', name: 'Arjun' } },
  before: snapshot(), after: snapshot(),
  diff: '--- charters/mobile.md\n+++ charters/mobile-ios.md\n+++ charters/mobile-android.md\n',
  inboxId: 'ib-4', createdAt: iso(-70), lint: [],
};

export const org = () => ({
  units, roles, employees, charters, map: mapEntries, lint, proposals: [proposal],
  history: [{ commit: 'a1b2c3d', at: iso(-3000), message: 'Seed the first organisation' }, { commit: 'd4e5f6a', at: iso(-1400), message: 'Charter experts v2: add the errand rules' }],
});

export const releasesReady = () => [
  { shippable: 'desktop-mac', unreleased: ['8034a09 Phone actions on the Mac', 'ce943c7 Core round 9', '46e43c1 Merge core round 9'], open: release, last: { id: 'rel-0', shippable: 'desktop-mac', version: '0.2.15', state: 'done', unreleased: [], inboxId: 'ib-0', createdAt: iso(-3000) } },
  { shippable: 'server-api', unreleased: ['errand endpoint (a-2, blocked)'] },
  { shippable: 'ios', unreleased: [] , last: { id: 'rel-ios-1', shippable: 'ios', version: '0.3.0', state: 'done', unreleased: [], inboxId: 'ib-00', createdAt: iso(-6000) } },
];

export const release = {
  id: 'rel-1', shippable: 'desktop-mac', version: '0.2.16', state: 'proposed',
  unreleased: ['8034a09', 'ce943c7', '46e43c1'], inboxId: 'ib-1', createdAt: iso(-12),
};

export const roomThreads = [
  { id: 'rt-socket', title: 'Mac socket contract for errands', charterIds: ['experts', 'server'], createdBy: 'kabir', createdAt: iso(-120), state: 'open', lastAt: iso(-8), messageCount: 4, participants: ['kabir', 'mira', 'asha'], escalations: ['ib-5'] , headline: 'Blocked on the socket shape; escalated to you as ib-5.' },
  { id: 'rt-release', title: 'Release readiness 0.2.16', charterIds: ['qa-release', 'desktop-mac'], createdBy: 'nikhil', createdAt: iso(-200), state: 'open', lastAt: iso(-14), messageCount: 3, participants: ['nikhil', 'rohan'], escalations: ['ib-1'] , headline: 'Release 0.2.16 waits for your approval (ib-1).' },
  { id: 'rt-voice', title: 'iPad voice default: push-to-talk or wake word', charterIds: ['conversation', 'mobile'], createdBy: 'dev', createdAt: iso(-300), state: 'open', lastAt: iso(-35), messageCount: 5, participants: ['dev', 'tara', 'asha'], escalations: ['ib-2'] , headline: 'Default is your call (ib-2); mis-fire numbers attached.' },
  { id: 'rt-split', title: 'Split mobile into iOS and Android', charterIds: ['mobile', 'chief-of-staff'], createdBy: 'asha', createdAt: iso(-400), state: 'open', lastAt: iso(-70), messageCount: 2, participants: ['asha', 'tara'], escalations: ['ib-4'] , headline: 'Tara agrees; the split waits for you (ib-4).' },
  { id: 'rt-lipsync', title: 'Lip-sync timing on the desktop character', charterIds: ['character'], createdBy: 'dev', createdAt: iso(-3000), state: 'resolved', summary: 'Viseme timing follows the TTS word marks; the 40 ms lead stays. Written into the character charter.', lastAt: iso(-1500), messageCount: 7, participants: ['dev', 'rohan', 'nikhil'], escalations: [] , headline: 'Resolved: word marks plus a 40 ms lead.' },
];

const rm = (id, threadId, minutesAgo, by, text, mentions = []) => ({ id, threadId, at: iso(-minutesAgo), by, owner: by === 'owner', text, mentions });
export const roomMessages = {
  'rt-socket': [
    rm('m-1', 'rt-socket', 120, 'kabir', 'Starting the errand endpoint on iris-api. @mira what shape does the Mac socket message take? I need the field names before I persist anything.', ['mira']),
    rm('m-2', 'rt-socket', 95, 'mira', 'Not published yet. The errand expert validates {instruction, source, requestedAt}; I can publish that as the socket shape today unless the server needs more.\n\nDetails: source is "phone" or "cloud"; requestedAt ISO; instruction whole, never split.', ['kabir']),
    rm('m-3', 'rt-socket', 40, 'asha', 'Escalated to the owner as ib-5: reuse ask_mac now, or wait for the published shape.', []),
    rm('m-4', 'rt-socket', 8, 'workplace', 'Inbox item ib-5 is open and waiting for the owner.', []),
  ],
  'rt-release': [
    rm('m-5', 'rt-release', 200, 'nikhil', 'Preparing desktop-mac 0.2.16. @rohan is the errand handler merged?', ['rohan']),
    rm('m-6', 'rt-release', 150, 'rohan', 'Merged as 8034a09 and ce943c7. 212 tests green; 20 live errands with 0 false done.', []),
    rm('m-7', 'rt-release', 14, 'nikhil', 'Release proposed as ib-1. The script kills the running Iris and does not relaunch it; the owner should know.', []),
  ],
  'rt-voice': [
    rm('m-8', 'rt-voice', 300, 'dev', 'The wake word mis-fires in shared rooms (3 of 20 sessions). Proposing push-to-talk as the iPad default with the wake word opt-in. @tara @asha', ['tara', 'asha']),
    rm('m-9', 'rt-voice', 250, 'tara', 'Fine from the iPad side; the talk button already exists. It changes the first-run copy.', []),
    rm('m-10', 'rt-voice', 120, 'owner', 'What does the definition say about the default?', []),
    rm('m-11', 'rt-voice', 100, 'asha', 'It leaves it open (REQ-VOICE-03). That is why it is your decision: ib-2.', []),
    rm('m-12', 'rt-voice', 35, 'dev', 'Adding the mis-fire numbers to ib-2 so the choice is informed.', []),
  ],
  'rt-split': [
    rm('m-13', 'rt-split', 400, 'asha', 'The mobile queue is at 7 and Android waits on iOS every time. Proposing the split and an Android hire. @tara', ['tara']),
    rm('m-14', 'rt-split', 70, 'tara', 'Agreed. I keep iOS; the Android charter takes the Gradle build, signing and the Play upload.', []),
  ],
  'rt-lipsync': [
    rm('m-15', 'rt-lipsync', 3000, 'dev', 'Lip-sync lags the audio by ~120 ms on the Mac. Options: lead the visemes by 40 ms, or drive them from the TTS word marks.', []),
    rm('m-16', 'rt-lipsync', 1500, 'asha', 'Resolved: word marks plus a 40 ms lead. Written into the character charter (v3).', []),
  ],
};

export const sampleEvents = [
  { type: 'hello', version: '0.3.0-mock', startedAt: T0 },
  { type: 'snapshot', projects: [{ id: 'claude-dev', name: 'claude-dev', path: '/Users/shravan0001jha/claude-dev', branch: 'feat/iris-character', enabledMcpServers: [] }], agents: Object.values(agents), mcp: [{ id: 'travsr', name: 'Travsr', source: 'travsr', transport: 'stdio', health: 'healthy', toolCount: 24 }] },
  { type: 'agent.updated', agent: agents.mira },
  { type: 'agent.removed', agentId: 's-kabir-1' },
  { type: 'agent.log', entry: logs['s-mira-1'][6] },
  { type: 'mcp.updated', server: { id: 'travsr', name: 'Travsr', source: 'travsr', transport: 'stdio', health: 'degraded', toolCount: 24, note: 'slow' } },
  { type: 'activity', event: { id: 'ev-1', at: T0, projectId: 'claude-dev', kind: 'waiting', message: 'Mira is waiting on an approval' } },
  { type: 'error', message: 'Could not read your sessions' },
  { type: 'office.snapshot', office: office() },
  { type: 'office.updated', card: cards[2] },
  { type: 'inbox.updated', item: inbox[0] },
  { type: 'work.updated', item: assignments[0] },
  { type: 'proposal.updated', proposal },
  { type: 'release.updated', release },
  { type: 'release.log', id: 'rel-1', line: 'notarizing Iris.app…' },
  { type: 'spend.updated', summary: spend },
  { type: 'signals.updated', signals },
  { type: 'alert', level: 'needs-you', title: 'Mira needs an approval', body: 'Kabir is blocked: reuse ask_mac for Mac errands now, or wait for the experts contract?', inboxId: 'ib-5' },
  { type: 'room.thread', thread: roomThreads[0] },
  { type: 'room.message', message: roomMessages['rt-socket'][3], thread: roomThreads[0] },
  { type: 'future.event', anything: 1 },
];

export const fixtures = () => ({
  'health.json': health,
  'office.json': office(),
  'org.json': org(),
  'charter.json': charterFull,
  'inbox.json': inbox,
  'employees.json': employees,
  'employee-detail.json': employeeDetail('mira'),
  'agent.json': agents.mira,
  'agent-log.json': logs['s-mira-1'],
  'features.json': featureBoard(),
  'feature-detail.json': featureDetail('f-errands'),
  'pivot-charter.json': pivots.charter,
  'pivot-platform.json': pivots.platform,
  'pivot-team.json': pivots.team,
  'requirements.json': requirements,
  'coverage.json': coverage,
  'spend.json': spend,
  'spend-entries.json': spendEntries,
  'room.json': { threads: roomThreads },
  'room-thread.json': { thread: roomThreads[0], messages: roomMessages['rt-socket'] },
  'signals.json': signals,
  'release.json': release,
  'releases-ready.json': releasesReady(),
  'requests.json': features.slice(0, 3).map(f => ({ feature: f, status: requestStatus(f) })),
  'proposal-detail.json': { proposal, item: inbox.find(i => i.id === 'ib-4') },
  'proposal.json': proposal,
  'route.json': route,
  'events.json': sampleEvents,
  'pair-exchange.json': { token: 'mock-token-0123456789abcdef' },
  'pair.json': { code: '482913', expiresAt: iso(5) },
});
