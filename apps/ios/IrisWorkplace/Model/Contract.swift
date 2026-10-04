import Foundation

// The Workplace contract, mirrored field for field from packages/shared/src:
// types.ts, protocol.ts, workplace.ts and workplace-api.ts. Names, optionality
// and string unions match the TypeScript exactly; `scripts/check-contract.mjs`
// and the fixture tests fail when they drift.

// MARK: - types.ts

enum AgentStatus: String, Codable, CaseIterable, LenientEnum {
    case idle, running, waiting, done, error
    case unknown
}

enum PermissionMode: String, Codable, CaseIterable, LenientEnum {
    case ask, auto, acceptEdits, plan, dontAsk
    case unknown

    /// What the owner can pick (never `unknown`).
    static var choices: [PermissionMode] { allCases.filter { $0 != .unknown } }
}

enum WorkspaceMode: String, Codable, CaseIterable {
    case worktree, branch, readonly
}

enum LogKind: String, Codable, CaseIterable, LenientEnum {
    case assistant, user, image, read, edit, bash, search, task, tool, error, system, activity
    case unknown
}

/// v2 chat hygiene: who wrote a `user` entry. Absent reads as the owner.
enum LogFrom: String, Codable, CaseIterable, LenientEnum {
    case owner, workplace
    case unknown
}

struct LogImage: Codable, Equatable, Hashable {
    var mediaType: String
    var ref: String
}

/// Set only on a chat-view `'activity'` entry (`toChatView`, mirrored in `ChatView.swift`): the run
/// of consecutive tool-kind entries it stands for, and the original entries for "expand".
struct LogActivity: Codable, Equatable, Hashable {
    var count: Int
    var durationMs: Int
    var entries: [LogEntry]
}

struct LogEntry: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var agentId: String
    var at: String
    var kind: LogKind
    var label: String
    var text: String
    var subagentId: String?
    var image: LogImage?
    var summary: String?
    var details: String?
    var activity: LogActivity?
    var from: LogFrom?
    /// The sender's name (LLD-app-fixes §1): "You", "Claude — COO", "Workplace" or the employee's.
    var fromName: String? = nil
}

struct PendingApproval: Codable, Equatable, Hashable {
    var id: String
    var tool: String
    var input: String
    var reason: String
    var requestedAt: String
}

struct Usage: Codable, Equatable, Hashable {
    var inputTokens: Int
    var outputTokens: Int
    var costUsd: Double
}

struct Agent: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var projectId: String
    var name: String
    var task: String
    var model: String
    var status: AgentStatus
    var workspace: WorkspaceMode
    var cwd: String
    var parentAgentId: String?
    var startedAt: String
    var endedAt: String?
    var usage: Usage
    var messageCount: Int?
    var permissionMode: PermissionMode?
    var alwaysAllowed: [String]?
    var driven: Bool?
    var approval: PendingApproval?
    var employeeId: String?
    var assignmentId: String?
    var contextTokens: Int?
}

struct Project: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var name: String
    var path: String
    var branch: String
    var enabledMcpServers: [String]
}

enum McpHealth: String, Codable, CaseIterable {
    case healthy, degraded, unreachable, starting, unknown
}

enum McpTransport: String, Codable, CaseIterable {
    case stdio, http
}

struct McpServer: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var name: String
    var source: String
    var transport: McpTransport
    var health: McpHealth
    var toolCount: Int
    var note: String?
}

enum ActivityKind: String, Codable, CaseIterable {
    case started, finished, failed, waiting, info
}

struct ActivityEvent: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var at: String
    var projectId: String
    var kind: ActivityKind
    var message: String
}

// MARK: - protocol.ts

enum ApprovalDecision: String, Codable, CaseIterable {
    case once, always, deny
}

struct Attachment: Codable, Equatable, Hashable {
    var name: String
    var mediaType: String
    var data: String
}

struct HealthResponse: Codable, Equatable {
    var ok: Bool
    var name: String
    var version: String
    var uptimeSeconds: Int
    var claudeHome: String?
}

// MARK: - context.ts

enum ContextKind: String, Codable, CaseIterable {
    case user, memory, note, project, local
}

