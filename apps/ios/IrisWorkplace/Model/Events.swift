import Foundation

// Socket events (`ServerEvent` + `WorkplaceServerEvent`) and commands
// (`ClientCommand` + `WorkplaceClientCommand`), discriminated by `type`.
// An unknown type is kept, not dropped, so an announced addition never
// breaks the client.

enum AlertLevel: String, Codable, CaseIterable, LenientEnum {
    case info
    case needsYou = "needs-you"
    case blocked, cap
    case unknown
}

struct AlertEvent: Codable, Equatable, Hashable {
    var level: AlertLevel
    var title: String
    var body: String
    var inboxId: String?
}

enum ServerEvent: Equatable {
    // protocol.ts
    case hello(version: String, startedAt: String)
    case snapshot(agents: [Agent])
    case agentUpdated(Agent)
    case agentRemoved(agentId: String)
    case agentLog(LogEntry)
    case mcpUpdated(McpServer)
    case activity(ActivityEvent)
    case error(message: String)
    // workplace-api.ts
    case officeSnapshot(OfficeResponse)
    case officeUpdated(EmployeeCard)
    case inboxUpdated(InboxItem)
    case workUpdated(WorkItem)
    case proposalUpdated(OrgProposal)
    case releaseUpdated(Release)
    case releaseLog(id: String, line: String)
    case spendUpdated(SpendSummary)
    case signalsUpdated(HealthSignals)
    case alert(AlertEvent)
    case roomThread(RoomThread)
    case roomMessage(RoomMessage, thread: RoomThread)
    /// The COO bridge (loopback-only reply/answer/forward aside): the owner's and the lead's
    /// messages reach every authenticated socket, phone included.
    case cooMessage(CooMessage)
    /// Lead-only (local sockets only; the phone never receives this — see hub.ts).
    case cooItem(CooItem)
    /// Only on an online↔offline flip, to every authenticated socket.
    case cooPresence(CooPresence)
    /// A mentioned employee's reply turn: `started` (show "…is replying"), `done` (it posted, or
    /// chose not to), `skipped` (no `started` came first — it decided not to reply).
    case roomReplying(threadId: String, employeeId: String, state: ReplyingState)
    // v2 (LLD §19.8)
    case itemUpdated(Item)
    case itemComment(Comment)
    case activityRecorded(Activity)
    case updatePosted(Update)
    case areaUpdated(Area)
    case inboxMessage(InboxMessage)
    case releasePost(ReleasePost)
    // Talk threads (LLD-app-fixes §2–§4)
    case talkMessage(TalkMessage, thread: TalkThread)
    case talkThread(TalkThread)
    case talkTyping(threadId: String, employeeId: String, typing: Bool)
    case unknown(type: String)

    static let knownTypes: [String] = [
        "hello", "snapshot", "agent.updated", "agent.removed", "agent.log", "mcp.updated", "activity", "error",
        "office.snapshot", "office.updated", "inbox.updated", "work.updated", "proposal.updated", "release.updated", "release.log",
        "spend.updated", "signals.updated", "alert", "room.thread", "room.message", "coo.message", "coo.item", "coo.presence",
        "room.replying",
        "item.updated", "item.comment", "activity.recorded", "update.posted", "area.updated", "inbox.message", "release.post",
        "talk.message", "talk.thread", "talk.typing",
    ]
}

enum ReplyingState: String, Codable, CaseIterable, LenientEnum {
    case started, done, skipped
    case unknown
}

