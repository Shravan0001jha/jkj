import Foundation
import Observation

// The chat profile's data (CHAT-NOTIFY-CONTRACT §3, §6.6, §6.7): what was shared in a chat (from
// the server's route, or derived from the loaded messages), and the header's About block.

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// One message, reduced to what the Shared tabs need. Built from every chat's message type.
struct SharedSource: Equatable {
    let messageId: String
    let at: String
    let text: String
    let attachments: [TalkAttachment]

    init(messageId: String, at: String, text: String, attachments: [TalkAttachment]) {
        self.messageId = messageId; self.at = at; self.text = text; self.attachments = attachments
    }

    init(talk m: TalkMessage) { self.init(messageId: m.id, at: m.at, text: m.text, attachments: m.attachments) }
    init(coo m: CooMessage) {
        self.init(messageId: m.id, at: m.at, text: [m.text, m.details ?? ""].joined(separator: "\n"), attachments: m.attachments ?? [])
    }
    init(room m: RoomMessage) {
        self.init(messageId: m.id, at: m.at, text: [m.text, m.details ?? ""].joined(separator: "\n"), attachments: [])
    }
    init(log e: LogEntry) { self.init(messageId: e.id, at: e.at, text: e.text, attachments: []) }
}

/// Media / Files / Links from messages the app already has (the route's fallback).
enum SharedDerivation {
    /// Media: images and videos; files: everything else; nil for voice notes (not shown here).
    static func classify(_ a: TalkAttachment) -> SharedKind? {
        let mime = a.mediaType.lowercased()
        if a.kind == .voice || mime.hasPrefix("audio/") { return nil }
        if a.kind == .image || mime.hasPrefix("image/") || mime.hasPrefix("video/") { return .media }
        return .files
    }

    /// Newest message first; reading order inside a message; each file or link once (at its newest).
    static func items(from sources: [SharedSource], kind: SharedKind) -> [SharedItem] {
        let ordered = sources.enumerated().sorted { a, b in
            let da = Format.date(a.element.at), db = Format.date(b.element.at)
            if let da, let db, da != db { return da > db }
            if da == nil || db == nil, a.element.at != b.element.at { return a.element.at > b.element.at }
            return a.offset > b.offset
        }.map(\.element)
        var seen = Set<String>()
        var out: [SharedItem] = []
        for s in ordered {
            switch kind {
            case .media, .files:
                for a in s.attachments where classify(a) == kind && seen.insert(a.id).inserted {
                    out.append(SharedItem(kind: kind, messageId: s.messageId, at: s.at, url: a.url.nilIfEmpty ?? "/api/talk/attachments/\(API.enc(a.id))",
                                          attachmentId: a.id, name: a.name, mime: a.mediaType, size: a.size))
                }
            case .links:
                for l in links(in: s.text) where seen.insert(normalized(l.url)).inserted {
                    out.append(SharedItem(kind: .links, messageId: s.messageId, at: s.at, url: l.url, name: l.title ?? host(l.url)))
                }
            case .unknown:
                break
            }
        }
        return out
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    private static let markdownLink = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/

    /// http(s) links in reading order, with a Markdown title when the text gave one.
    static func links(in text: String) -> [(url: String, title: String?)] {
        guard !text.isEmpty, let detector else { return [] }
        var titles: [String: String] = [:]
        for m in text.matches(of: markdownLink) { titles[normalized(String(m.output.2))] = String(m.output.1) }
        let ns = text as NSString
        var out: [(String, String?)] = []
        for r in detector.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let url = r.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { continue }
            // The literal text, so the owner sees what was written (the detector may add a scheme).
            var raw = ns.substring(with: r.range)
            if !raw.lowercased().hasPrefix("http") { raw = url.absoluteString }
            while let last = raw.last, ".,;:!?".contains(last) { raw.removeLast() }
            out.append((raw, titles[normalized(raw)]))
        }
        return out
    }

    /// For de-duplication: scheme and host lower-cased, no trailing slash. The fragment stays: the
    /// web app's routes live there (`#/plan`, `#/item/…`).
    static func normalized(_ raw: String) -> String {
        guard var c = URLComponents(string: raw) else { return raw.lowercased() }
        c.scheme = c.scheme?.lowercased()
        c.host = c.host?.lowercased()
        var s = c.string ?? raw
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    static func host(_ raw: String) -> String {
        guard let h = URL(string: raw)?.host?.lowercased() else { return raw }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }
}

/// One profile's Shared tabs: the server's pages, or the derived list ("Showing recent").
@MainActor @Observable
final class ChatSharedStore {
    struct TabState: Equatable {
        var items: [SharedItem] = []
        var next: String?
        var loading = false
        var loaded = false
        /// Derived from the loaded messages: the route is not on this server yet.
        var derived = false
        var error: String?
        var hasMore: Bool { next != nil && !derived }
    }

    let threadId: String
    private(set) var tabs: [SharedKind: TabState] = [:]
    /// False once the route answered 404: the other tabs derive without asking again.
    private(set) var routeAvailable: Bool?

    init(threadId: String) { self.threadId = threadId }

    func state(_ kind: SharedKind) -> TabState { tabs[kind] ?? TabState() }