struct ContextLayer: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var kind: ContextKind
    var label: String
    var summary: String
    var path: String
    var exists: Bool
    var inherited: Bool
    var body: String
    var tokens: Int
    var counted: Bool
}

struct ContextResponse: Codable, Equatable {
    var projectId: String
    var layers: [ContextLayer]
    var totalTokens: Int
}

// MARK: - workplace.ts · organisation

enum Axis: String, Codable, CaseIterable {
    case capability, platform, function, project, segment
}

enum OwnedKind: String, Codable, CaseIterable {
    case path, service, route, feature, platform, keyword
    case requirementGroup = "requirement-group"
    case requirement
}

struct OwnedThing: Codable, Equatable, Hashable {
    var kind: OwnedKind
    var key: String
}

struct CharterSummary: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var axis: Axis
    var version: Int
    var mission: String
    var holderIds: [String]
    var tokens: Int
}

struct CharterInterfaces: Codable, Equatable, Hashable {
    var publishes: [String]
    var consumes: [String]
}

struct Charter: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var axis: Axis
    var version: Int
    var mission: String
    var holderIds: [String]
    var tokens: Int
    var scope: [String]
    var owns: [OwnedThing]
    var interfaces: CharterInterfaces
    var rules: [String]
    var definitionOfDone: [String]
    var buildTestShip: [String]
    var coordinateWith: [String]
    var needsOwnerApproval: [String]
    var body: String
    var path: String

    var summary: CharterSummary {
        CharterSummary(id: id, title: title, axis: axis, version: version, mission: mission, holderIds: holderIds, tokens: tokens)
    }
}

/// 0 = chief of staff, 1 = lead (permanent), 2 = hire (contractor). No level 3.
enum Level: Int, Codable, CaseIterable {
    case chiefOfStaff = 0, lead = 1, hire = 2
}

enum BudgetClass: String, Codable, CaseIterable {
    case high, medium, low
}

struct RoleTools: Codable, Equatable, Hashable {
    var allowed: [String]?
    var disallowed: [String]?
}

struct Role: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var level: Level
    var instructions: String
    var tools: RoleTools
    var permissionMode: PermissionMode
    var model: String
    var budgetClass: BudgetClass
}

enum EmployeeState: String, Codable, CaseIterable, LenientEnum {
    case idle, working, blocked
    case needsOwner = "needs-owner"
    case paused
    /// The COO bridge's presence (a virtual employee's card), from the lead's heartbeat — not a session.
    case online, offline
    case unknown
}

struct Workspace: Codable, Equatable, Hashable {
    var repo: String
    var worktree: String?
    var branch: String?
}

struct EmployeeBudget: Codable, Equatable, Hashable {
    var inrPerDay: Double
    var concurrentSessions: Int
}

struct Employee: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var name: String
    var roleId: String
    var level: Level
    var permanent: Bool
    var charterIds: [String]
    var unitId: String
    var chapterIds: [String]
    var reportsTo: String?
    var workspace: Workspace
    var budget: EmployeeBudget
    var githubApp: String?
    var state: EmployeeState
    var stateReason: String?
    /// True for an employee the Workplace never spawns (the COO): shown in Office/Org like any
    /// other employee; `talk`/`assign`/`spawn` refuse it. Reached through the COO bridge instead.
    var virtual: Bool?
}

enum UnitKind: String, Codable, CaseIterable {
    case unit, chapter
}

struct UnitBudget: Codable, Equatable, Hashable {
    var inrPerDay: Double
}

struct Unit: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var parentId: String?
    var kind: UnitKind
    var budget: UnitBudget?
}

struct MapEntry: Codable, Equatable, Hashable {
    var kind: OwnedKind
    var key: String
    var primary: String
    var contributors: [String]
    var consulted: [String]
}

enum LintCode: String, Codable, CaseIterable {
    case orphan, overlap, dead
    case unownedRequirement = "unowned-requirement"
    case unheldCharter = "unheld-charter"
    case unknownRef = "unknown-ref"
}

enum LintSeverity: String, Codable, CaseIterable {
    case error, warn
}

