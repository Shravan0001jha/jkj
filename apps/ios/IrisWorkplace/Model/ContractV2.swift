import Foundation

// Workplace v2 (LLD §19.8): areas → epics → stories → tasks, comments, activity, the Updates feed,
// threaded Inbox items, area rooms and release posts. Mirrored field for field from
// packages/shared/src/workplace-v2.ts; `scripts/check-contract.mjs` fails when they drift.

// MARK: - Unknown values never fail a screen

/// A string enum that decodes a value it does not know as `.unknown` instead of throwing, so a
/// server that adds a state, kind or level never blanks a screen on an older app. `.unknown` is
/// never sent back: requests only carry values the owner picked from known cases.
protocol LenientEnum: RawRepresentable, CaseIterable, Decodable where RawValue == String {
    static var unknown: Self { get }
}

extension LenientEnum {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }

    /// Every case but `.unknown`: what a picker offers.
    static var known: [Self] { allCases.filter { $0 != .unknown } }
}

// MARK: - Items

enum ItemLevel: String, Codable, CaseIterable, LenientEnum {
    case epic, story, task
    case unknown
}

enum ItemStatus: String, Codable, CaseIterable, LenientEnum {
    case backlog, ready
    case inProgress = "in-progress"
    case inReview = "in-review"
    /// Rework (Oct 2026): waiting on a person (`Item.waiting`), parked on purpose (`Item.parked`).
    case waiting, parked
    case done, blocked
    case unknown

    /// The board's columns, in the state machine's order.
    static let order: [ItemStatus] = [.backlog, .ready, .inProgress, .inReview, .waiting, .parked, .blocked, .done]
    /// New in the October rework: an older server never sends them, so the board only shows
    /// their columns when the server does.
    static let rework: Set<ItemStatus> = [.waiting, .parked]
    var isOpen: Bool { self != .done }
}

/// What the board shows (computed by the server from the status, the hold, the PR and so on).
enum TrueStatus: String, Codable, CaseIterable, LenientEnum {
    case backlog
    case onHold = "on-hold"
    case ready
    case inProgress = "in-progress"
    case inReview = "in-review"
    case waiting, parked, qa, approved, merged, done, blocked
    case unknown

    var label: String {
        switch self {
        case .backlog: return "Backlog"
        case .onHold: return "On hold"
        case .ready: return "Ready"
        case .inProgress: return "In progress"
        case .inReview: return "In review"
        case .waiting: return "Waiting on"
        case .parked: return "Parked"
        case .qa: return "QA"
        case .approved: return "Approved"
        case .merged: return "Merged"
        case .done: return "Done"
        case .blocked: return "Blocked"
        case .unknown: return "Other"
        }
    }
}

/// The Jira type: a bug is a story-level item; an `rca` story is done when its RCA is posted.
enum ItemType: String, Codable, CaseIterable, LenientEnum {
    case epic, story, task, bug, rca
    case unknown
}

enum ItemResolution: String, Codable, CaseIterable, LenientEnum {
    case done
    case wontDo = "wont-do"
    case duplicate
    case unknown
}

/// 1, 2, 3, 5 or 8 (`Item.points` stays an `Int` so an unexpected number still decodes).
enum Points: Int, Codable, CaseIterable {
    case one = 1, two = 2, three = 3, five = 5, eight = 8
}

enum StallRule: String, Codable, CaseIterable, LenientEnum {
    case notStarted = "not-started"
    case idle, unreviewed
    case unknown
}

struct ItemLegacy: Codable, Equatable, Hashable {
    var kind: WorkKind
    var state: String
    var charterId: String?
    var featureId: String?
}

struct ItemBlocked: Codable, Equatable, Hashable {
    var reason: String
    var waitingOn: String
    var since: String
}

/// `waiting`: on an employee id, 'owner' or 'coo'.
struct ItemWaiting: Codable, Equatable, Hashable {
    var on: String
    var reason: String?
    var since: String?
}

/// `parked`: why, and when it should resume.
struct ItemParked: Codable, Equatable, Hashable {
    var reason: String?
    var resumeWhen: String?
    var by: String?
    var since: String?
}

/// The posted RCA (an `rca` story is done once it is here).
struct ItemRca: Codable, Equatable, Hashable {
    var text: String
    var at: String?
    var by: String?
}

