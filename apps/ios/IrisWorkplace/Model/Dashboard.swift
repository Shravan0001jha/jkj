import Foundation

// The metrics snapshot, contract v1: `GET /api/metrics/snapshot` through the relay with the usual
// bearer. The same JSON drives https://dash.irisforu.com; its shape is `Snapshot` in
// packages/server/src/services/metrics/snapshot.ts and `Product`/`Trends` in products.ts.
//
// The app reads `products`, `trends` and `gaps` only (`features` is the old epic list, `notes` and
// `unknownShare` are for the website). Decoding is lenient so an additive server change never blanks
// the tab: unknown fields are ignored, a health value v1 does not know becomes `.unknown`, a product
// that cannot be read is skipped, and missing optional fields become nil / empty. `products` itself
// is required: a copy without it is not a v1 product snapshot (e.g. a cached pre-product copy) and
// is discarded rather than shown as an empty grid.
// Not part of `packages/shared` (the snapshot is the metrics engine's file), so not in check-contract.

struct DashboardSnapshot: Codable, Equatable {
    var version: Int
    var generatedAt: String
    var products: [DashProduct]
    var trends: DashTrends
    var gaps: DashGaps?

    init(version: Int = 1, generatedAt: String, products: [DashProduct], trends: DashTrends = DashTrends(), gaps: DashGaps? = nil) {
        self.version = version; self.generatedAt = generatedAt; self.products = products
        self.trends = trends; self.gaps = gaps
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        products = try c.decode(Lossy<DashProduct>.self, forKey: .products).items
        trends = (try? c.decodeIfPresent(DashTrends.self, forKey: .trends)) ?? DashTrends()
        gaps = try? c.decodeIfPresent(DashGaps.self, forKey: .gaps)
    }
}

/// A product health (`Feature['health']` in snapshot.ts).
enum DashHealth: String, Codable, CaseIterable, LenientEnum {
    case onTrack = "on-track", atRisk = "at-risk", late, delivered, noDate = "no-date", unknown
}

struct DashProduct: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var health: DashHealth?
    var committedDate: String?
    var forecast: DashForecast?
    var done: Int
    var total: Int
    var startedAt: String?
    var ageDays: Double?
    var epics: [String]
    var weekly: DashWeekly
    var burnup: DashBurnup

    init(id: String, name: String, health: DashHealth?, committedDate: String? = nil, forecast: DashForecast? = nil,
         done: Int, total: Int, startedAt: String? = nil, ageDays: Double? = nil, epics: [String] = [],
         weekly: DashWeekly = DashWeekly(), burnup: DashBurnup = DashBurnup()) {
        self.id = id; self.name = name; self.health = health; self.committedDate = committedDate
        self.forecast = forecast; self.done = done; self.total = total; self.startedAt = startedAt
        self.ageDays = ageDays; self.epics = epics; self.weekly = weekly; self.burnup = burnup
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        health = try c.decodeIfPresent(DashHealth.self, forKey: .health)
        committedDate = try? c.decodeIfPresent(String.self, forKey: .committedDate)
        forecast = try? c.decodeIfPresent(DashForecast.self, forKey: .forecast)
        done = Int((try? c.decodeIfPresent(Double.self, forKey: .done)) ?? 0)
        total = Int((try? c.decodeIfPresent(Double.self, forKey: .total)) ?? 0)
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        ageDays = try? c.decodeIfPresent(Double.self, forKey: .ageDays)
        epics = (try? c.decodeIfPresent([String].self, forKey: .epics)) ?? []
        weekly = (try? c.decodeIfPresent(DashWeekly.self, forKey: .weekly)) ?? DashWeekly()
        burnup = (try? c.decodeIfPresent(DashBurnup.self, forKey: .burnup)) ?? DashBurnup()
    }

    /// done / total for the progress ring, 0...1.
    var progress: Double { total > 0 ? min(1, max(0, Double(done) / Double(total))) : 0 }
}

struct DashForecast: Codable, Equatable {
    var p50: String?
    var p90: String?
}