struct LintFinding: Codable, Equatable, Hashable {
    var code: LintCode
    var severity: LintSeverity
    var subject: String
    var message: String
}

struct RouteHit: Codable, Equatable, Hashable {
    var charterId: String
    var because: [OwnedThing]
}

struct RouteResult: Codable, Equatable, Hashable {
    var primaries: [RouteHit]
    var consulted: [String]
    var unresolved: [OwnedThing]
}

// MARK: - workplace.ts · requirements

enum RequirementStatus: String, Codable, CaseIterable {
    case missing, partial, built, verified, released
}

struct Requirement: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var group: String
    var section: String
    var title: String
    var note: String?
    var segments: [String]
    var status: RequirementStatus
    var evidence: [String]
    var charterId: String?
    var featureIds: [String]
}

struct CoverageCounts: Codable, Equatable, Hashable {
    var total: Int
    var owned: Int
    var planned: Int
    var built: Int
    var verified: Int
    var released: Int
}

struct Coverage: Codable, Equatable, Hashable {
    var total: Int
    var owned: Int
    var planned: Int
    var built: Int
    var verified: Int
    var released: Int
    var byGroup: [String: CoverageCounts]
    var byCharter: [String: CoverageCounts]

    var counts: CoverageCounts {
        CoverageCounts(total: total, owned: owned, planned: planned, built: built, verified: verified, released: released)
    }
}

// MARK: - workplace.ts · work

enum WorkKind: String, Codable, CaseIterable, LenientEnum {
    case feature, assignment, bug, question
    case unknown
}

/// FeatureState | AssignmentState, one enum because the TypeScript `WorkState` is their union.
enum WorkState: String, Codable, CaseIterable, LenientEnum {
    // FeatureState
    case stated, specced, decomposed
    case inProgress = "in-progress"
    case built, released
    // AssignmentState
    case proposed, planned, building, review, done, blocked, rejected
    case unknown

    static let featureStates: [WorkState] = [.stated, .specced, .decomposed, .inProgress, .built, .released]
    static let assignmentStates: [WorkState] = [.proposed, .planned, .building, .review, .done, .blocked, .rejected]
}

struct EvidenceTests: Codable, Equatable, Hashable {
    var passed: Int
    var failed: Int
    var command: String?
}

struct Evidence: Codable, Equatable, Hashable {
    var tests: EvidenceTests
    var commits: [String]
    var liveVerified: [String]
    var notVerified: [String]
    var notes: String?
}

struct WorkHistoryEntry: Codable, Equatable, Hashable {
    var at: String
    var from: WorkState?
    var to: WorkState
    var by: String
    var note: String?
    var cause: String?
}

struct WorkItem: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var kind: WorkKind
    var title: String
    var body: String
    var state: WorkState
    var charterId: String?
    var employeeId: String?
    var featureId: String?
    var requirementIds: [String]
    var platformIds: [String]
    var spec: String?
    var plan: String?
    var evidence: Evidence?
    var verifiedBy: String?
    var sessionId: String?
    var createdAt: String
    var updatedAt: String
    var history: [WorkHistoryEntry]
    var stalledSince: String?

    // v2 (LLD §19.2): all optional and additive; the client shape is `Item`.
    var level: ItemLevel?
    var status: ItemStatus?
    var statusSince: String?
    var parentId: String?
    var areaId: String?
    var rank: Double?
    var points: Int?
    var reviewerId: String?
    var ownerId: String?
    var targetDate: String?
    var acceptance: [String]?
    var blockedReason: String?
    var waitingOn: String?
    var blockedSince: String?
    var blockedRecommendation: String?
    var resolution: ItemResolution?
    var mergedInto: String?
    var releasedIn: String?
}

// MARK: - workplace.ts · inbox

/// One line to the owner (HLD D16): what he reads first, ≤ `ownerLineMax` chars; the rest on demand.
struct OwnerLine: Codable, Equatable, Hashable {
    var summary: String
    var details: String?

    static let ownerLineMax = 120
}

enum InboxKind: String, Codable, CaseIterable, LenientEnum {
    case approval, decision, question, cap
    case orgChange = "org-change"
    case release
    case unknown
}

