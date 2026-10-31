import Foundation

// The metrics snapshot, contract v1 (docs/HLD-dashboard.md §5): `GET /api/metrics/snapshot`.
// The same JSON drives the web dashboard, so the app decodes it leniently: unknown fields are
// ignored, an enum value v1 does not know becomes `.unknown`, and everything except the ids, names,
// `version` and `generatedAt` may be missing or null without failing the whole snapshot.
// Not part of `packages/shared` (the snapshot is the metrics engine's file), so not in check-contract.

struct DashboardSnapshot: Codable, Equatable {
    var version: Int
    var generatedAt: String
    var features: [DashFeature]
    var gaps: DashGaps?
    var unknownShare: Double?

    init(version: Int, generatedAt: String, features: [DashFeature], gaps: DashGaps?, unknownShare: Double?) {
        self.version = version; self.generatedAt = generatedAt; self.features = features
        self.gaps = gaps; self.unknownShare = unknownShare
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        features = try c.decodeIfPresent([DashFeature].self, forKey: .features) ?? []
        gaps = try c.decodeIfPresent(DashGaps.self, forKey: .gaps)
        unknownShare = try c.decodeIfPresent(Double.self, forKey: .unknownShare)
    }

    /// The app's Gaps section: the three causes that lost the most days in the window.
    var topGaps: [DashLostCause] {
        Array((gaps?.lostDaysByCause ?? []).sorted { $0.days > $1.days }.prefix(3))
    }

    /// A wait cause (§4) in words: "mac-or-device" → "Mac or device".
    static func causeLabel(_ cause: String) -> String {
        switch cause {
        case "paused/pace-hold": return "Paused or pace hold"
        case "budget-cap": return "Budget cap"
        case "staging-down": return "Staging down"
        case "review": return "Review"
        case "dependency": return "Dependency"
        case "mac-or-device": return "Mac or device"
        case "owner-decision": return "Owner decision"
        case "queued-behind-busy": return "Queued behind busy"
        case "parked": return "Parked"
        case "unknown": return "Unknown"
        default:
            let words = cause.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "/", with: " / ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }
}

enum DashFeatureState: String, Codable, CaseIterable, LenientEnum {
    case inProgress = "in-progress", delivered, planned, unknown
}

enum DashHealth: String, Codable, CaseIterable, LenientEnum {
    case onTrack = "on-track", atRisk = "at-risk", late, unknown
}

enum DashScopeStatus: String, Codable, CaseIterable, LenientEnum {
    case notStarted = "not-started", building, merged, staging, verified, unknown
}

struct DashFeature: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var state: DashFeatureState?
    var committedDate: String?
    var forecast: DashForecast?
    var health: DashHealth?
    var healthReason: String?
    var startedAt: String?
    var deliveredAt: String?
    var originalDate: String?
    var scope: [DashScopeItem]
    var dateHistory: [DashDateChange]
    var lostDays: [String: Double]?
    var escapes: Int?
    var costInr: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        state = try c.decodeIfPresent(DashFeatureState.self, forKey: .state)
        committedDate = try c.decodeIfPresent(String.self, forKey: .committedDate)
        forecast = try c.decodeIfPresent(DashForecast.self, forKey: .forecast)
        health = try c.decodeIfPresent(DashHealth.self, forKey: .health)
        healthReason = try c.decodeIfPresent(String.self, forKey: .healthReason)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        deliveredAt = try c.decodeIfPresent(String.self, forKey: .deliveredAt)
        originalDate = try c.decodeIfPresent(String.self, forKey: .originalDate)
        scope = try c.decodeIfPresent([DashScopeItem].self, forKey: .scope) ?? []
        dateHistory = try c.decodeIfPresent([DashDateChange].self, forKey: .dateHistory) ?? []
        lostDays = try c.decodeIfPresent([String: Double].self, forKey: .lostDays)
        escapes = try c.decodeIfPresent(Int.self, forKey: .escapes)
        costInr = try c.decodeIfPresent(Double.self, forKey: .costInr)
    }
}

struct DashForecast: Codable, Equatable {
    var p50: String?
    var p90: String?
}

struct DashScopeItem: Codable, Equatable {
    var label: String
    var status: DashScopeStatus?
    var storyIds: [String]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        status = try c.decodeIfPresent(DashScopeStatus.self, forKey: .status)
        storyIds = try c.decodeIfPresent([String].self, forKey: .storyIds) ?? []
    }
}

struct DashDateChange: Codable, Equatable {
    var from: String?
    var to: String?
    var reason: String?
    var approvedBy: String?
    var at: String?
}

struct DashGaps: Codable, Equatable {
    var window: String?
    var lostDaysByCause: [DashLostCause]
    var idleWhileQueuedHours: Double?
    var reviewWaitHours: DashPercentiles?
    var stagingSlots: DashStagingSlots?
    var forecastAccuracyDays: [DashForecastDelta]
    var ownerDecisionHours: DashPercentiles?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        window = try c.decodeIfPresent(String.self, forKey: .window)
        lostDaysByCause = try c.decodeIfPresent([DashLostCause].self, forKey: .lostDaysByCause) ?? []
        idleWhileQueuedHours = try c.decodeIfPresent(Double.self, forKey: .idleWhileQueuedHours)
        reviewWaitHours = try c.decodeIfPresent(DashPercentiles.self, forKey: .reviewWaitHours)
        stagingSlots = try c.decodeIfPresent(DashStagingSlots.self, forKey: .stagingSlots)
        forecastAccuracyDays = try c.decodeIfPresent([DashForecastDelta].self, forKey: .forecastAccuracyDays) ?? []
        ownerDecisionHours = try c.decodeIfPresent(DashPercentiles.self, forKey: .ownerDecisionHours)
    }
}

struct DashLostCause: Codable, Equatable {
    var cause: String
    var days: Double
    var trend: [Double]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cause = try c.decode(String.self, forKey: .cause)
        days = try c.decodeIfPresent(Double.self, forKey: .days) ?? 0
        trend = try c.decodeIfPresent([Double].self, forKey: .trend) ?? []
    }
}

struct DashPercentiles: Codable, Equatable {
    var p50: Double?
    var p90: Double?
}

struct DashStagingSlots: Codable, Equatable {
    var planned: Int?
    var deployed: Int?
    var misses: [DashStagingMiss]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        planned = try c.decodeIfPresent(Int.self, forKey: .planned)
        deployed = try c.decodeIfPresent(Int.self, forKey: .deployed)
        misses = try c.decodeIfPresent([DashStagingMiss].self, forKey: .misses) ?? []
    }
}

struct DashStagingMiss: Codable, Equatable {
    var at: String?
    var why: String?
}

struct DashForecastDelta: Codable, Equatable {
    var feature: String?
    var delta: Double?
}

extension API {
    /// Not in `WORKPLACE_API` (the snapshot lives beside it, HLD-dashboard §2), so kept here.
    static let metricsSnapshot = "/api/metrics/snapshot"
}
