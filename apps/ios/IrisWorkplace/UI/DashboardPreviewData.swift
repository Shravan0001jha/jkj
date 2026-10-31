import Foundation

#if DEBUG
// SwiftUI previews of the dashboard show exactly the v1 contract fixture
// (fixtures/dashboard-snapshot.json; DashboardTests.testPreviewDataIsTheV1Fixture keeps them equal).
extension DashboardSnapshot {
    static let preview: DashboardSnapshot = {
        // swiftlint:disable:next force_try
        try! JSONDecoder().decode(DashboardSnapshot.self, from: Data(previewJSON.utf8))
    }()

    private static let previewJSON = #"""
{
  "version": 1,
  "generatedAt": "2026-11-01T12:00:00Z",
  "features": [
    {
      "id": "ep_alarms",
      "name": "Alarms & Reminders",
      "state": "in-progress",
      "committedDate": "2026-11-06",
      "forecast": { "p50": "2026-11-06", "p90": "2026-11-08" },
      "health": "at-risk",
      "healthReason": "waiting on Mac build, 1.5 d",
      "startedAt": "2026-10-20T09:00:00Z",
      "deliveredAt": null,
      "originalDate": "2026-10-31",
      "scope": [
        { "label": "Repeating alarms", "status": "merged", "storyIds": ["st_rep1", "st_rep2"] },
        { "label": "Snooze from the lock screen", "status": "building", "storyIds": ["st_snooze"] },
        { "label": "Reminders sync", "status": "verified", "storyIds": ["st_sync"] },
        { "label": "Spoken confirmation", "status": "not-started", "storyIds": [] }
      ],
      "dateHistory": [
        { "from": "2026-10-31", "to": "2026-11-06", "reason": "Mac queue was busy for two days", "approvedBy": "owner", "at": "2026-10-29T16:20:00Z" }
      ],
      "lostDays": { "review": 1.2, "mac-or-device": 1.5 },
      "escapes": 1,
      "costInr": 4120
    },
    {
      "id": "ep_wake",
      "name": "Wake word in every accent",
      "state": "in-progress",
      "committedDate": "2026-11-12",
      "forecast": { "p50": "2026-11-11", "p90": "2026-11-13" },
      "health": "on-track",
      "healthReason": "on plan; 3 of 5 scope items merged",
      "startedAt": "2026-10-25T05:30:00Z",
      "deliveredAt": null,
      "originalDate": "2026-11-12",
      "scope": [
        { "label": "Hindi-English accent model", "status": "staging", "storyIds": ["st_hi"] },
        { "label": "South Indian accents", "status": "merged", "storyIds": ["st_si"] },
        { "label": "False-wake guard", "status": "building", "storyIds": ["st_fw"] }
      ],
      "dateHistory": [],
      "lostDays": { "review": 0.4 },
      "escapes": 0,
      "costInr": 2310
    },
    {
      "id": "ep_store",
      "name": "App Store 1.0",
      "state": "in-progress",
      "committedDate": "2026-10-28",
      "forecast": { "p50": "2026-11-04", "p90": "2026-11-09" },
      "health": "late",
      "healthReason": "past the committed date; App Review pending",
      "startedAt": "2026-10-01T08:00:00Z",
      "deliveredAt": null,
      "originalDate": "2026-10-20",
      "scope": [
        { "label": "Privacy and terms pages", "status": "verified", "storyIds": ["st_priv"] },
        { "label": "Reviewer demo account", "status": "verified", "storyIds": ["st_demo"] },
        { "label": "Store listing", "status": "staging", "storyIds": ["st_list"] }
      ],
      "dateHistory": [
        { "from": "2026-10-20", "to": "2026-10-24", "reason": "Rejected for missing account deletion", "approvedBy": "owner", "at": "2026-10-19T11:00:00Z" },
        { "from": "2026-10-24", "to": "2026-10-28", "reason": "Second review round", "approvedBy": "owner", "at": "2026-10-23T18:45:00Z" }
      ],
      "lostDays": { "owner-decision": 2.1, "review": 3.0, "staging-down": 0.8 },
      "escapes": 2,
      "costInr": 9050
    },
    {
      "id": "ep_pet",
      "name": "Desktop pet",
      "state": "delivered",
      "committedDate": "2026-10-22",
      "forecast": { "p50": "2026-10-21", "p90": "2026-10-21" },
      "health": "on-track",
      "healthReason": "delivered a day early",
      "startedAt": "2026-10-08T07:00:00Z",
      "deliveredAt": "2026-10-21T15:10:00Z",
      "originalDate": "2026-10-22",
      "scope": [
        { "label": "Moods", "status": "verified", "storyIds": ["st_mood"] },
        { "label": "Lip-sync", "status": "verified", "storyIds": ["st_lip"] }
      ],
      "dateHistory": [],
      "lostDays": {},
      "escapes": 0,
      "costInr": 6400
    },
    {
      "id": "ep_multi",
      "name": "Multilingual replies",
      "state": "planned",
      "committedDate": "2026-11-25",
      "forecast": { "p50": "2026-11-26", "p90": "2026-12-02" },
      "health": "on-track",
      "healthReason": "not started; starts after Alarms",
      "startedAt": null,
      "deliveredAt": null,
      "originalDate": "2026-11-25",
      "scope": [
        { "label": "Hindi replies", "status": "not-started", "storyIds": [] }
      ],
      "dateHistory": [],
      "lostDays": {},
      "escapes": 0,
      "costInr": 0
    }
  ],
  "gaps": {
    "window": "30d",
    "lostDaysByCause": [
      { "cause": "queued-behind-busy", "days": 2.4, "trend": [0.3, 0.5, 0.6] },
      { "cause": "review", "days": 6.5, "trend": [0.9, 1.4] },
      { "cause": "unknown", "days": 0.6, "trend": [0.1, 0.2] },
      { "cause": "mac-or-device", "days": 4.1, "trend": [1.0, 0.8, 1.2] },
      { "cause": "owner-decision", "days": 3.3, "trend": [0.5, 1.1] }
    ],
    "idleWhileQueuedHours": 41,
    "reviewWaitHours": { "p50": 3.1, "p90": 12 },
    "stagingSlots": {
      "planned": 10,
      "deployed": 6,
      "misses": [
        { "at": "2026-10-27T06:00:00Z", "why": "stopped" },
        { "at": "2026-10-29T14:00:00Z", "why": "build failed" }
      ]
    },
    "forecastAccuracyDays": [
      { "feature": "Desktop pet", "delta": -1 },
      { "feature": "App Store 1.0", "delta": 6 }
    ],
    "ownerDecisionHours": { "p50": 2, "p90": 20 }
  },
  "unknownShare": 0.04
}
"""#
}
#endif