struct InboxOption: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var label: String
    var danger: Bool?
    /// v2: the option the asker recommends (marked on the button).
    var recommended: Bool?
    var needsNote: Bool?
}

enum AnswerVia: String, Codable, CaseIterable, LenientEnum {
    case web, phone, telegram, workplace
    case unknown
}

struct InboxAnswer: Codable, Equatable, Hashable {
    var optionId: String
    var note: String?
    var at: String
    var via: AnswerVia
}

enum InboxState: String, Codable, CaseIterable, LenientEnum {
    case open, answered, expired
    case unknown
}

/// v2: shown by colour and label, not wording. Absent = normal.
enum InboxUrgency: String, Codable, CaseIterable, LenientEnum {
    case normal, high, urgent
    case unknown
}

struct InboxItem: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var kind: InboxKind
    var title: String
    var body: String
    var context: [String: JSONValue]
    var options: [InboxOption]
    var state: InboxState
    var answer: InboxAnswer?
    var raisedBy: String
    var createdAt: String
    var affects: [String]
    var onApprove: String?
    var onDeny: String?
    var links: [InboxLink]?
    var summary: String
    var details: String?
    /// False for routine housekeeping that never reaches the owner's Inbox (a stall notice, a
    /// no-op session, a non-owner review) — only the affected employees' pages show it. Absent or
    /// true means the owner decides it. The server decides this; clients never set it.
    var ownerFacing: Bool?
    /// v2: replies in the item's thread (GET /api/inbox/:id has them).
    var messageCount: Int?
    var lastMessageAt: String?
    var urgency: InboxUrgency?
}

struct InboxLink: Codable, Equatable, Hashable {
    var label: String
    var href: String

    /// `#/room/<threadId>` is a deep link into a Team Room thread.
    var roomThreadId: String? {
        guard href.hasPrefix("#/room/") else { return nil }
        let id = String(href.dropFirst("#/room/".count))
        return id.isEmpty ? nil : id
    }

    var url: URL? {
        guard href.hasPrefix("http://") || href.hasPrefix("https://") else { return nil }
        return URL(string: href)
    }
}

// MARK: - workplace.ts · org changes

enum ProposalKind: String, Codable, CaseIterable {
    case hire, retire, split, merge, reassign, restructure
}

enum ProposalState: String, Codable, CaseIterable {
    case pending, approved, rejected, applied
}

struct OrgSnapshot: Codable, Equatable, Hashable {
    var units: [Unit]
    var employees: [Employee]
    var charters: [CharterSummary]
    var map: [MapEntry]
}

struct OrgProposal: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var kind: ProposalKind
    var reason: String
    var proposedBy: String
    var state: ProposalState
    var params: [String: JSONValue]
    var before: OrgSnapshot
    var after: OrgSnapshot
    var diff: String
    var inboxId: String
    var createdAt: String
    var appliedCommit: String?
    var lint: [LintFinding]
}

struct OrgHistoryEntry: Codable, Equatable, Hashable {
    var commit: String
    var at: String
    var message: String
}

// MARK: - workplace.ts · spend and health

enum SpendSource: String, Codable, CaseIterable {
    case anthropicApi = "anthropic-api"
    case aws
    case thirdParty = "third-party"
    case subscription
}

enum SpendBasis: String, Codable, CaseIterable {
    case metered, estimated, reported
}

enum SpendTag: String, Codable, CaseIterable {
    case ownerTalk = "owner-talk"
}

struct SpendEntry: Codable, Equatable, Hashable {
    var at: String
    var employeeId: String
    var sessionId: String
    var source: SpendSource
    var basis: SpendBasis
    var what: String
    var inr: Double
    var detail: [String: JSONValue]?
    var tag: SpendTag?
}

enum RateLimitWindowKind: String, Codable, CaseIterable {
    case fiveHour = "five_hour"
    case sevenDay = "seven_day"
    case sevenDayOpus = "seven_day_opus"
    case sevenDaySonnet = "seven_day_sonnet"
    case sevenDayOverageIncluded = "seven_day_overage_included"
    case overage, unknown
}