extension ServerEvent: Decodable {
    private enum Keys: String, CodingKey {
        case type, version, startedAt, agents, agent, agentId, entry, server, event, message
        case office, card, item, proposal, release, id, line, summary, signals, level, title, body, inboxId
        case thread, presence, threadId, employeeId, state
        case comment, activity, update, area, post, typing
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(version: try c.decode(String.self, forKey: .version),
                          startedAt: try c.decode(String.self, forKey: .startedAt))
        case "snapshot":
            self = .snapshot(agents: try c.decode([Agent].self, forKey: .agents))
        case "agent.updated":
            self = .agentUpdated(try c.decode(Agent.self, forKey: .agent))
        case "agent.removed":
            self = .agentRemoved(agentId: try c.decode(String.self, forKey: .agentId))
        case "agent.log":
            self = .agentLog(try c.decode(LogEntry.self, forKey: .entry))
        case "mcp.updated":
            self = .mcpUpdated(try c.decode(McpServer.self, forKey: .server))
        case "activity":
            self = .activity(try c.decode(ActivityEvent.self, forKey: .event))
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case "office.snapshot":
            self = .officeSnapshot(try c.decode(OfficeResponse.self, forKey: .office))
        case "office.updated":
            self = .officeUpdated(try c.decode(EmployeeCard.self, forKey: .card))
        case "inbox.updated":
            self = .inboxUpdated(try c.decode(InboxItem.self, forKey: .item))
        case "work.updated":
            self = .workUpdated(try c.decode(WorkItem.self, forKey: .item))
        case "proposal.updated":
            self = .proposalUpdated(try c.decode(OrgProposal.self, forKey: .proposal))
        case "release.updated":
            self = .releaseUpdated(try c.decode(Release.self, forKey: .release))
        case "release.log":
            self = .releaseLog(id: try c.decode(String.self, forKey: .id), line: try c.decode(String.self, forKey: .line))
        case "spend.updated":
            self = .spendUpdated(try c.decode(SpendSummary.self, forKey: .summary))
        case "signals.updated":
            self = .signalsUpdated(try c.decode(HealthSignals.self, forKey: .signals))
        case "alert":
            self = .alert(AlertEvent(level: try c.decode(AlertLevel.self, forKey: .level),
                                     title: try c.decode(String.self, forKey: .title),
                                     body: try c.decode(String.self, forKey: .body),
                                     inboxId: try c.decodeIfPresent(String.self, forKey: .inboxId)))
        case "room.thread":
            self = .roomThread(try c.decode(RoomThread.self, forKey: .thread))
        case "room.message":
            self = .roomMessage(try c.decode(RoomMessage.self, forKey: .message), thread: try c.decode(RoomThread.self, forKey: .thread))
        case "coo.message":
            self = .cooMessage(try c.decode(CooMessage.self, forKey: .message))
        case "coo.item":
            self = .cooItem(try c.decode(CooItem.self, forKey: .item))
        case "coo.presence":
            self = .cooPresence(try c.decode(CooPresence.self, forKey: .presence))
        case "room.replying":
            self = .roomReplying(threadId: try c.decode(String.self, forKey: .threadId),
                                  employeeId: try c.decode(String.self, forKey: .employeeId),
                                  state: try c.decode(ReplyingState.self, forKey: .state))
        case "item.updated":
            self = .itemUpdated(try c.decode(Item.self, forKey: .item))
        case "item.comment":
            self = .itemComment(try c.decode(Comment.self, forKey: .comment))
        case "activity.recorded":
            self = .activityRecorded(try c.decode(Activity.self, forKey: .activity))
        case "update.posted":
            self = .updatePosted(try c.decode(Update.self, forKey: .update))
        case "area.updated":
            self = .areaUpdated(try c.decode(Area.self, forKey: .area))
        case "inbox.message":
            self = .inboxMessage(try c.decode(InboxMessage.self, forKey: .message))
        case "release.post":
            self = .releasePost(try c.decode(ReleasePost.self, forKey: .post))
        case "talk.message":
            self = .talkMessage(try c.decode(TalkMessage.self, forKey: .message), thread: try c.decode(TalkThread.self, forKey: .thread))
        case "talk.thread":
            self = .talkThread(try c.decode(TalkThread.self, forKey: .thread))
        case "talk.typing":
            self = .talkTyping(threadId: try c.decode(String.self, forKey: .threadId),
                               employeeId: try c.decodeIfPresent(String.self, forKey: .employeeId) ?? "",
                               typing: try c.decode(Bool.self, forKey: .typing))
        default:
            self = .unknown(type: type)
        }
    }
}

enum ClientCommand: Equatable {
    case subscribe(projectId: String)
    case agentMessage(agentId: String, text: String)
    case agentInterrupt(agentId: String)
    case agentApprove(agentId: String, approvalId: String, decision: ApprovalDecision)
    case agentMode(agentId: String, mode: PermissionMode)
    case inboxAnswer(id: String, optionId: String, note: String?)

    static let knownTypes: [String] = [
        "subscribe", "agent.message", "agent.interrupt", "agent.approve", "agent.mode", "inbox.answer",
    ]
}

extension ClientCommand: Encodable {
    private enum Keys: String, CodingKey {
        case type, projectId, agentId, text, approvalId, decision, mode, id, optionId, note
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .subscribe(let projectId):
            try c.encode("subscribe", forKey: .type)
            try c.encode(projectId, forKey: .projectId)
        case .agentMessage(let agentId, let text):
            try c.encode("agent.message", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
            try c.encode(text, forKey: .text)
        case .agentInterrupt(let agentId):
            try c.encode("agent.interrupt", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
        case .agentApprove(let agentId, let approvalId, let decision):
            try c.encode("agent.approve", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
            try c.encode(approvalId, forKey: .approvalId)
            try c.encode(decision, forKey: .decision)
        case .agentMode(let agentId, let mode):
            try c.encode("agent.mode", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
            try c.encode(mode, forKey: .mode)
        case .inboxAnswer(let id, let optionId, let note):
            try c.encode("inbox.answer", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(optionId, forKey: .optionId)
            try c.encodeIfPresent(note, forKey: .note)
        }
    }
}
