import Foundation
import Observation

/// Talk list order (owner, 4 Oct): pinned chats first (in the order pinned), then chats with
/// unread messages, then the rest by most recent. Pins and read marks are this phone's own,
/// kept in UserDefaults; the server's own unread counts take over where it sends them.
@MainActor @Observable
final class TalkPrefs {
    private(set) var pinned: [String]
    private(set) var lastRead: [String: String]
    /// Unread counts the server reported (`TalkSummary.unread`), by conversation id.
    var serverUnread: [String: Int] = [:]
    private let defaults: UserDefaults
    static let pinnedKey = "talk.pinned"
    static let readKey = "talk.lastRead"

    init(defaults: UserDefaults = .standard, now: Date = Date()) {
        self.defaults = defaults
        lastRead = defaults.dictionary(forKey: Self.readKey) as? [String: String] ?? [:]
        if let p = defaults.stringArray(forKey: Self.pinnedKey) {
            pinned = p
        } else {
            // First run: the COO is pinned, as she was always first; the owner can unpin.
            pinned = ["coo"]
            defaults.set(pinned, forKey: Self.pinnedKey)
        }
        // A first run counts nothing as unread: only what arrives from now on.
        if defaults.object(forKey: "talk.readSince") == nil { defaults.set(Self.iso(now), forKey: "talk.readSince") }
    }

    var readSince: String { defaults.string(forKey: "talk.readSince") ?? "" }

    func isPinned(_ id: String) -> Bool { pinned.contains(id) }

    /// Once: the Chief of Staff joins the COO in the pins, as the list always started with both.
    func seed(chiefOfStaff: String?) {
        guard let cos = chiefOfStaff, !defaults.bool(forKey: "talk.seeded") else { return }
        defaults.set(true, forKey: "talk.seeded")
        if !pinned.contains(cos) { pinned.append(cos); defaults.set(pinned, forKey: Self.pinnedKey) }
    }

    func togglePin(_ id: String) {
        if let i = pinned.firstIndex(of: id) { pinned.remove(at: i) } else { pinned.append(id) }
        defaults.set(pinned, forKey: Self.pinnedKey)
    }

    func markRead(_ id: String, at: String = TalkPrefs.iso(Date())) {
        if let cur = lastRead[id], cur >= at { return }
        lastRead[id] = at
        serverUnread[id] = 0
        defaults.set(lastRead, forKey: Self.readKey)
    }

    /// Unread: the server's count when it gave one; else whether their last message is newer
    /// than the last time the owner opened the chat.
    func unread(_ id: String, lastFromThemAt: String?) -> Int {
        if let n = serverUnread[id] { return n }
        guard let at = lastFromThemAt else { return 0 }
        let read = max(lastRead[id] ?? "", readSince)
        return at > read ? 1 : 0
    }

    /// Pinned (pin order), then unread (newest first), then everyone else (newest first).
    static func order<T>(_ rows: [T], id: (T) -> String, lastAt: (T) -> String?, unread: (T) -> Int, pinned: [String], name: (T) -> String) -> [T] {
        func bucket(_ r: T) -> Int { pinned.contains(id(r)) ? 0 : unread(r) > 0 ? 1 : 2 }
        return rows.sorted { a, b in
            let ba = bucket(a), bb = bucket(b)
            if ba != bb { return ba < bb }
            if ba == 0 { return (pinned.firstIndex(of: id(a)) ?? 0) < (pinned.firstIndex(of: id(b)) ?? 0) }
            let la = lastAt(a) ?? "", lb = lastAt(b) ?? ""
            if la != lb { return la > lb }
            return name(a) < name(b)
        }
    }

    nonisolated static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }
}