struct ItemStall: Codable, Equatable, Hashable {
    var rule: StallRule
    var since: String
    var minutes: Int
}

struct Item: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var level: ItemLevel
    var title: String
    var body: String
    var status: ItemStatus
    var statusSince: String
    var resolution: ItemResolution?
    var parentId: String?
    var epicId: String?
    var areaId: String?
    var assigneeId: String?
    var reviewerId: String?
    var ownerId: String?
    var points: Int?
    var rank: Double
    var targetDate: String?
    var acceptance: [String]
    var blocked: ItemBlocked?
    var stall: ItemStall?
    var mergedInto: String?
    var releasedIn: String?
    var legacy: ItemLegacy
    var createdAt: String
    var updatedAt: String
    // Rework (Oct 2026). All optional: an older server sends none of them.
    var type: ItemType?
    var trueStatus: TrueStatus?
    var waiting: ItemWaiting?
    var parked: ItemParked?
    var docUrl: String?
    var docId: String?
    var rca: ItemRca?
}

// MARK: - Areas and the plan

enum AreaState: String, Codable, CaseIterable, LenientEnum {
    case active, archived
    case unknown
}

struct Area: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var description: String?
    var state: AreaState
    var rank: Double
    var ownerId: String
    var roomId: String
    var threadId: String
    var createdAt: String
    var updatedAt: String
}

struct EpicProgress: Codable, Equatable, Hashable {
    var pointsDone: Int
    var pointsTotal: Int
    var storiesDone: Int
    var storiesTotal: Int
    var pct: Double
}

enum PlanFlagKind: String, Codable, CaseIterable, LenientEnum {
    case blocked, stalled
    case unknown
}

struct PlanFlag: Codable, Equatable, Hashable {
    var kind: PlanFlagKind
    var itemId: String
    var title: String
    var reason: String
    var waitingOn: String?
    var since: String
}

struct EpicNext: Codable, Equatable, Hashable {
    var id: String
    var title: String
}

struct EpicCard: Codable, Equatable, Hashable, Identifiable {
    var epic: Item
    var progress: EpicProgress
    var next: EpicNext?
    var flags: [PlanFlag]
    var inFocus: Bool
    /// Rework: `planTier === 4`. Absent on an older server.
    var finished: Bool?

    var id: String { epic.id }
    /// The server's word when it gives one; otherwise a done epic is finished.
    var isFinished: Bool { finished ?? (epic.status == .done) }
}

struct Focus: Codable, Equatable, Hashable {
    var epicIds: [String]
    var setBy: String
    var at: String
}

struct PlanArea: Codable, Equatable, Hashable, Identifiable {
    var area: Area
    var epics: [EpicCard]

    var id: String { area.id }
}

struct PlanResponse: Codable, Equatable {
    var areas: [PlanArea]
    var unfiled: [EpicCard]
    var mine: [Item]
    var focus: Focus
    /// `Record<ItemStatus, number>`, keyed by the raw status.
    var counts: [String: Int]
    var board: [String: [Item]]?
}

// MARK: - Comments, activity, updates

struct Comment: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var itemId: String
    var at: String
    var by: String
    var text: String
    var details: String?
    var mentions: [String]
}

/// `ActivityKind` in workplace-v2.ts (named apart from protocol.ts's `ActivityEvent.kind`).
enum ItemActivityKind: String, Codable, CaseIterable, LenientEnum {
    case created, status, assigned, reviewer, points, field, comment, commit, test, note, stall, merged, reopen, started
    case unknown
}

struct Activity: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var at: String
    var itemId: String?
    var by: String
    var kind: ItemActivityKind
    var from: String?
    var to: String?
    var text: String
    var link: String?
}

struct ItemDetail: Codable, Equatable {
    var item: Item
    var parent: Item?
    var epic: Item?
    var area: Area?
    var children: [Item]
    var comments: [Comment]
    var activity: [Activity]
    var progress: EpicProgress?
    var threadId: String?
    /// Rework: who did what, with the reason (newest last). Absent on an older server.
    var audit: [AuditEntry]?
    /// Rework: everyone on the story's path to done.
    var chain: StoryChain?
}

enum AuditKind: String, Codable, CaseIterable, LenientEnum {
    case created, assigned, status, reviewer, parked, reopened, doc
    case unknown
}