    func load(_ rest: RestClient?, kind: SharedKind, sources: () -> [SharedSource]) async {
        var t = state(kind)
        guard !t.loading else { return }
        guard let rest, routeAvailable != false else {
            derive(kind, sources: sources())
            return
        }
        t.loading = true
        tabs[kind] = t
        do {
            let page = try await rest.chatShared(threadId, kind: kind)
            routeAvailable = true
            tabs[kind] = TabState(items: page.items.filter { $0.kind == kind }, next: page.next, loaded: true)
        } catch {
            if error.isNotFound { routeAvailable = false }
            derive(kind, sources: sources(), error: error.isNotFound ? nil : error.userMessage)
        }
    }

    func loadMore(_ rest: RestClient?, kind: SharedKind) async {
        var t = state(kind)
        guard let rest, let cursor = t.next, !t.loading, !t.derived else { return }
        t.loading = true
        tabs[kind] = t
        do {
            let page = try await rest.chatShared(threadId, kind: kind, before: cursor)
            t.items += page.items.filter { $0.kind == kind && !t.items.map(\.id).contains($0.id) }
            t.next = page.next
            t.error = nil
        } catch {
            t.error = error.userMessage
        }
        t.loading = false
        tabs[kind] = t
    }

    private func derive(_ kind: SharedKind, sources: [SharedSource], error: String? = nil) {
        tabs[kind] = TabState(items: SharedDerivation.items(from: sources, kind: kind), loaded: true, derived: true, error: error)
    }
}

/// The profile's header and About rows (pure, so it is tested without a screen).
struct ChatProfileInfo: Equatable {
    enum Kind: Equatable { case coo, employee, room }
    struct Fact: Equatable, Hashable { let label: String; let value: String }

    var kind: Kind
    var name: String
    var subtitle: String
    var about: String?
    var facts: [Fact]
    var online: Bool?

    func value(_ label: String) -> String? { facts.first { $0.label == label }?.value }

    static let cooName = "Claude — COO"
    static let cooAbout = "Your COO: runs the Workplace, routes work, reports to you."

    static func coo(presence: CooPresence?, name: String = cooName, now: Date = Date()) -> ChatProfileInfo {
        let seen = presence?.lastHeartbeat.map { Format.ago($0, now: now) }
        let status = presence.map { $0.online ? "Online" : "Offline" } ?? "—"
        let subtitle: String
        switch presence?.online {
        case true?: subtitle = "Online"
        case false?: subtitle = "Offline" + (seen.map { " · last seen \($0)" } ?? "")
        case nil: subtitle = " "
        }
        return ChatProfileInfo(kind: .coo, name: name, subtitle: subtitle, about: cooAbout,
                               facts: [Fact(label: "Status", value: status),
                                       Fact(label: "Reports to", value: "You"),
                                       Fact(label: "Last heartbeat", value: seen ?? "—")],
                               online: presence?.online)
    }

    static func employee(id: String, detail: EmployeeDetail?, card: EmployeeCard?, nameOf: (String?) -> String) -> ChatProfileInfo {
        let e = detail?.employee ?? card?.employee
        let charters = (detail?.charters ?? card?.charters ?? []).map(\.title)
        let sessions = (detail?.sessions ?? []) + (card?.session.map { [$0] } ?? [])
        let model = sessions.max { $0.startedAt < $1.startedAt }?.model
        let state = e?.state.glyph.label
        return ChatProfileInfo(
            kind: .employee,
            name: e?.name ?? id,
            subtitle: state ?? " ",
            about: e?.stateReason?.nilIfEmpty,
            facts: [
                Fact(label: "Role", value: roleTitle(e?.roleId ?? "")),
                Fact(label: "Areas", value: charters.joined(separator: ", ").nilIfEmpty ?? "—"),
                Fact(label: "Reports to", value: e?.reportsTo.map { nameOf($0) } ?? "—"),
                Fact(label: "Model", value: model?.nilIfEmpty ?? "—"),
                Fact(label: "State", value: state ?? "—"),
            ],
            online: card.map { c in c.session.map { $0.status == .running || $0.status == .waiting } ?? false })
    }

    static func room(_ t: RoomThread?, id: String, nameOf: (String?) -> String) -> ChatProfileInfo {
        let people = (t?.participants ?? []).filter { $0 != "workplace" }
        return ChatProfileInfo(
            kind: .room,
            name: t?.title ?? "Thread",
            subtitle: t == nil ? " " : "\(people.count) member\(people.count == 1 ? "" : "s")",
            about: t.flatMap { $0.headline.nilIfEmpty == $0.title ? nil : $0.headline.nilIfEmpty },
            facts: [
                Fact(label: "Members", value: people.map { nameOf($0) }.joined(separator: ", ").nilIfEmpty ?? "—"),
                Fact(label: "State", value: t.map { $0.state == .resolved ? "Resolved" : "Open" } ?? "—"),
            ],
            online: nil)
    }

    /// `chief-of-staff` → "Chief of staff"; short ids (qa, coo) in capitals.
    static func roleTitle(_ roleId: String) -> String {
        guard !roleId.isEmpty else { return "—" }
        if roleId.count <= 3 { return roleId.uppercased() }
        let words = roleId.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}
