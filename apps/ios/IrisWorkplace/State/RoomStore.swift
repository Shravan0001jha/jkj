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
        var first = Self.plain(lines.indices.contains(firstIndex) ? lines[firstIndex] : text)
        var restLines = Array(lines.dropFirst(firstIndex + 1))
        // A heading alone ("## Plan") says nothing: carry the first content line with it.
        if first.count < 24, let next = restLines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            first += " — " + Self.plain(restLines[next])
            restLines.removeSubrange(0...next)
        }
        let rest = restLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if first.count > 160 {
            line = String(first.prefix(157)).trimmingCharacters(in: .whitespaces) + "…"
            self.details = text
        } else {
            line = first
            self.details = rest.isEmpty ? nil : rest
        }
    }

    var hasDetails: Bool { details != nil }

    /// Markdown heading and list markers off a line, for the one-line form.
    static func plain(_ line: String) -> String {
        var s = line.trimmingCharacters(in: .whitespaces)
        while s.hasPrefix("#") { s.removeFirst() }
        if s.hasPrefix("- ") || s.hasPrefix("* ") { s.removeFirst(2) }
        return s.trimmingCharacters(in: .whitespaces)
    }
}


/// Requests the owner stated: newest first, each with its status, updated live from `work.updated`
/// and the board's `status` map.
@MainActor @Observable
final class RequestsStore {
    private(set) var items: [RequestResponse] = []
    private(set) var error: String?
    private(set) var loaded = false
    /// Features updated over the socket since the list loaded.
    private(set) var features: [String: WorkItem] = [:]
    private(set) var statuses: [String: RequestStatus] = [:]

    func load(_ rest: RestClient) async {
        do {
            items = try await rest.requests()
            for r in items { statuses[r.feature.id] = r.status }
            error = nil
            loaded = true
        } catch { self.error = error.localizedDescription }
    }

    func create(_ rest: RestClient, text: String, platformIds: [String]?) async throws -> RequestResponse {
        let r = try await rest.createRequest(text: text, platformIds: platformIds)
        items.insert(r, at: 0)
        statuses[r.feature.id] = r.status
        return r
    }

    /// The board carries `status` per feature: keep the freshest.
    func absorb(_ board: FeatureBoard) {
        for (id, st) in board.status { statuses[id] = st }
    }

    func status(for featureId: String) -> RequestStatus? { statuses[featureId] }
    func latestFeature(_ f: WorkItem) -> WorkItem { features[f.id] ?? f }

    func handle(_ event: ServerEvent) {
        guard case .workUpdated(let item) = event else { return }
        if item.kind == .feature {
            features[item.id] = item
            if let i = items.firstIndex(where: { $0.feature.id == item.id }) { items[i].feature = item }
            // Until the server sends a fresh status, derive the stage from the feature state.
            if var st = statuses[item.id] {
                switch item.state {
                case .stated: st.stage = .withAsha; st.line = "Asha is writing the spec"
                case .specced: st.stage = .specced; st.line = "Spec written; routing through the map"
                case .decomposed: st.stage = .routed
                case .built: st.stage = .built; st.line = "Built; waiting for a release"
                case .released: st.stage = .released; st.line = "Released"
                default: break
                }
                statuses[item.id] = st
            }
        } else if let fid = item.featureId, var st = statuses[fid] {
            if let i = st.assignments.firstIndex(where: { $0.id == item.id }) {
                st.assignments[i].state = item.state
                st.assignments[i].stalledSince = item.stalledSince
            } else {
                st.assignments.append(RequestAssignment(id: item.id, title: item.title, employeeId: item.employeeId, charterId: item.charterId, state: item.state, stalledSince: item.stalledSince))
            }
            statuses[fid] = st
        }
    }
}
