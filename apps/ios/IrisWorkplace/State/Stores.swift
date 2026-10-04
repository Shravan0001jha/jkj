import Foundation
import Observation

// One store per screen. Each exposes `load()` for the first load and pull-to-refresh, and
// `handle(_:)` for socket events, so live updates and loads share one code path and the stores
// can be tested by feeding them events without a network.

// MARK: - Office

@MainActor @Observable
final class OfficeStore {
    private(set) var data: OfficeResponse?
    private(set) var error: String?
    private(set) var loading = false
    private(set) var loadedAt: Date?

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            data = try await rest.office()
            error = nil
            loadedAt = Date()
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        if case .officeSnapshot(let office) = event {
            // Sent once per socket connect: the whole Office, fresher than any REST load in flight.
            data = office
            error = nil
            loadedAt = Date()
            return
        }
        guard var d = data else { return }
        switch event {
        case .officeUpdated(let card):
            var placed = false
            for u in d.units.indices {
                if let i = d.units[u].employees.firstIndex(where: { $0.employee.id == card.employee.id }) {
                    if d.units[u].unit.id == card.employee.unitId {
                        d.units[u].employees[i] = card
                        placed = true
                    } else {
                        d.units[u].employees.remove(at: i)
                    }
                }
            }
            if !placed, let u = d.units.firstIndex(where: { $0.unit.id == card.employee.unitId }) {
                d.units[u].employees.append(card)
            }
            d.needsYou = d.units.flatMap(\.employees).reduce(0) { $0 + $1.needsYou }
            data = d
        case .spendUpdated(let summary):
            d.spend = summary
            data = d
        default:
            break
        }
    }

    func setNeedsYou(_ n: Int) {
        data?.needsYou = n
    }

    /// Every card, the COO's included — she lives in her unit's list like anyone else, flagged by
    /// `employee.virtual`.
    var cards: [EmployeeCard] { data?.units.flatMap(\.employees) ?? [] }
    func card(_ employeeId: String) -> EmployeeCard? { cards.first { $0.employee.id == employeeId } }
    /// The COO's card, wherever her unit places her.
    var coo: EmployeeCard? { cards.first { $0.employee.virtual == true } }
}

// MARK: - Inbox

@MainActor @Observable
final class InboxStore {
    private(set) var items: [InboxItem] = []
    private(set) var error: String?
    private(set) var loading = false
    private(set) var loaded = false
    /// Ids whose answer is in flight; the buttons are disabled meanwhile.
    private(set) var answering: Set<String> = []
    /// v2: each item's conversation (GET /api/inbox/:id), oldest first.
    private(set) var messages: [String: [InboxMessage]] = [:]
    private(set) var threadErrors: [String: String] = [:]
    /// Ids whose free-text reply is in flight.
    private(set) var replying: Set<String> = []

    var open: [InboxItem] { items.filter { $0.state == .open } }
    var closed: [InboxItem] { items.filter { $0.state != .open } }

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            items = Self.sorted(try await rest.inbox())
            error = nil
            loaded = true
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .inboxUpdated(let item): upsert(item)
        case .inboxMessage(let m): append(m)
        default: break
        }
    }

    /// v2: the item with its conversation.
    func loadThread(_ rest: RestClient, id: String) async {
        do {
            let t = try await rest.inboxThread(id)
            upsert(t.item)
            messages[id] = t.messages.sorted { $0.at < $1.at }
            threadErrors[id] = nil
        } catch {
            if let m = error.userMessage { threadErrors[id] = m }
        }
    }

    /// v2: a free-text reply. Text alone leaves the item open; the asker answers in the thread.
    func reply(_ rest: RestClient, id: String, text: String) async throws {
        replying.insert(id)
        defer { replying.remove(id) }
        let t = try await rest.inboxReply(id, text: text, optionId: nil)
        upsert(t.item)
        let known = Set((messages[id] ?? []).map(\.id))
        messages[id] = ((messages[id] ?? []) + t.messages.filter { !known.contains($0.id) }).sorted { $0.at < $1.at }
    }

    private func append(_ m: InboxMessage) {
        var list = messages[m.inboxId] ?? []
        guard !list.contains(where: { $0.id == m.id }) else { return }
        list.append(m)
        messages[m.inboxId] = list.sorted { $0.at < $1.at }
    }

    /// Act, then acknowledge: the item flips only when the server said so.
    func answer(_ rest: RestClient, id: String, optionId: String, note: String?) async throws {
        answering.insert(id)
        defer { answering.remove(id) }
        let updated = try await rest.answer(inbox: id, optionId: optionId, note: note)
        upsert(updated)
    }

    func item(_ id: String) -> InboxItem? { items.first { $0.id == id } }

    private func upsert(_ item: InboxItem) {
        if let i = items.firstIndex(where: { $0.id == item.id }) { items[i] = item } else { items.append(item) }
        items = Self.sorted(items)
    }

    static func sorted(_ items: [InboxItem]) -> [InboxItem] {
        items.sorted { a, b in
            if (a.state == .open) != (b.state == .open) { return a.state == .open }
            return a.createdAt > b.createdAt
        }
    }
}