struct DashWeekly: Codable, Equatable {
    var delivered: [Double]
    var bugs: [Double]

    init(delivered: [Double] = [], bugs: [Double] = []) { self.delivered = delivered; self.bugs = bugs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        delivered = (try? c.decodeIfPresent([Double].self, forKey: .delivered)) ?? []
        bugs = (try? c.decodeIfPresent([Double].self, forKey: .bugs)) ?? []
    }
}

struct DashBurnup: Codable, Equatable {
    var done: [Double]
    var total: [Double]

    init(done: [Double] = [], total: [Double] = []) { self.done = done; self.total = total }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        done = (try? c.decodeIfPresent([Double].self, forKey: .done)) ?? []
        total = (try? c.decodeIfPresent([Double].self, forKey: .total)) ?? []
    }
}

/// `Trends` in products.ts: six weeks, Monday of each week, oldest first.
struct DashTrends: Codable, Equatable {
    var weeks: [String]
    var deliveredByProduct: [String: [Double]]
    var bugsByProduct: [String: [Double]]
    var bugsOpenTotal: [Double]
    var medianHoursToDone: [Double?]
    var waitByCause: [String: [Double]]

    init(weeks: [String] = [], deliveredByProduct: [String: [Double]] = [:], bugsByProduct: [String: [Double]] = [:],
         bugsOpenTotal: [Double] = [], medianHoursToDone: [Double?] = [], waitByCause: [String: [Double]] = [:]) {
        self.weeks = weeks; self.deliveredByProduct = deliveredByProduct; self.bugsByProduct = bugsByProduct
        self.bugsOpenTotal = bugsOpenTotal; self.medianHoursToDone = medianHoursToDone; self.waitByCause = waitByCause
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weeks = (try? c.decodeIfPresent([String].self, forKey: .weeks)) ?? []
        deliveredByProduct = (try? c.decodeIfPresent([String: [Double]].self, forKey: .deliveredByProduct)) ?? [:]
        bugsByProduct = (try? c.decodeIfPresent([String: [Double]].self, forKey: .bugsByProduct)) ?? [:]
        bugsOpenTotal = (try? c.decodeIfPresent([Double].self, forKey: .bugsOpenTotal)) ?? []
        medianHoursToDone = (try? c.decodeIfPresent([Double?].self, forKey: .medianHoursToDone)) ?? []
        waitByCause = (try? c.decodeIfPresent([String: [Double]].self, forKey: .waitByCause)) ?? [:]
    }
}

/// The part of `gaps` the app shows: the review medians.
struct DashGaps: Codable, Equatable {
    var window: String?
    var reviewWait: DashReviewWait?

    init(window: String? = nil, reviewWait: DashReviewWait? = nil) { self.window = window; self.reviewWait = reviewWait }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        window = try? c.decodeIfPresent(String.self, forKey: .window)
        reviewWait = try? c.decodeIfPresent(DashReviewWait.self, forKey: .reviewWait)
    }
}

struct DashReviewWait: Codable, Equatable {
    var approval1Minutes: DashPercentiles?
    var approval2Minutes: DashPercentiles?

    init(approval1Minutes: DashPercentiles? = nil, approval2Minutes: DashPercentiles? = nil) {
        self.approval1Minutes = approval1Minutes; self.approval2Minutes = approval2Minutes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approval1Minutes = try? c.decodeIfPresent(DashPercentiles.self, forKey: .approval1Minutes)
        approval2Minutes = try? c.decodeIfPresent(DashPercentiles.self, forKey: .approval2Minutes)
    }
}

struct DashPercentiles: Codable, Equatable {
    var p50: Double?
    var p90: Double?
}

/// An array that skips the elements it cannot decode instead of failing the whole array.
struct Lossy<Element: Decodable>: Decodable {
    var items: [Element]

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !c.isAtEnd {
            if let e = try? c.decode(Element.self) { out.append(e) } else { _ = try? c.decode(Skip.self) }
        }
        items = out
    }

    private struct Skip: Decodable {}
}

// MARK: - What the tiles and charts show (pure, unit-tested)