enum RateLimitStatus: String, Codable, CaseIterable {
    case allowed
    case allowedWarning = "allowed_warning"
    case rejected
}

struct RateLimitWindow: Codable, Equatable, Hashable {
    var window: RateLimitWindowKind
    var status: RateLimitStatus
    var utilization: Double?
    var resetsAt: String?
    var seenAt: String
}

struct SubscriptionEmployeeUsage: Codable, Equatable, Hashable {
    var turns: Int
    var equivalentInr: Double
}

struct SubscriptionUsage: Codable, Equatable, Hashable {
    var turns: Int
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var cacheWriteTokens: Int
    var equivalentInr: Double
    var byEmployee: [String: SubscriptionEmployeeUsage]
    var windows: [RateLimitWindow]
}

struct SpendSummary: Codable, Equatable, Hashable {
    var day: String
    var companyInr: Double
    var capInr: Double
    var bySource: [String: Double]
    var byBasis: [String: Double]
    var byEmployee: [String: Double]
    var byUnit: [String: Double]
    var paused: [String]
    var subscription: SubscriptionUsage
    var ownerTalkInr: Double
}

struct EmployeeSignals: Codable, Equatable, Hashable {
    var throughput7d: Double
    var rework7d: Double
    var falseDoneRate7d: Double
    var costPerDoneInr: Double
}

struct CharterSignals: Codable, Equatable, Hashable {
    var queue: Int
    var contextLimitHits7d: Int
}

struct ProposalTrigger: Codable, Equatable, Hashable {
    var code: String
    var subject: String
    var message: String
}

enum StallReason: String, Codable, CaseIterable {
    case idle, loop
}

struct StalledSession: Codable, Equatable, Hashable {
    var sessionId: String
    var employeeId: String
    var reason: StallReason
    var since: String
}

struct HealthSignals: Codable, Equatable, Hashable {
    var employees: [String: EmployeeSignals]
    var charters: [String: CharterSignals]
    var blockingPairs: [[String]]
    var proposalTriggers: [ProposalTrigger]
    var stalled: [StalledSession]
}

// MARK: - workplace.ts · releases

enum Shippable: String, Codable, CaseIterable {
    case desktopMac = "desktop-mac"
    case desktopIntel = "desktop-intel"
    case windows, ios, android
    case serverApi = "server-api"
    case serverAgent = "server-agent"
    case website
}

enum ReleaseState: String, Codable, CaseIterable {
    case proposed, approved, rejected, running, done, failed
}

struct Release: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var shippable: Shippable
    var version: String
    var state: ReleaseState
    var unreleased: [String]
    var inboxId: String
    var log: String?
    var createdAt: String
}

// MARK: - workplace.ts · the Team Room

enum RoomThreadState: String, Codable, CaseIterable, LenientEnum {
    case open, resolved
    case unknown
}

/// v2: what a Room message is. Absent = an authored message.
enum RoomMessageKind: String, Codable, CaseIterable, LenientEnum {
    case message, update, standup, release
    case unknown
}

struct RoomThread: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var charterIds: [String]
    var createdBy: String
    var createdAt: String
    var state: RoomThreadState
    var summary: String?
    var lastAt: String
    var messageCount: Int
    var participants: [String]
    var escalations: [String]
    var headline: String
    /// v2: 'general' | 'area:<id>' | 'releases'. Absent reads as 'general'.
    var roomId: String?
    /// v2: the epic this thread is about, inside its area room.
    var epicId: String?
}

struct RoomMessage: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var threadId: String
    var at: String
    var by: String
    var owner: Bool
    var text: String
    var mentions: [String]
    var kind: RoomMessageKind?
    /// v2: who a stand-up is about.
    var about: String?
    /// v2: the rest of a long agent message; `text` stays short.
    var details: String?
    /// v2: the item an update line is about.
    var itemId: String?
    /// The agent's post was cut: `details` is the full text (LLD-app-fixes §8).
    var truncated: Bool? = nil
}

// MARK: - workplace.ts · views

