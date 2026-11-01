import Foundation

// Chat notifications, per-chat mute and the chat profile (docs/CHAT-NOTIFY-CONTRACT.md §2, §3).
// App-local until packages/shared declares them (like `metricsSnapshot`): check-contract.mjs only
// checks TypeScript → Swift. Every route here may answer 404 on a server that predates it; the
// stores then keep working on this phone (§6.5, §6.6).

/// One chat's notification setting. `mutedUntil` in the past means unmuted.
struct ChatPref: Codable, Equatable, Hashable {
    var muted: Bool
    var mutedUntil: String?

    private enum CodingKeys: String, CodingKey { case muted, mutedUntil }

    init(muted: Bool, mutedUntil: String?) { self.muted = muted; self.mutedUntil = mutedUntil }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        mutedUntil = try c.decodeIfPresent(String.self, forKey: .mutedUntil)
    }

    /// The contract's body carries `mutedUntil` always, `null` when there is none.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(muted, forKey: .muted)
        if let mutedUntil { try c.encode(mutedUntil, forKey: .mutedUntil) } else { try c.encodeNil(forKey: .mutedUntil) }
    }
}

enum SharedKind: String, Codable, CaseIterable, LenientEnum {
    case media, files, links
    case unknown

    var title: String {
        switch self {
        case .media: return "Media"
        case .files: return "Files"
        case .links: return "Links"
        case .unknown: return "Other"
        }
    }
}

/// An image, file or link shared in a chat. For a link, `url` is the link and `name` its title.
struct SharedItem: Codable, Equatable, Hashable, Identifiable {
    var kind: SharedKind
    var messageId: String
    var at: String
    var url: String?
    var attachmentId: String?
    var name: String?
    var mime: String?
    var size: Int?
    var thumbUrl: String?

    var id: String { "\(kind.rawValue):\(attachmentId ?? url ?? messageId)" }

    /// Where the file is served (the existing `GET /api/talk/attachments/:id`). Nil for a link.
    var attachmentPath: String? {
        guard kind != .links else { return nil }
        if let attachmentId { return "/api/talk/attachments/\(API.enc(attachmentId))" }
        return url
    }
}

struct SharedPage: Codable, Equatable {
    var items: [SharedItem]
    var next: String?
}

extension API {
    static let chatPrefs = "/api/chats/prefs"
    static func chatPref(_ threadId: String) -> String { "/api/chats/\(enc(threadId))/prefs" }
    static func chatShared(_ threadId: String, kind: SharedKind, before: String? = nil) -> String {
        "/api/chats/\(enc(threadId))/shared?kind=\(kind.rawValue)" + (before.map { "&before=\(enc($0))" } ?? "")
    }
}

extension RestClient {
    func chatPrefs() async throws -> [String: ChatPref] { try await get(API.chatPrefs) }
    func setChatPref(_ threadId: String, _ pref: ChatPref) async throws -> ChatPref { try await put(API.chatPref(threadId), pref) }
    func chatShared(_ threadId: String, kind: SharedKind, before: String? = nil) async throws -> SharedPage {
        try await get(API.chatShared(threadId, kind: kind, before: before))
    }
}
