import Foundation
import Observation

/// The Team Room: threads with one-line status, a thread's messages, posting as the owner,
/// live updates from `room.thread` and `room.message`.
@MainActor @Observable
final class RoomStore {
    private(set) var threads: [RoomThread] = []
    private(set) var messages: [String: [RoomMessage]] = [:]
    private(set) var error: String?
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var posting: Set<String> = []
    /// Threads with messages the owner has not opened since they arrived.
    private(set) var unread: Set<String> = []

    var open: [RoomThread] { threads.filter { $0.state == .open } }
    var resolved: [RoomThread] { threads.filter { $0.state == .resolved } }

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            threads = Self.sorted(try await rest.room().threads)
            error = nil
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadThread(_ rest: RestClient, id: String) async {
        do {
            let d = try await rest.roomThread(id)
            upsert(d.thread)
            messages[id] = d.messages.sorted { $0.at < $1.at }
            unread.remove(id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Post as the owner. The message shows only when the server returns it (act, then ack).
    func post(_ rest: RestClient, threadId: String, text: String, mentions: [String]) async throws {
        posting.insert(threadId)
        defer { posting.remove(threadId) }
        let m = try await rest.postMessage(threadId, text: text, mentions: mentions)
        append(m)
    }

    func create(_ rest: RestClient, title: String, text: String, mentions: [String]) async throws -> RoomThread {
        let d = try await rest.createThread(title: title, text: text, mentions: mentions)
        upsert(d.thread)
        messages[d.thread.id] = d.messages
        return d.thread
    }

    func resolve(_ rest: RestClient, threadId: String, summary: String) async throws {
        upsert(try await rest.resolveThread(threadId, summary: summary))
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .roomThread(let t):
            upsert(t)
        case .roomMessage(let m, let t):
            upsert(t)
            if append(m), !m.owner { unread.insert(m.threadId) }
        default:
            break
        }
    }

    func markRead(_ id: String) { unread.remove(id) }
    func thread(_ id: String) -> RoomThread? { threads.first { $0.id == id } }

    /// Employee ids mentioned as `@id` in the text, in order, without duplicates.
    static func mentions(in text: String, known: [String]) -> [String] {
        var out: [String] = []
        for match in text.matches(of: /@([A-Za-z0-9_-]+)/) {
            let id = String(match.1).lowercased()
            if known.contains(id), !out.contains(id) { out.append(id) }
        }
        return out
    }

    @discardableResult
    private func append(_ m: RoomMessage) -> Bool {
        var list = messages[m.threadId] ?? []
        guard !list.contains(where: { $0.id == m.id }) else { return false }
        list.append(m)
        messages[m.threadId] = list.sorted { $0.at < $1.at }
        return true
    }

    private func upsert(_ t: RoomThread) {
        if let i = threads.firstIndex(where: { $0.id == t.id }) { threads[i] = t } else { threads.append(t) }
        threads = Self.sorted(threads)
    }

    static func sorted(_ threads: [RoomThread]) -> [RoomThread] {
        threads.sorted { a, b in
            if (a.state == .open) != (b.state == .open) { return a.state == .open }
            return a.lastAt > b.lastAt
        }
    }
}

/// Compact messages: one line by default, the rest on demand. Until the server sends
/// `summary`/`details`, the first non-empty line is the summary and the remainder the details.
struct CompactText: Equatable {
    let line: String
    let details: String?

    init(text: String, summary: String? = nil, details: String? = nil) {
        if let summary, !summary.trimmingCharacters(in: .whitespaces).isEmpty {
            line = summary
            let rest = details ?? (text == summary ? nil : text)
            self.details = rest?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? rest : nil
            return
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { String($0) }
        let firstIndex = lines.firstIndex { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? 0
        let first = lines.indices.contains(firstIndex) ? lines[firstIndex] : text
        let rest = lines.dropFirst(firstIndex + 1).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if first.count > 160 {
            line = String(first.prefix(157)).trimmingCharacters(in: .whitespaces) + "…"
            self.details = text
        } else {
            line = first
            self.details = rest.isEmpty ? nil : rest
        }
    }

    var hasDetails: Bool { details != nil }
}