struct EmployeeCard: Codable, Equatable, Hashable, Identifiable {
    var employee: Employee
    var charters: [CharterSummary]
    var currentWork: WorkItem?
    var lastReport: String?
    var session: Agent?
    var spendTodayInr: Double
    var needsYou: Int

    var id: String { employee.id }
}

// MARK: - workplace-api.ts · responses

enum PublishedState: String, Codable, CaseIterable {
    case notConfigured = "not-configured"
    case connecting, connected, offline, off
}

/// Emitted by the server on /api/health (routes.ts), not yet declared in packages/shared.
struct PushHealth: Codable, Equatable {
    var enabled: Bool
    var sentToday: Int
    var suppressedToday: Int
}

struct WorkplaceInfo: Codable, Equatable {
    var dataDir: String
    var capInr: Double
    var day: String
    var telegram: Bool
    var published: PublishedState
    var push: PushHealth?
}

/// The Mac's own health (RESILIENCE-workplace.md §5), emitted on /api/health; every part optional
/// so an older server still decodes.
struct Resilience: Codable, Equatable {
    struct Boots: Codable, Equatable { var total: Int; var last24h: Int; var recent: [String]? }
    struct Reconnects: Codable, Equatable { var halfOpen: Int; var afterSleep: Int }
    struct Tunnel: Codable, Equatable {
        var status: String
        var attempts: Int?
        var connects: Int?
        var lastConnectedAt: String?
        var lastDisconnectedAt: String?
        var lastError: String?
        var downForSeconds: Int?
        var backoffMs: Int?
        var reconnects: Reconnects?
    }
    struct Watchdog: Codable, Equatable {
        struct CrashLoop: Codable, Equatable { var alertedAt: String?; var stableAt: String? }
        var link: String
        var downSince: String?
        var incidents: Int?
        var crashLoop: CrashLoop?
    }
    struct Sleeps: Codable, Equatable {
        var count: Int
        var lastAt: String?
        var lastSeconds: Int?
        var totalSeconds: Int?
    }
    struct Power: Codable, Equatable {
        /// "ac" or "battery".
        var source: String
        var percent: Int?
        var charging: Bool?
        var readAt: String?
    }
    var startedAt: String?
    var uptimeSeconds: Int?
    var boots: Boots?
    var tunnel: Tunnel?
    var watchdog: Watchdog?
    var sleeps: Sleeps?
    var power: Power?

    var onBattery: Bool { power?.source.lowercased() == "battery" }

    /// A sleep within the window, from `sleeps.lastAt`.
    func sleptRecently(within seconds: TimeInterval = 3600, now: Date = Date()) -> Bool {
        guard let last = sleeps?.lastAt, let d = Format.date(last) else { return false }
        return now.timeIntervalSince(d) <= seconds
    }

    /// One line for Settings: "on charger · awake", "on battery 62% · slept 2×, last 12 min ago".
    func macLine(now: Date = Date()) -> String {
        var parts: [String] = []
        if let p = power {
            if onBattery {
                parts.append("on battery" + (p.percent.map { " \($0)%" } ?? ""))
            } else {
                parts.append(p.charging == false ? "on power" : "on charger")
            }
        }
        if let s = sleeps, s.count > 0 {
            var t = "slept \(s.count)×"
            if let last = s.lastAt { t += ", last " + Format.ago(last, now: now) }
            parts.append(t)
        } else {
            parts.append("awake")
        }
        return parts.joined(separator: " · ")
    }

    /// The Office warning, or nil when there is nothing to say.
    func officeWarning(now: Date = Date()) -> String? {
        if onBattery { return "Mac is on battery — Workplace may drop when it sleeps" }
        if sleptRecently(now: now) { return "Mac slept \(sleeps?.count ?? 1)× recently — sessions may have paused" }
        if let t = tunnel, t.status != "connected" { return "Mac's tunnel is \(t.status) — the relay may not reach it" }
        return nil
    }
}

struct WorkplaceHealthResponse: Codable, Equatable {
    var ok: Bool
    var name: String
    var version: String
    var uptimeSeconds: Int
    var claudeHome: String?
    var workplace: WorkplaceInfo
    var resilience: Resilience?
}