struct AuditEntry: Codable, Equatable, Hashable {
    var at: String
    var by: String
    var kind: AuditKind
    var from: String?
    var to: String?
    /// Absent = "not recorded" (rows from before reasons were required).
    var reason: String?
}

/// The story's chain of people (LLD rework W1 §7). Only `extraReviewers` is always there.
struct StoryChain: Codable, Equatable, Hashable {
    var developer: String?
    var devReviewer: String?
    var extraReviewers: [String]
    var qa: String?
    var charterId: String?
    var charterTitle: String?
    var lead: String?
    var chiefOfStaff: String?
    var cto: String?

    init(developer: String? = nil, devReviewer: String? = nil, extraReviewers: [String] = [], qa: String? = nil, charterId: String? = nil,
         charterTitle: String? = nil, lead: String? = nil, chiefOfStaff: String? = nil, cto: String? = nil) {
        self.developer = developer; self.devReviewer = devReviewer; self.extraReviewers = extraReviewers; self.qa = qa
        self.charterId = charterId; self.charterTitle = charterTitle; self.lead = lead; self.chiefOfStaff = chiefOfStaff; self.cto = cto
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        developer = try c.decodeIfPresent(String.self, forKey: .developer)
        devReviewer = try c.decodeIfPresent(String.self, forKey: .devReviewer)
        extraReviewers = try c.decodeIfPresent([String].self, forKey: .extraReviewers) ?? []
        qa = try c.decodeIfPresent(String.self, forKey: .qa)
        charterId = try c.decodeIfPresent(String.self, forKey: .charterId)
        charterTitle = try c.decodeIfPresent(String.self, forKey: .charterTitle)
        lead = try c.decodeIfPresent(String.self, forKey: .lead)
        chiefOfStaff = try c.decodeIfPresent(String.self, forKey: .chiefOfStaff)
        cto = try c.decodeIfPresent(String.self, forKey: .cto)
    }
}

enum UpdateKind: String, Codable, CaseIterable, LenientEnum {
    case started, shipped, blocked, unblocked, decided, brief, review
    case unknown
}

struct Update: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var at: String
    var kind: UpdateKind
    var line: String
    var details: String?
    var by: String
    var itemId: String?
    var inboxId: String?
    var href: String
    var push: Bool
}

// MARK: - Inbox threads

struct InboxMessage: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var inboxId: String
    var at: String
    var by: String
    var text: String
    var details: String?
}

struct InboxThread: Codable, Equatable {
    var item: InboxItem
    var messages: [InboxMessage]
}

// MARK: - Rooms

enum RoomKind: String, Codable, CaseIterable, LenientEnum {
    case general, area, releases
    case unknown
}

struct Room: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var kind: RoomKind
    var title: String
    var areaId: String?
    var headline: String
    var lastAt: String
    var threadIds: [String]
}

struct RoomDetail: Codable, Equatable {
    var room: Room
    var threads: [RoomThread]
}

// MARK: - Release posts

enum ReleaseItemKind: String, Codable, CaseIterable, LenientEnum {
    case story, fix
    case unknown
}

struct ReleasePostItem: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var level: ItemLevel
    var kind: ReleaseItemKind
}

struct ReleasePostGroup: Codable, Equatable, Hashable {
    var areaId: String?
    var areaTitle: String
    var items: [ReleasePostItem]
}

struct ReleasePost: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var at: String
    var title: String
    var version: String
    var shippable: String?
    var releaseId: String?
    var by: String
    var groups: [ReleasePostGroup]
    var text: String
    var threadId: String
}

struct StatusMatch: Codable, Equatable, Hashable {
    var item: Item
    var line: String
    var href: String
}

struct StatusAnswer: Codable, Equatable {
    var q: String
    var line: String
    var matches: [StatusMatch]
}

// MARK: - Requests

struct CreateItemRequest: Codable, Equatable {
    var level: ItemLevel
    var title: String
    var body: String?
    var parentId: String?
    var areaId: String?
    var assigneeId: String?
    var reviewerId: String?
    var ownerId: String?
    var points: Int?
    var status: ItemStatus?
    var targetDate: String?
    var acceptance: [String]?
    var rank: Double?
}

