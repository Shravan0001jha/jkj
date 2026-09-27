import Foundation

// The Workplace contract, mirrored field for field from packages/shared/src:
// types.ts, protocol.ts, workplace.ts and workplace-api.ts. Names, optionality
// and string unions match the TypeScript exactly; `scripts/check-contract.mjs`
// and the fixture tests fail when they drift.

// MARK: - types.ts

enum AgentStatus: String, Codable, CaseIterable {
    case idle, running, waiting, done, error
}

enum PermissionMode: String, Codable, CaseIterable {
    case ask, auto, acceptEdits, plan, dontAsk
}

enum WorkspaceMode: String, Codable, CaseIterable {
    case worktree, branch, readonly
}

enum LogKind: String, Codable, CaseIterable {
    case assistant, user, image, read, edit, bash, search, task, tool, error, system
}

struct LogImage: Codable, Equatable, Hashable {
    var mediaType: String
    var ref: String
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

enum EmployeeState: String, Codable, CaseIterable {
    case idle, working, blocked
    case needsOwner = "needs-owner"
    case paused
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

enum WorkKind: String, Codable, CaseIterable {
    case feature, assignment, bug, question
}

/// FeatureState | AssignmentState, one enum because the TypeScript `WorkState` is their union.
enum WorkState: String, Codable, CaseIterable {
    // FeatureState
    case stated, specced, decomposed
    case inProgress = "in-progress"
    case built, released
    // AssignmentState
    case proposed, planned, building, review, done, blocked, rejected

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
}

// MARK: - workplace.ts · inbox

enum InboxKind: String, Codable, CaseIterable {
    case approval, decision, question, cap
    case orgChange = "org-change"
    case release
}

struct InboxOption: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var label: String
    var danger: Bool?
    var needsNote: Bool?
}

enum AnswerVia: String, Codable, CaseIterable {
    case web, phone, telegram
}

struct InboxAnswer: Codable, Equatable, Hashable {
    var optionId: String
    var note: String?
    var at: String
    var via: AnswerVia
}

enum InboxState: String, Codable, CaseIterable {
    case open, answered, expired
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

struct SpendEntry: Codable, Equatable, Hashable {
    var at: String
    var employeeId: String
    var sessionId: String
    var model: String
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var cacheWriteTokens: Int
    var usd: Double
    var inr: Double
}

struct SpendSummary: Codable, Equatable, Hashable {
    var day: String
    var companyInr: Double
    var capInr: Double
    var byEmployee: [String: Double]
    var byUnit: [String: Double]
    var paused: [String]
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

struct WorkplaceInfo: Codable, Equatable {
    var dataDir: String
    var capInr: Double
    var day: String
    var telegram: Bool
}

struct WorkplaceHealthResponse: Codable, Equatable {
    var ok: Bool
    var name: String
    var version: String
    var uptimeSeconds: Int
    var claudeHome: String?
    var workplace: WorkplaceInfo
}

struct OfficeUnit: Codable, Equatable, Hashable, Identifiable {
    var unit: Unit
    var employees: [EmployeeCard]

    var id: String { unit.id }
}

struct OfficeResponse: Codable, Equatable {
    var units: [OfficeUnit]
    var coverage: Coverage
    var needsYou: Int
    var spend: SpendSummary
    var lintErrors: Int
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
}

struct FeatureBoard: Codable, Equatable {
    var features: [WorkItem]
    var byState: [String: Int]
}

struct FeatureDetail: Codable, Equatable {
    var feature: WorkItem
    var assignments: [WorkItem]
    var requirements: [Requirement]
    var route: RouteResult
}

struct PivotCell: Codable, Equatable, Hashable {
    var total: Int
    var byState: [String: Int]
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