struct OfficeUnit: Codable, Equatable, Hashable, Identifiable {
    var unit: Unit
    var employees: [EmployeeCard]

    var id: String { unit.id }
}

struct OfficeCounts: Codable, Equatable, Hashable {
    var working: Int
    var blocked: Int
    var stalled: Int
    var needsYou: Int
    var total: Int
}

struct OfficeResponse: Codable, Equatable {
    var chiefOfStaff: String
    var units: [OfficeUnit]
    var coverage: Coverage
    var needsYou: Int
    var spend: SpendSummary
    var lintErrors: Int
    var counts: OfficeCounts
}

struct OrgResponse: Codable, Equatable {
    var units: [Unit]
    var roles: [Role]
    var employees: [Employee]
    var charters: [CharterSummary]
    var map: [MapEntry]
    var lint: [LintFinding]
    var proposals: [OrgProposal]
    var history: [OrgHistoryEntry]
}

struct EmployeeDetail: Codable, Equatable {
    var employee: Employee
    var charters: [CharterSummary]
    var status: String
    var handoff: String
    var sessions: [Agent]
    var assignments: [WorkItem]
    var spendTodayInr: Double
    var signals: EmployeeSignals
    var needsYou: [InboxItem]
}

struct RoomResponse: Codable, Equatable {
    var threads: [RoomThread]
}

struct RoomThreadDetail: Codable, Equatable {
    var thread: RoomThread
    var messages: [RoomMessage]
}

struct FeatureBoard: Codable, Equatable {
    var features: [WorkItem]
    var byState: [String: Int]
    var status: [String: RequestStatus]
}

struct FeatureDetail: Codable, Equatable {
    var feature: WorkItem
    var assignments: [WorkItem]
    var requirements: [Requirement]
    var route: RouteResult
    var status: RequestStatus
}

enum RequestStage: String, Codable, CaseIterable {
    case withAsha = "with-asha"
    case specced, routed, building, review, blocked, built, released
}

struct RequestAssignment: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var employeeId: String?
    var charterId: String?
    var state: WorkState
    var stalledSince: String?
}

struct RequestStatus: Codable, Equatable, Hashable {
    var stage: RequestStage
    var line: String
    var assignments: [RequestAssignment]
    var askedAgentId: String?
}

struct CreateRequest: Codable, Equatable {
    var text: String
    var platformIds: [String]?
}

struct RequestResponse: Codable, Equatable, Identifiable {
    var feature: WorkItem
    var status: RequestStatus
    var id: String { feature.id }
}

struct ProposalDetail: Codable, Equatable {
    var proposal: OrgProposal
    var item: InboxItem
}

struct ReleaseReadiness: Codable, Equatable, Identifiable {
    var shippable: Shippable
    var unreleased: [String]
    var open: Release?
    var last: Release?
    var id: String { shippable.rawValue }
}

struct PivotItemEvidence: Codable, Equatable, Hashable {
    var tests: String
    var commits: [String]
    var liveVerified: Int
    var notVerified: Int
}

struct PivotItem: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var title: String
    var employeeId: String?
    var state: WorkState
    var evidence: PivotItemEvidence?
    var href: String
}

struct PivotCell: Codable, Equatable, Hashable {
    var total: Int
    var byState: [String: Int]
    var items: [PivotItem]
}

struct Pivot: Codable, Equatable {
    var rows: [String]
    var cols: [String]
    var cells: [String: [String: PivotCell]]
}

struct DecomposeResponse: Codable, Equatable {
    var feature: WorkItem
    var assignments: [WorkItem]
    var route: RouteResult
}

struct PairResponse: Codable, Equatable {
    var code: String
    var expiresAt: String
}

struct PairExchangeResponse: Codable, Equatable {
    var token: String
}

/// `{ error: string }`, the shape of every 400/401/404/409.
struct ErrorResponse: Codable, Equatable {
    var error: String
}

// MARK: - workplace-api.ts · requests

struct TalkRequest: Codable, Equatable {
    var text: String
    var attachments: [Attachment]?
    var probe: Bool?
}