/// Any subset. Only the keys set here are sent (absent ≠ null: `points: null` would clear them).
struct UpdateItemRequest: Codable, Equatable {
    var title: String?
    var body: String?
    var assigneeId: String?
    var reviewerId: String?
    var ownerId: String?
    var points: Int?
    var rank: Double?
    var areaId: String?
    var parentId: String?
    var targetDate: String?
    var acceptance: [String]?
    var status: ItemStatus?
    var resolution: ItemResolution?
    var blockedReason: String?
    var waitingOn: String?
    var note: String?
    var recommendation: String?
    var start: Bool?
    /// Rework: required whenever `status` or `assigneeId` changes (`note` is its old alias).
    var reason: String?
    /// Rework: Parked needs it.
    var resumeWhen: String?
}

struct CommentRequest: Codable, Equatable {
    var text: String
    /// Several people at once (LLD-app-fixes §5); `@id` in the text counts too.
    var mentions: [String]? = nil
}

struct MergeRequest: Codable, Equatable {
    var intoId: String
}

struct InboxReplyRequest: Codable, Equatable {
    var text: String?
    var optionId: String?
}
struct CreateAreaRequest: Codable, Equatable {
    var title: String
    var description: String?
    var ownerId: String?
}
struct UpdateAreaRequest: Codable, Equatable {
    var title: String?
    var description: String?
    var state: AreaState?
    var rank: Double?
}
struct CreateReleasePostRequest: Codable, Equatable {
    var version: String
    var shippable: String?
    var itemIds: [String]?
    var title: String?
}
struct FocusRequest: Codable, Equatable {
    var epicIds: [String]
}

// MARK: - Rework (Oct 2026): settings and the Mac queue

/// `GET/POST /api/settings/super-focus`: pushes ignore quiet hours until `until`.
struct SuperFocus: Codable, Equatable {
    var until: String?
}

struct SuperFocusRequest: Codable, Equatable {
    /// 0 switches it off.
    var hours: Int
}

enum MacQueueState: String, Codable, CaseIterable, LenientEnum {
    case queued, granted, done, expired
    case unknown
}

/// One request for the Mac (`mac_queue` row). Decoded leniently: the id may be a number, and
/// the row's snake_case names are accepted next to the camelCase ones.
struct MacQueueEntry: Decodable, Equatable, Identifiable {
    var id: String
    var emp: String
    var itemId: String?
    var minutes: Int?
    var why: String?
    var at: String?
    var state: MacQueueState

    private enum Keys: String, CodingKey { case id, emp, employeeId, itemId, item_id, minutes, why, at, state }

    init(id: String, emp: String, itemId: String? = nil, minutes: Int? = nil, why: String? = nil, at: String? = nil, state: MacQueueState) {
        self.id = id; self.emp = emp; self.itemId = itemId; self.minutes = minutes; self.why = why; self.at = at; self.state = state
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s } else { id = String(try c.decode(Int.self, forKey: .id)) }
        emp = try c.decodeIfPresent(String.self, forKey: .emp) ?? c.decodeIfPresent(String.self, forKey: .employeeId) ?? "?"
        itemId = try c.decodeIfPresent(String.self, forKey: .itemId) ?? c.decodeIfPresent(String.self, forKey: .item_id)
        minutes = try? c.decodeIfPresent(Int.self, forKey: .minutes)
        why = try? c.decodeIfPresent(String.self, forKey: .why)
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        state = (try? c.decodeIfPresent(MacQueueState.self, forKey: .state)) ?? .unknown
    }
}

/// `GET /api/mac-queue`: a list, or an object carrying one.
struct MacQueueResponse: Decodable, Equatable {
    var entries: [MacQueueEntry]

    private enum Keys: String, CodingKey { case queue, entries, items, requests }

    init(from decoder: Decoder) throws {
        if let list = try? decoder.singleValueContainer().decode([MacQueueEntry].self) { entries = list; return }
        let c = try decoder.container(keyedBy: Keys.self)
        for k in [Keys.queue, .entries, .items, .requests] {
            if let list = try c.decodeIfPresent([MacQueueEntry].self, forKey: k) { entries = list; return }
        }
        entries = []
    }
}

/// Any JSON answer whose body the app does not need.
struct IgnoredResponse: Decodable {
    init(from decoder: Decoder) throws {}
}