// MARK: - Talk

@MainActor @Observable
final class TalkStore {
    private(set) var employeeId: String?
    private(set) var detail: EmployeeDetail?
    private(set) var session: Agent?
    private(set) var log: [LogEntry] = []
    private(set) var error: String?
    private(set) var loading = false
    private(set) var sending = false
    /// The owner sent a message here and no reply has landed yet. Typing shows only then — never
    /// from the employee's working state or an open session (owner bug, 2 Oct) — and at most for
    /// `typingTimeout`.
    private(set) var replyPendingSince: Date?
    static let typingTimeout: TimeInterval = 120
    private var typingTimer: Task<Void, Never>?

    func isTyping(now: Date = Date()) -> Bool {
        guard let since = replyPendingSince else { return false }
        return now.timeIntervalSince(since) < Self.typingTimeout
    }

    private func replyPending(_ on: Bool) {
        typingTimer?.cancel()
        replyPendingSince = on ? Date() : nil
        guard on else { return }
        typingTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.typingTimeout))
            guard !Task.isCancelled else { return }
            self?.replyPendingSince = nil
        }
    }

    func select(_ rest: RestClient, employeeId: String) async {
        if self.employeeId != employeeId {
            self.employeeId = employeeId
            detail = nil; session = nil; log = []; error = nil
            replyPending(false)
        }
        await reload(rest)
    }

    /// Back to the picker. The session keeps running on the Mac; only the view forgets it.
    func clear() {
        employeeId = nil; detail = nil; session = nil; log = []; error = nil
    }

    func reload(_ rest: RestClient) async {
        guard let employeeId else { return }
        loading = true
        defer { loading = false }
        do {
            let d = try await rest.employee(employeeId)
            detail = d
            error = nil
            let chosen = Self.currentSession(d.sessions)
            if chosen?.id != session?.id { log = [] }
            session = chosen
            if let chosen { log = try await rest.agentLog(chosen.id) }
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    /// The session Talk continues: a running or waiting one first, else the newest.
    static func currentSession(_ sessions: [Agent]) -> Agent? {
        let live = sessions.filter { $0.status == .running || $0.status == .waiting }
        if let s = live.max(by: { $0.startedAt < $1.startedAt }) { return s }
        return sessions.max(by: { $0.startedAt < $1.startedAt })
    }

    func send(_ rest: RestClient, text: String, attachments: [OutgoingAttachment] = []) async throws {
        guard let employeeId else { throw WorkplaceError.notPaired }
        sending = true
        defer { sending = false }
        let agent = try await rest.talk(employeeId, text: text, attachments: attachments.isEmpty ? nil : attachments.map(\.wire))
        if agent.id != session?.id {
            log = (try? await rest.agentLog(agent.id)) ?? []
        }
        session = agent
        error = nil
        replyPending(true)
    }

    /// A Talk-thread send started or continued a session: follow it for approvals and Interrupt.
    func adopt(_ rest: RestClient, agent: Agent) async {
        if agent.id != session?.id { log = (try? await rest.agentLog(agent.id)) ?? [] }
        session = agent
    }

    func interrupt(_ rest: RestClient) async throws {
        guard let session else { return }
        try await rest.interrupt(agent: session.id)
    }

    func endSession(_ rest: RestClient) async throws {
        guard let employeeId else { return }
        try await rest.endSession(employeeId)
        await reload(rest)
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .agentUpdated(let agent):
            if agent.id == session?.id {
                session = agent
                // The run ended or stopped to ask: no reply is coming right now.
                if agent.status != .running { replyPending(false) }
            }
            if let i = detail?.sessions.firstIndex(where: { $0.id == agent.id }) { detail?.sessions[i] = agent }
        case .agentLog(let entry):
            guard entry.agentId == session?.id else { return }
            if let i = log.firstIndex(where: { $0.id == entry.id }) { log[i] = entry } else { log.append(entry) }
            // The reply landed (or the run failed): stop typing.
            if entry.kind == .assistant || entry.kind == .error { replyPending(false) }
        case .agentRemoved(let id):
            if id == session?.id { session = nil; log = [] }
        case .inboxUpdated(let item):
            // The employee page's Needs you: answered anywhere → gone here; new and relevant → shown.
            guard var d = detail else { return }
            let relevant = item.raisedBy == d.employee.id || item.affects.contains(d.employee.id)
            d.needsYou.removeAll { $0.id == item.id }
            if item.state == .open, relevant { d.needsYou.insert(item, at: 0) }
            detail = d
        default:
            break
        }
    }

    var isRunning: Bool { session?.status == .running }
    var pendingApproval: PendingApproval? { session?.status == .waiting ? session?.approval : nil }

    /// The chat view of `log` (`ChatView.collapse`, a Swift port of `@jkj/shared/chat-view.ts`'s
    /// `toChatView`): still correct as raw entries stream in over the socket while a session runs.
    var chatLog: [LogEntry] { ChatView.collapse(log) }
}