struct CreateThreadRequest: Codable, Equatable {
    var title: String
    var text: String
    var charterIds: [String]?
    var mentions: [String]?
}

struct PostMessageRequest: Codable, Equatable {
    var text: String
    var mentions: [String]?
}

/// `POST /api/coo/message` body: `{ text }`, no dedicated TS request type (the route reads it raw).
struct CooMessageRequest: Codable, Equatable {
    var text: String
}

struct ResolveThreadRequest: Codable, Equatable {
    var summary: String
}

struct AnswerInboxRequest: Codable, Equatable {
    var optionId: String
    var note: String?
}

struct CreateWorkRequest: Codable, Equatable {
    var kind: WorkKind
    var title: String
    var body: String
    var charterId: String?
    var employeeId: String?
    var requirementIds: [String]?
    var platformIds: [String]?
    /// An assignment under a feature: it counts in the feature's status and the pivot.
    var featureId: String?
    /// false: create the assignment without starting its session.
    var start: Bool?
}

struct TransitionRequest: Codable, Equatable {
    var to: WorkState
    var note: String?
    var evidence: Evidence?
    var by: String?
}

struct CreateFeatureRequest: Codable, Equatable {
    var title: String
    var body: String
    var requirementIds: [String]?
    var platformIds: [String]?
    var paths: [String]?
    var services: [String]?
}

struct CreateProposalRequest: Codable, Equatable {
    var kind: ProposalKind
    var reason: String
    var params: [String: JSONValue]
    var proposedBy: String?
}

struct CreateReleaseRequest: Codable, Equatable {
    var shippable: Shippable
    var version: String
}

struct SaveCharterRequest: Codable, Equatable {
    var body: String
}

struct SaveEmployeeContextRequest: Codable, Equatable {
    var id: String
    var body: String
}

struct PairExchangeRequest: Codable, Equatable {
    var code: String
}

enum PivotRows: String, Codable, CaseIterable {
    case charter, platform, team
}

// MARK: - JSON values for `Record<string, unknown>`

enum JSONValue: Codable, Equatable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// A short human rendering for the Inbox context panel.
    var display: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "yes" : "no"
        case .null: return "—"
        case .array(let a): return a.map(\.display).joined(separator: ", ")
        case .object(let o): return o.keys.sorted().map { "\($0): \(o[$0]!.display)" }.joined(separator: "\n")
        }
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}

// MARK: - workplace.ts · the COO bridge

enum CooSpeaker: String, Codable, CaseIterable, LenientEnum {
    case owner, coo
    case unknown
}

struct CooMessage: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var at: String
    var from: CooSpeaker
    var text: String
    /// Chat-style: the reply itself is the summary (short); `details` is optional extra context.
    var summary: String?
    var details: String?
    /// Set on a `coo` message that answers a specific owner message.
    var inReplyTo: String?
    /// Files on the message, either way (LLD-app-fixes §12).
    var attachments: [TalkAttachment]? = nil
}

enum CooItemKind: String, Codable, CaseIterable, LenientEnum {
    case escalation, mention, stall
    case unknown
}
enum CooItemState: String, Codable, CaseIterable, LenientEnum {
    case open, answered, forwarded
    case unknown
}

struct CooItemAnswer: Codable, Equatable, Hashable {
    var optionId: String
    var note: String?
    var at: String
}

struct CooItemForward: Codable, Equatable, Hashable {
    var inboxId: String
    var recommendation: String?
    var at: String
    var auto: Bool
}

/// Something Asha would raise above her own authority, or an `@coo` Room mention, delivered to the
/// COO bridge instead of straight to the owner's Inbox. Lead-only to answer/forward (loopback);
/// the phone only ever reads the transcript and presence.
struct CooItem: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var at: String
    var kind: CooItemKind
    var title: String
    var body: String
    var options: [InboxOption]
    var raisedBy: String
    var threadId: String?
    var itemId: String?
    var state: CooItemState
    var answer: CooItemAnswer?
    var forward: CooItemForward?
}

struct CooPresence: Codable, Equatable, Hashable {
    var online: Bool
    var lastHeartbeat: String?
}