/// Rising or falling, week on week.
enum DashDirection: Equatable { case rising, falling, flat }

/// One segment of the Workplace wait stack: a cause (or "Other") in one week.
struct DashWaitSegment: Equatable, Identifiable {
    var week: Int
    var cause: String
    var days: Double
    var id: String { "\(week)-\(cause)" }
}

extension DashboardSnapshot {
    /// Products with health `delivered`, out of all products.
    var productsComplete: (done: Int, total: Int) {
        (products.filter { $0.health == .delivered }.count, products.count)
    }

    /// `trends.deliveredByProduct` summed across products, one value per week in `trends.weeks`.
    var deliveredPerWeek: [Double] {
        let n = max(trends.weeks.count, trends.deliveredByProduct.values.map(\.count).max() ?? 0)
        var sum = Array(repeating: 0.0, count: n)
        for series in trends.deliveredByProduct.values {
            for (i, v) in series.enumerated() where i < n { sum[i] += v }
        }
        return sum
    }

    /// The last week's summed deliveries and the change from the week before (nil with one week).
    var deliveredThisWeek: (value: Double, change: Double?)? {
        let s = deliveredPerWeek
        guard let last = s.last else { return nil }
        return (last, s.count >= 2 ? last - s[s.count - 2] : nil)
    }

    /// Open bugs at the end of the last week, and whether that is up or down on the week before.
    var bugsOpen: (value: Double, direction: DashDirection)? {
        let s = trends.bugsOpenTotal
        guard let last = s.last else { return nil }
        guard s.count >= 2 else { return (last, .flat) }
        let prev = s[s.count - 2]
        return (last, last > prev ? .rising : last < prev ? .falling : .flat)
    }

    /// The four causes with the most waiting over the six weeks, biggest first (ties by name).
    var topWaitCauses: [String] {
        let totals = trends.waitByCause.mapValues { $0.reduce(0, +) }.filter { $0.value > 0 }
        return Array(totals.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(4).map(\.key))
    }

    /// Whether any cause beyond the top four had waiting time ("Other" appears only then).
    var hasOtherWait: Bool {
        let top = Set(topWaitCauses)
        return trends.waitByCause.contains { !top.contains($0.key) && $0.value.contains { $0 > 0 } }
    }

    /// The stack: per week, the top four causes in order, then "Other" (every remaining cause summed).
    var waitStack: [DashWaitSegment] {
        let top = topWaitCauses
        let n = trends.weeks.count
        var out: [DashWaitSegment] = []
        for w in 0..<n {
            for cause in top { out.append(DashWaitSegment(week: w, cause: cause, days: trends.waitByCause[cause]?[safe: w] ?? 0)) }
            if hasOtherWait {
                let other = trends.waitByCause.filter { !top.contains($0.key) }.values.reduce(0) { $0 + ($1[safe: w] ?? 0) }
                out.append(DashWaitSegment(week: w, cause: Self.otherCause, days: other))
            }
        }
        return out
    }

    /// The legend order, matching the colours.
    var waitLegend: [String] { topWaitCauses + (hasOtherWait ? [Self.otherCause] : []) }

    static let otherCause = "Other"

    /// The spec's colours, in this order, for the top four causes and then "Other".
    static let waitColorsHex = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"]

    /// A wait cause (causes.ts `Cause`) in words: "mac-or-device" → "Mac or device".
    static func causeLabel(_ cause: String) -> String {
        switch cause {
        case "paused/pace-hold": return "Paused"
        case "budget-cap": return "Budget cap"
        case "staging-down": return "Staging down"
        case "review": return "Review"
        case "dependency": return "Dependency"
        case "mac-or-device": return "Mac or device"
        case "owner-decision": return "Your decision"
        case "queued-behind-busy": return "Queued"
        case "parked": return "Parked"
        case "unknown": return "Unclassified"
        default:
            let words = cause.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "/", with: " / ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

extension API {
    /// Not in `WORKPLACE_API` (the snapshot lives beside it, HLD-dashboard §2), so kept here.
    static let metricsSnapshot = "/api/metrics/snapshot"
}
