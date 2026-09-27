/**
 * The Iris Feature Checklist as it stood on 27 Sep 2026 (evening), from the
 * owner's "Iris Against Its Definition" page: 110 features in 15 groups,
 * 52 built / 16 partial / 42 missing, checked against feat/iris-character.
 *
 * This is data, transcribed once. Re-imports match items by (group, title),
 * so a renamed item is a new one; keep titles as the checklist has them.
 * `verified` marks the four features the page says were tried live that day.
 */

export type ChecklistStatus = 'built' | 'partial' | 'missing' | 'verified';

export interface ChecklistItem {
  group: string;
  title: string;
  status: ChecklistStatus;
  note?: string;
  segments?: string[];
}

const S = {
  students: 'US students',
  pros: 'US early-career pros',
  creators: 'Creators and freelancers',
  india: 'India campus and tech workers',
  access: 'Accessibility mode',
};

export const CHECKLIST_DATE = '2026-09-27';

export const CHECKLIST: ChecklistItem[] = [
  // Expressions 9/9
  { group: 'Expressions', title: 'Happy (resting face)', status: 'built' },
  { group: 'Expressions', title: 'Excited when you come back', status: 'built', note: 'after a real absence, 15 min+' },
  { group: 'Expressions', title: 'Sleepy / bored', status: 'built', note: 'idle or muted, leads into the nap' },
  { group: 'Expressions', title: 'Surprised', status: 'built' },
  { group: 'Expressions', title: 'Confused', status: 'built', note: 'fires on failure' },
  { group: 'Expressions', title: 'Shy / blush', status: 'built', note: 'head pat or praise' },
  { group: 'Expressions', title: 'Empathy-sad', status: 'built', note: 'your bad news, not her failure' },
  { group: 'Expressions', title: 'Grumpy huff', status: 'built', note: 'tail tug only, 2 s' },
  { group: 'Expressions', title: 'Dizzy', status: 'built', note: 'shake her' },
  // Movement 4/10
  { group: 'Movement', title: 'Blink', status: 'built' },
  { group: 'Movement', title: 'Rare micro-idle', status: 'built' },
  { group: 'Movement', title: 'Jump', status: 'built' },
  { group: 'Movement', title: 'Fall and land', status: 'built' },
  { group: 'Movement', title: 'Random walk', status: 'partial', note: "walks; doesn't avoid the cursor or stop while you type" },
  { group: 'Movement', title: 'Yawn and stretch', status: 'partial', note: 'on unmute; night wake needs the doze' },
  { group: 'Movement', title: 'Dance', status: 'partial', note: 'when music starts; not on good news' },
  { group: 'Movement', title: 'Peek-hide', status: 'partial', note: 'animation only; no edge-hide or click-to-return' },
  { group: 'Movement', title: 'Weather props', status: 'partial', note: 'umbrella when it rains; no cap or shiver' },
  { group: 'Movement', title: 'Late-night doze', status: 'missing' },
  // Touch 5/7
  { group: 'Touch', title: 'Belly poke', status: 'built' },
  { group: 'Touch', title: 'Head pat', status: 'built', note: 'a click, not a stroke' },
  { group: 'Touch', title: 'Tail tug', status: 'built' },
  { group: 'Touch', title: 'Hold and shake', status: 'built' },
  { group: 'Touch', title: 'Drag her anywhere', status: 'built', note: 'position persists' },
  { group: 'Touch', title: 'Drop a file on her', status: 'partial', note: 'held; no badge on her, no drag back out', segments: [S.creators] },
  { group: 'Touch', title: 'Poke to wake', status: 'missing', note: 'needs the doze' },
  // Voice 5/7
  { group: 'Voice', title: 'One joyful voice', status: 'built' },
  { group: 'Voice', title: 'Giggles and reaction sounds', status: 'built' },
  { group: 'Voice', title: 'Wake word', status: 'built', note: 'on by default, not opt-in; now tolerant of common mishears', segments: [S.access] },
  { group: 'Voice', title: 'Global mute', status: 'built' },
  { group: 'Voice', title: 'No voice replies in chat', status: 'built' },
  { group: 'Voice', title: 'Push-to-talk as the default', status: 'partial', note: 'exists; not the default' },
  { group: 'Voice', title: 'Speaks only three things', status: 'missing', note: 'she speaks every reply (now one breath, rest on screen)' },
  // Personality 4/6
  { group: 'Personality', title: 'Warm, playful tone', status: 'built' },
  { group: 'Personality', title: 'Text chat panel', status: 'built' },
  { group: 'Personality', title: 'Admits mistakes plainly', status: 'built' },
  { group: 'Personality', title: 'Honest about being an AI', status: 'built', note: 'when asked' },
  { group: 'Personality', title: 'Daily greeting, weather-aware', status: 'missing', note: 'weather exists; once-a-day greeting does not' },
  { group: 'Personality', title: 'Adapts tone and timing', status: 'missing', note: 'feedback is now recorded for memory; nothing adapts from it yet' },
  // Context reactions 3/7
  { group: 'Context reactions', title: 'Weather', status: 'built', note: 'drives the umbrella' },
  { group: 'Context reactions', title: 'Music → dance', status: 'built' },
  { group: 'Context reactions', title: 'Idle → nap', status: 'built' },
  { group: 'Context reactions', title: 'Time of day', status: 'partial', note: 'energy follows the clock; no morning/night behaviour' },
  { group: 'Context reactions', title: 'Low battery', status: 'partial', note: 'saves work; no tired look or line' },
  { group: 'Context reactions', title: 'Meetings and screen share', status: 'missing', segments: [S.pros] },
  { group: 'Context reactions', title: 'You type fast → she stays still', status: 'missing' },
  // System actions 6/13
  { group: 'System actions', title: 'Open apps', status: 'built' },
  { group: 'System actions', title: 'Volume and brightness', status: 'verified', note: 'volume read back after it is set; tried live 27 Sep' },
  { group: 'System actions', title: 'Timers', status: 'verified', note: 'tried live 27 Sep' },
  { group: 'System actions', title: 'Alarms on the Mac', status: 'built' },
  { group: 'System actions', title: 'Media controls', status: 'verified', note: 'music tried live 27 Sep' },
  { group: 'System actions', title: 'Pockets', status: 'built', note: 'several items, survive restart', segments: [S.pros, S.creators] },
  { group: 'System actions', title: 'Quick search', status: 'partial', note: 'questions now answered via the cloud agent with sources; not yet voice-tested' },
  { group: 'System actions', title: 'Clipboard history', status: 'missing', note: 'read / set / clear exist; no history', segments: [S.creators, S.india] },
  { group: 'System actions', title: 'Find files by description', status: 'missing', segments: [S.creators] },
  { group: 'System actions', title: 'Screenshots to pocket', status: 'missing', segments: [S.creators] },
  { group: 'System actions', title: 'Do not disturb', status: 'missing' },
  { group: 'System actions', title: 'Wi-Fi and Bluetooth', status: 'missing' },
  { group: 'System actions', title: 'Catch last download', status: 'missing', segments: [S.pros] },
  // Communication 3/7
  { group: 'Communication', title: 'Message drafts, you tap send', status: 'built', note: 'WhatsApp, staged and confirmed; not iMessage or Slack', segments: [S.pros, S.india] },
  { group: 'Communication', title: 'Email drafts', status: 'verified', note: 'opens a draft in Mail, never sends; tried live 27 Sep', segments: [S.pros, S.india] },
  { group: 'Communication', title: 'Calendar', status: 'built', note: 'agenda, next event, free/busy; create, move, cancel ask first. Unit-tested, not yet tried live', segments: [S.students, S.pros] },
  { group: 'Communication', title: 'Share schedule', status: 'missing' },
  { group: 'Communication', title: 'Notification summary', status: 'missing' },
  { group: 'Communication', title: "Message a friend's Iris", status: 'missing', segments: [S.students, S.india] },
  { group: 'Communication', title: 'Announcing a message', status: 'missing' },
  // Productivity 1/7
  { group: 'Productivity', title: 'Reminders, one follow-up', status: 'built', segments: [S.students, S.india] },
  { group: 'Productivity', title: 'To-dos', status: 'missing' },
  { group: 'Productivity', title: 'Daily brief', status: 'missing', segments: [S.pros] },
  { group: 'Productivity', title: 'Focus timer', status: 'missing', segments: [S.students, S.india] },
  { group: 'Productivity', title: 'Study breaks', status: 'missing', segments: [S.students] },
  { group: 'Productivity', title: 'Deadline tracking', status: 'missing', segments: [S.students] },
  { group: 'Productivity', title: 'Wake-up alarm on the phone', status: 'missing', segments: [S.students, S.india] },
  // Memory 3/7
  { group: 'Memory', title: 'Remembers preferences', status: 'built', note: 'now also learned from ordinary talk, with a confidence; guesses are hedged' },
  { group: 'Memory', title: 'Remembers people', status: 'built' },
  { group: 'Memory', title: 'Remembers past chats', status: 'built', note: 'session summaries (episodes)' },
  { group: 'Memory', title: 'Evolves over time', status: 'partial', note: 'beliefs form and update after each session and nightly; tried live 27 Sep. Server side not deployed' },
  { group: 'Memory', title: 'Bond level', status: 'missing' },
  { group: 'Memory', title: 'Milestones', status: 'missing' },
  { group: 'Memory', title: 'Portable memory', status: 'missing', note: 'one account memory for Mac and phone; no export yet' },
  // Looks 1/4
  { group: 'Looks', title: 'One character', status: 'built' },
  { group: 'Looks', title: 'Her home spot', status: 'partial', note: "exists; you can't choose it" },
  { group: 'Looks', title: 'A few hats', status: 'missing', segments: [S.creators] },
  { group: 'Looks', title: 'More characters later', status: 'missing', note: 'planned for later anyway' },
  // Cross-device 0/7
  { group: 'Cross-device', title: 'Account sync', status: 'partial', note: 'chat, files and now memory follow the account (memory not deployed yet)' },
  { group: 'Cross-device', title: 'She hops between devices', status: 'missing' },
  { group: 'Cross-device', title: 'Phone widget', status: 'missing' },
  { group: 'Cross-device', title: 'Live Activities', status: 'missing' },
  { group: 'Cross-device', title: 'Android floating bubble', status: 'missing', note: 'Android app is a chat, not a floating Iris' },
  { group: 'Cross-device', title: 'Set here, rings there', status: 'missing' },
  { group: 'Cross-device', title: 'One place at a time', status: 'missing' },
  // Social 0/3
  { group: 'Social', title: 'Iris Park', status: 'missing', note: 'parked by decision' },
  { group: 'Social', title: "Friends' Irises gather", status: 'missing', note: 'parked' },
  { group: 'Social', title: 'Studying together', status: 'missing', note: 'idea', segments: [S.students] },
  // Privacy and safety 5/9
  { group: 'Privacy and safety', title: 'Permission ladder', status: 'built' },
  { group: 'Privacy and safety', title: 'Permissions dashboard', status: 'built' },
  { group: 'Privacy and safety', title: 'Hide hotkey', status: 'built' },
  { group: 'Privacy and safety', title: 'Mic indicator', status: 'built' },
  { group: 'Privacy and safety', title: 'Crisis handoff', status: 'built' },
  { group: 'Privacy and safety', title: 'AI disclosure', status: 'partial', note: 'said when asked; not at first run or in settings' },
  { group: 'Privacy and safety', title: 'View and delete memory', status: 'partial', note: "server supports item-by-item delete; the screens don't yet. Raw screen text is no longer stored" },
  { group: 'Privacy and safety', title: 'Auto-hide on screen share', status: 'missing', note: 'the document calls it non-negotiable', segments: [S.pros, S.india] },
  { group: 'Privacy and safety', title: '18+ at launch', status: 'missing', note: 'no age confirmation in sign-in or onboarding' },
  // Promises 3/7
  { group: 'Promises', title: 'Never guilt', status: 'built' },
  { group: 'Promises', title: 'Never auto-send', status: 'built', note: 'WhatsApp staged-send with confirm; email only drafts' },
  { group: 'Promises', title: 'One reminder, one follow-up', status: 'built' },
  { group: 'Promises', title: 'Listening is visible', status: 'partial', note: 'indicator yes; push-to-talk not default' },
  { group: 'Promises', title: 'Read only when asked', status: 'missing', note: 'she watches the screen continuously' },
  { group: 'Promises', title: 'Invisible when it matters', status: 'missing', note: 'no screen-share or typing detection' },
  { group: 'Promises', title: 'Friend messages stay short', status: 'missing', note: 'needs the friend network' },
];

