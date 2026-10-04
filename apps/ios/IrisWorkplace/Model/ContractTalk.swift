import Foundation

// Talk threads (docs/LLD-app-fixes.md on `app/fixes`, §1–§7): one thread per employee plus `coo`,
// messages with their real sender, receipts, replies, mentions, files and voice notes. Additive:
// a server without these routes answers 404 and the app keeps today's session-log chat.

enum TalkDirection: String, Codable, CaseIterable, LenientEnum {
    case `in`, out
    case unknown
}

enum TalkReceipt: String, Codable, CaseIterable, LenientEnum {
    case delivered, read
    case unknown
}

enum TalkAttachmentKind: String, Codable, CaseIterable, LenientEnum {
    case image, file, voice
    case unknown
}

struct TalkLastMessage: Codable, Equatable, Hashable {
    var id: String
    var from: String
    var fromName: String
    var text: String
}

struct TalkThread: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var employeeId: String
    var name: String
    var role: String?
    var lastMessageAt: String?
    var lastMessage: TalkLastMessage?
    var unreadCount: Int
    var lastReadAt: String?
    var pinned: Bool
    var pinnedAt: String?
    var typing: Bool
}

struct TalkAttachment: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var name: String
    var mediaType: String
    var size: Int
    var kind: TalkAttachmentKind
    var url: String
}

struct TalkReplyRef: Codable, Equatable, Hashable {
    var id: String
    var from: String
    var fromName: String
    var text: String
}

struct TalkVoice: Codable, Equatable, Hashable {
    var attachmentId: String
    var transcript: String
    var durationMs: Int?
}

struct TalkMessage: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var threadId: String
    var at: String
    var from: String
    var fromName: String
    var direction: TalkDirection
    var text: String
    var replyTo: TalkReplyRef?
    var mentions: [String]
    var attachments: [TalkAttachment]
    var voice: TalkVoice?
    var receipt: TalkReceipt?
    var deliveredAt: String?
    var readAt: String?
    var quiet: Bool?
    var agentId: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        threadId = try c.decode(String.self, forKey: .threadId)
        at = try c.decode(String.self, forKey: .at)
        from = try c.decode(String.self, forKey: .from)
        fromName = try c.decodeIfPresent(String.self, forKey: .fromName) ?? from
        direction = try c.decodeIfPresent(TalkDirection.self, forKey: .direction) ?? .unknown
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        replyTo = try c.decodeIfPresent(TalkReplyRef.self, forKey: .replyTo)
        mentions = try c.decodeIfPresent([String].self, forKey: .mentions) ?? []
        attachments = try c.decodeIfPresent([TalkAttachment].self, forKey: .attachments) ?? []
        voice = try c.decodeIfPresent(TalkVoice.self, forKey: .voice)
        receipt = try c.decodeIfPresent(TalkReceipt.self, forKey: .receipt)
        deliveredAt = try c.decodeIfPresent(String.self, forKey: .deliveredAt)
        readAt = try c.decodeIfPresent(String.self, forKey: .readAt)
        quiet = try c.decodeIfPresent(Bool.self, forKey: .quiet)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
    }

    init(id: String, threadId: String, at: String, from: String, fromName: String, direction: TalkDirection, text: String,
         replyTo: TalkReplyRef? = nil, mentions: [String] = [], attachments: [TalkAttachment] = [], voice: TalkVoice? = nil,
         receipt: TalkReceipt? = nil, quiet: Bool? = nil, agentId: String? = nil) {
        self.id = id; self.threadId = threadId; self.at = at; self.from = from; self.fromName = fromName
        self.direction = direction; self.text = text; self.replyTo = replyTo; self.mentions = mentions
        self.attachments = attachments; self.voice = voice; self.receipt = receipt; self.quiet = quiet; self.agentId = agentId
    }
}

struct SendTalkMessageRequest: Codable, Equatable {
    var text: String?
    var replyTo: String?
    var mentions: [String]?
    var attachmentIds: [String]?
}

struct SendTalkMessageResponse: Codable, Equatable {
    var message: TalkMessage
    var agent: Agent?
}

struct TalkReadRequest: Codable, Equatable { var upTo: String? }
struct TalkPinRequest: Codable, Equatable { var pinned: Bool }

enum MentionableKind: String, Codable, CaseIterable, LenientEnum {
    case employee, coo
    case unknown
}

struct Mentionable: Codable, Equatable, Hashable, Identifiable {
    var id: String
    var name: String
    var role: String?
    var kind: MentionableKind
}

extension API {
    static let talkThreads = "/api/talk/threads"
    static func talkThread(_ id: String) -> String { "/api/talk/threads/\(enc(id))" }
    static func talkMessages(_ id: String, limit: Int? = nil, before: String? = nil) -> String {
        var q: [String] = []
        if let limit { q.append("limit=\(limit)") }
        if let before { q.append("before=\(enc(before))") }
        return "/api/talk/threads/\(enc(id))/messages" + (q.isEmpty ? "" : "?" + q.joined(separator: "&"))
    }
    static func talkRead(_ id: String) -> String { "/api/talk/threads/\(enc(id))/read" }
    static func talkPin(_ id: String) -> String { "/api/talk/threads/\(enc(id))/pin" }
    static func talkAttachments(_ id: String, name: String) -> String { "/api/talk/threads/\(enc(id))/attachments?name=\(enc(name))" }
    static func talkVoice(_ id: String, name: String, durationMs: Int?, replyTo: String?) -> String {
        var p = "/api/talk/threads/\(enc(id))/voice?name=\(enc(name))"
        if let durationMs { p += "&durationMs=\(durationMs)" }
        if let replyTo { p += "&replyTo=\(enc(replyTo))" }
        return p
    }
    static let mentionable = "/api/mentionable"
}

extension RestClient {
    func talkThreads() async throws -> [TalkThread] { try await get(API.talkThreads) }
    func talkMessages(_ id: String, limit: Int? = 200, before: String? = nil) async throws -> [TalkMessage] {
        try await get(API.talkMessages(id, limit: limit, before: before))
    }
    func sendTalk(_ id: String, _ req: SendTalkMessageRequest) async throws -> SendTalkMessageResponse { try await post(API.talkMessages(id), req) }
    func readTalk(_ id: String, upTo: String? = nil) async throws -> TalkThread { try await post(API.talkRead(id), TalkReadRequest(upTo: upTo)) }
    func pinTalk(_ id: String, pinned: Bool) async throws -> TalkThread { try await post(API.talkPin(id), TalkPinRequest(pinned: pinned)) }
    func uploadTalkAttachment(_ id: String, name: String, mediaType: String, data: Data) async throws -> TalkAttachment {
        try await postRaw(API.talkAttachments(id, name: name), data, contentType: mediaType)
    }
    func sendVoice(_ id: String, name: String, durationMs: Int?, replyTo: String?, data: Data) async throws -> SendTalkMessageResponse {
        try await postRaw(API.talkVoice(id, name: name, durationMs: durationMs, replyTo: replyTo), data, contentType: "audio/mp4")
    }
    func mentionable() async throws -> [Mentionable] { try await get(API.mentionable) }
}

extension WorkplaceError {
    /// The route isn't on this server yet (an older Workplace): the feature hides, nothing breaks.
    var isNotFound: Bool { if case .server(404, _) = self { return true }; return false }
}

extension Error {
    var isNotFound: Bool { (self as? WorkplaceError)?.isNotFound ?? false }
}
