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
    case done, blocked
    case unknown

    /// The board's columns, in the state machine's order.
    static let order: [ItemStatus] = [.backlog, .ready, .inProgress, .inReview, .blocked, .done]
    var isOpen: Bool { self != .done }
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

    var id: String { epic.id }
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