/** The decisions the definition leaves open, filed to the owner's Inbox on first boot. */
export const OPEN_DECISIONS: { key: string; title: string; body: string; options: { id: string; label: string }[] }[] = [
  {
    key: 'D1-quiet-by-default',
    title: 'Quiet by default?',
    body: 'The definition says she speaks three things: the daily greeting, a friend\'s message, an alarm. Today she speaks every reply (capped at one breath). Recommendation from "Closing the Iris Gaps": Quiet default; Talk mode and Hands-free one switch away.',
    options: [{ id: 'quiet', label: 'Quiet by default' }, { id: 'talk', label: 'Keep speaking every reply' }, { id: 'later', label: 'Decide later' }],
  },
  {
    key: 'D2-push-to-talk',
    title: 'Push-to-talk as the default?',
    body: 'The definition: push-to-talk by hotkey or click; wake word opt-in and off. Today the wake word is always on. Recommendation: push-to-talk default, wake word moves into Hands-free mode.',
    options: [{ id: 'ptt', label: 'Push-to-talk default' }, { id: 'wake', label: 'Keep wake word on' }, { id: 'later', label: 'Decide later' }],
  },
  {
    key: 'D3-read-only-when-asked',
    title: 'What does "read only when asked" mean?',
    body: 'Recommendation: split sensors into metadata (which app, how long; always on) and content (screen text, clipboard; on request or explicit opt-in). Proactive lines would ground on app and dwell only.',
    options: [{ id: 'split', label: 'Metadata always, content on request' }, { id: 'keep', label: 'Keep continuous screen reading' }, { id: 'later', label: 'Decide later' }],
  },
  {
    key: 'D4-plans',
    title: 'Adopt Free / Pro $6.99 (₹199) / Power $14.99 (₹599)?',
    body: 'Today: six daily-cap plans from $5 to $200. The definition: three tiers with India prices. Existing testers would map to the nearest new plan; caps stay as the cost guard inside each plan.',
    options: [{ id: 'adopt', label: 'Adopt the three tiers' }, { id: 'keep', label: 'Keep cap plans for now' }, { id: 'later', label: 'Decide later' }],
  },
  {
    key: 'D5-which-phone',
    title: 'Which phone first: iPhone or Android?',
    body: 'The definition puts iPhone in Phase 1 with the Mac (US students). Android exists today as a chat app. The Road doc: iPhone first, Android continues for the India beta.',
    options: [{ id: 'iphone', label: 'iPhone first' }, { id: 'android', label: 'Android first' }, { id: 'both', label: 'Both in parallel' }],
  },
  {
    key: 'D6-friend-network',
    title: 'When does the friend network start?',
    body: 'Recommendation: after the 18+ gate and the account data layer, with rate limits, block and report from day one. Iris Park stays parked until the core is proven.',
    options: [{ id: 'after-gate', label: 'After 18+ gate and account layer' }, { id: 'now', label: 'Start now' }, { id: 'park', label: 'Keep parked' }],
  },
  {
    key: 'D7-voice-or-visual',
    title: 'Is Iris a voice companion, or a visual one with voice as a mode?',
    body: 'The Road doc calls this the largest decision. The definition assumes a visual familiar with voice as a mode; the build is voice-first. It gates Phase 0 and most of the serving-cost fix (speech is about 87% of a turn\'s cost).',
    options: [{ id: 'visual', label: 'Visual, voice as a mode' }, { id: 'voice', label: 'Voice companion' }, { id: 'later', label: 'Decide later' }],
  },
  {
    key: 'D8-transcripts',
    title: 'Beta transcript privacy',
    body: 'Verbatim transcripts near a home microphone go to the server and CloudWatch. Redaction mode exists and is off. Testers should be told either way.',
    options: [{ id: 'redact', label: 'Turn redaction on, tell testers' }, { id: 'keep', label: 'Keep verbatim, tell testers' }, { id: 'later', label: 'Decide later' }],
  },
];