// MARK: - Features

@MainActor @Observable
final class FeaturesStore {
    private(set) var board: FeatureBoard?
    private(set) var pivots: [PivotRows: Pivot] = [:]
    private(set) var details: [String: FeatureDetail] = [:]
    private(set) var error: String?
    private(set) var loading = false

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            board = try await rest.features()
            error = nil
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func loadPivot(_ rest: RestClient, rows: PivotRows) async {
        do {
            pivots[rows] = try await rest.pivot(rows)
            error = nil
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func loadDetail(_ rest: RestClient, id: String) async {
        do {
            details[id] = try await rest.feature(id)
            error = nil
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        guard case .workUpdated(let item) = event else { return }
        if item.kind == .feature, var b = board {
            if let i = b.features.firstIndex(where: { $0.id == item.id }) { b.features[i] = item } else { b.features.append(item) }
            b.byState = Dictionary(grouping: b.features, by: { $0.state.rawValue }).mapValues(\.count)
            board = b
            details[item.id]?.feature = item
        } else if let fid = item.featureId, var d = details[fid] {
            if let i = d.assignments.firstIndex(where: { $0.id == item.id }) { d.assignments[i] = item } else { d.assignments.append(item) }
            details[fid] = d
        }
    }

    /// Features grouped in the order of the feature state machine.
    var byState: [(state: WorkState, features: [WorkItem])] {
        guard let board else { return [] }
        return WorkState.featureStates.compactMap { s in
            let fs = board.features.filter { $0.state == s }
            return fs.isEmpty ? nil : (s, fs)
        }
    }
}

// MARK: - Alerts

struct ReceivedAlert: Identifiable, Equatable {
    let id: UUID
    let event: AlertEvent
    let at: Date
    var read: Bool
}

/// Schedules the local notification; a fake in tests.
protocol Notifier: AnyObject {
    func notify(_ alert: AlertEvent)
}

@MainActor @Observable
final class AlertsStore {
    private(set) var alerts: [ReceivedAlert] = []
    /// The banner shown on top of the current screen.
    private(set) var banner: ReceivedAlert?
    var unread: Int { alerts.filter { !$0.read }.count }

    private let notifier: Notifier?
    /// Is the app on screen? When not, an alert also becomes a local notification.
    var isActive: () -> Bool = { true }
    /// True once pushes are registered: the relay's push covers it, so no local notification.
    var suppressLocal: () -> Bool = { false }
    private var dismissTask: Task<Void, Never>?

    init(notifier: Notifier? = nil) {
        self.notifier = notifier
    }

    func handle(_ event: ServerEvent) {
        guard case .alert(let a) = event else { return }
        let r = ReceivedAlert(id: UUID(), event: a, at: Date(), read: false)
        alerts.insert(r, at: 0)
        if alerts.count > 200 { alerts.removeLast(alerts.count - 200) }
        banner = r
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            if self?.banner?.id == r.id { self?.banner = nil }
        }
        if !isActive(), !suppressLocal() { notifier?.notify(a) }
    }

    /// Did the socket show this item or thread in the last minute? A push for it is then a duplicate.
    func recentlyShown(inboxId: String?, threadId: String?, within: TimeInterval = 60, now: Date = Date()) -> Bool {
        guard inboxId != nil || threadId != nil else { return false }
        return alerts.contains { r in
            now.timeIntervalSince(r.at) <= within && inboxId != nil && r.event.inboxId == inboxId
        }
    }

    func dismissBanner() { banner = nil }
    func markAllRead() { for i in alerts.indices { alerts[i].read = true } }
    func clear() { alerts = []; banner = nil }
}

// MARK: - The COO bridge

/// The owner's Talk with "Claude — COO": not a session (no tool calls, no thinking, no mirroring)
/// — only what the owner sent and what the lead replied through `POST /api/coo/reply`.
/// `log`/`message`/`presence` reach the phone over the normal session, like anything else;
/// `coo.message` arrives live to every authenticated socket. `coo.presence` is not in the
/// contract yet, so presence is polled (`pollPresence`) rather than pushed.
@MainActor @Observable
final class CooStore {
    private(set) var log: [CooMessage] = []
    private(set) var presence: CooPresence?
    private(set) var error: String?
    private(set) var loading = false
    private(set) var sending = false
    private(set) var loaded = false
    private var pollTask: Task<Void, Never>?
    /// Same rule as Talk: typing only while a reply to the owner's message is pending, at most 2 min.
    private(set) var replyPendingSince: Date?
    private var typingTimer: Task<Void, Never>?

    func isTyping(now: Date = Date()) -> Bool {
        guard let since = replyPendingSince else { return false }
        return now.timeIntervalSince(since) < TalkStore.typingTimeout
    }

    private func replyPending(_ on: Bool) {
        typingTimer?.cancel()
        replyPendingSince = on ? Date() : nil
        guard on else { return }
        typingTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(TalkStore.typingTimeout))
            guard !Task.isCancelled else { return }
            self?.replyPendingSince = nil
        }
    }

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            log = try await rest.cooLog()
            error = nil
            loaded = true
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func send(_ rest: RestClient, text: String) async throws {
        sending = true
        defer { sending = false }
        let m = try await rest.cooMessage(text)
        append(m)
        replyPending(true)
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .cooMessage(let m):
            append(m)
            if m.from == .coo { replyPending(false) }
        case .cooPresence(let p): presence = p
        default: break
        }
    }

    /// Live on an online↔offline flip (`coo.presence`); polled too, so a fresh screen isn't stuck
    /// on a stale flip that happened before it opened.
    func pollPresence(_ rest: RestClient, every seconds: TimeInterval = 30) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                if let p = try? await rest.cooPresence() { self?.presence = p }
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    func stopPolling() { pollTask?.cancel(); pollTask = nil }

    private func append(_ m: CooMessage) {
        guard !log.contains(where: { $0.id == m.id }) else { return }
        log.append(m)
        log.sort { $0.at < $1.at }
    }
}
