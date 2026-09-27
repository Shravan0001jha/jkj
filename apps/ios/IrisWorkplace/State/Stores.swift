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
            self.error = error.localizedDescription
        }
    }

    func handle(_ event: ServerEvent) {
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

    var cards: [EmployeeCard] { data?.units.flatMap(\.employees) ?? [] }
    func card(_ employeeId: String) -> EmployeeCard? { cards.first { $0.employee.id == employeeId } }
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
            self.error = error.localizedDescription
        }
    }

    func handle(_ event: ServerEvent) {
        if case .inboxUpdated(let item) = event { upsert(item) }
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

    func select(_ rest: RestClient, employeeId: String) async {
        if self.employeeId != employeeId {
            self.employeeId = employeeId
            detail = nil; session = nil; log = []; error = nil
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
            self.error = error.localizedDescription
        }
    }

    /// The session Talk continues: a running or waiting one first, else the newest.
    static func currentSession(_ sessions: [Agent]) -> Agent? {
        let live = sessions.filter { $0.status == .running || $0.status == .waiting }
        if let s = live.max(by: { $0.startedAt < $1.startedAt }) { return s }
        return sessions.max(by: { $0.startedAt < $1.startedAt })
    }

    func send(_ rest: RestClient, text: String) async throws {
        guard let employeeId else { throw WorkplaceError.notPaired }
        sending = true
        defer { sending = false }
        let agent = try await rest.talk(employeeId, text: text)
        if agent.id != session?.id {
            log = (try? await rest.agentLog(agent.id)) ?? []
        }
        session = agent
        error = nil
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
            if agent.id == session?.id { session = agent }
            if let i = detail?.sessions.firstIndex(where: { $0.id == agent.id }) { detail?.sessions[i] = agent }
        case .agentLog(let entry):
            guard entry.agentId == session?.id else { return }
            if let i = log.firstIndex(where: { $0.id == entry.id }) { log[i] = entry } else { log.append(entry) }
        case .agentRemoved(let id):
            if id == session?.id { session = nil; log = [] }
        default:
            break
        }
    }

    var isRunning: Bool { session?.status == .running }
    var pendingApproval: PendingApproval? { session?.status == .waiting ? session?.approval : nil }
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
            self.error = error.localizedDescription
        }
    }

    func loadPivot(_ rest: RestClient, rows: PivotRows) async {
        do {
            pivots[rows] = try await rest.pivot(rows)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadDetail(_ rest: RestClient, id: String) async {
        do {
            details[id] = try await rest.feature(id)
            error = nil
        } catch {
            self.error = error.localizedDescription
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
        if !isActive() { notifier?.notify(a) }
    }

    func dismissBanner() { banner = nil }
    func markAllRead() { for i in alerts.indices { alerts[i].read = true } }
    func clear() { alerts = []; banner = nil }
}
