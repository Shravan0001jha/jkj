import Foundation
import Observation

// docs/THEMES.md §3 — the logic behind the Sci-fi CX. Pure values (and one small @Observable for
// the undo window), so each piece is unit-tested without a view.

// MARK: - Since you last looked

/// What the owner saw last time: counts by state, open decisions, blocked work, recent updates.
struct BridgeSnapshot: Codable, Equatable {
    var at: Date
    var counts: [String: Int]
    var openInboxIds: [String]
    var blockedIds: [String]
    /// Newest first, at most 200.
    var updateIds: [String]

    static func capture(plan: PlanResponse?, open: [InboxItem], updates: [Update], at: Date) -> BridgeSnapshot {
        let epics = (plan?.areas.flatMap(\.epics) ?? []) + (plan?.unfiled ?? [])
        let blocked = Set(epics.flatMap { $0.flags.filter { $0.kind == .blocked }.map(\.itemId) })
        return BridgeSnapshot(at: at, counts: plan?.counts ?? [:], openInboxIds: open.map(\.id),
                              blockedIds: blocked.sorted(), updateIds: Array(updates.prefix(200).map(\.id)))
    }
}

struct BridgeDigest: Equatable {
    var since: Date
    var newlyDone = 0
    var newlyBlocked = 0
    var unblocked = 0
    var newDecisions = 0
    var resolved = 0
    var updates = 0

    var isEmpty: Bool { lines.isEmpty }

    var lines: [String] {
        func n(_ v: Int, _ one: String, _ many: String) -> String? { v > 0 ? "\(v) \(v == 1 ? one : many)" : nil }
        return [newlyDone > 0 ? "+\(newlyDone) done" : nil,
                n(newlyBlocked, "newly blocked", "newly blocked"),
                n(unblocked, "unblocked", "unblocked"),
                n(newDecisions, "new decision", "new decisions"),
                n(resolved, "resolved", "resolved"),
                n(updates, "update", "updates")].compactMap { $0 }
    }

    /// nil on the first look (nothing to compare with).
    static func diff(from old: BridgeSnapshot?, to new: BridgeSnapshot) -> BridgeDigest? {
        guard let old else { return nil }
        var d = BridgeDigest(since: old.at)
        d.newlyDone = max(0, (new.counts["done"] ?? 0) - (old.counts["done"] ?? 0))
        let ob = Set(old.blockedIds), nb = Set(new.blockedIds)
        d.newlyBlocked = nb.subtracting(ob).count
        d.unblocked = ob.subtracting(nb).count
        let oi = Set(old.openInboxIds), ni = Set(new.openInboxIds)
        d.newDecisions = ni.subtracting(oi).count
        d.resolved = oi.subtracting(ni).count
        let seen = Set(old.updateIds)
        // Updates newer than the newest one seen; when that one is out of the window, count unseen ids.
        if let first = old.updateIds.first, let idx = new.updateIds.firstIndex(of: first) {
            d.updates = idx
        } else {
            d.updates = new.updateIds.filter { !seen.contains($0) }.count
        }
        return d
    }
}

struct BridgeSnapshotStore {
    static let key = "iris.bridge.snapshot"
    let defaults: UserDefaults

    func load() -> BridgeSnapshot? {
        defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(BridgeSnapshot.self, from: $0) }
    }
    func save(_ s: BridgeSnapshot) {
        if let d = try? JSONEncoder().encode(s) { defaults.set(d, forKey: Self.key) }
    }
}

// MARK: - Decision queue

/// Open Inbox items as a queue: raised urgency first, then oldest; the owner's own order (a
/// deferred card moves to the back) survives refreshes; answered items drop out.
struct DecisionQueue: Equatable {
    private(set) var order: [String] = []

    var top: String? { order.first }

    mutating func sync(open: [InboxItem]) {
        let ids = Set(open.map(\.id))
        let kept = order.filter(ids.contains)
        let fresh = open.enumerated().filter { !kept.contains($0.element.id) }
            .sorted { Self.before($0.element, $1.element) ?? ($0.offset < $1.offset) }.map(\.element.id)
        order = kept.isEmpty ? fresh : kept + fresh
    }

    mutating func `defer`(_ id: String) {
        guard let i = order.firstIndex(of: id) else { return }
        order.append(order.remove(at: i))
    }

    private static func rank(_ u: InboxUrgency?) -> Int {
        switch u { case .urgent?: return 0; case .high?: return 1; default: return 2 }
    }
    /// nil: a tie (the server's order decides).
    private static func before(_ a: InboxItem, _ b: InboxItem) -> Bool? {
        let (ra, rb) = (rank(a.urgency), rank(b.urgency))
        if ra != rb { return ra < rb }
        return a.createdAt == b.createdAt ? nil : a.createdAt < b.createdAt
    }

    /// The option a swipe may run: the recommended one, and only when it neither confirms (danger)
    /// nor asks for a note. Anything else is a tap on a button.
    static func swipeOption(_ item: InboxItem) -> InboxOption? {
        guard item.state == .open, let o = item.options.first(where: { $0.recommended == true }),
              o.danger != true, o.needsNote != true else { return nil }
        return o
    }
}

/// The undo window: an answer waits `window` seconds before it is sent; Undo drops it. Going to
/// the background sends what is waiting (the owner meant it).
@MainActor @Observable
final class DecisionStager {
    struct Pending: Identifiable, Equatable {
        var id: String { itemId }
        let itemId: String
        let title: String
        let option: InboxOption
        let note: String?
        let token: UUID
    }

    private(set) var pending: [Pending] = []
    let window: TimeInterval
    @ObservationIgnored private let send: (Pending) async -> Void

    init(window: TimeInterval = 4, send: @escaping (Pending) async -> Void) {
        self.window = window
        self.send = send
    }

    func isStaged(_ itemId: String) -> Bool { pending.contains { $0.itemId == itemId } }

    func stage(item: InboxItem, option: InboxOption, note: String?) {
        let p = Pending(itemId: item.id, title: item.title, option: option, note: note, token: UUID())
        pending.removeAll { $0.itemId == item.id }
        pending.append(p)
        let window = window
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(window))
            await self?.commit(p.itemId, token: p.token)
        }
    }

    func undo(_ itemId: String) { pending.removeAll { $0.itemId == itemId } }

    func commitAll() async {
        for p in pending { await commit(p.itemId, token: p.token) }
    }

    private func commit(_ itemId: String, token: UUID) async {
        guard let i = pending.firstIndex(where: { $0.itemId == itemId && $0.token == token }) else { return }
        let p = pending.remove(at: i)
        await send(p)
    }
}

// MARK: - Command palette

enum CommandAction: Equatable, Hashable {
    case settings, spend, alerts, office, releases, newRequest, features, board
    case theme(ThemeID)

    var title: String {
        switch self {
        case .settings: return "Open Settings"
        case .spend: return "Spend today"
        case .alerts: return "Alerts"
        case .office: return "Office"
        case .releases: return "Ship a release"
        case .newRequest: return "New request to Asha"
        case .features: return "Features (v1)"
        case .board: return "Plan board"
        case .theme(let id): return "Switch theme to \(Theme.with(id).name)"
        }
    }
    var symbol: String {
        switch self {
        case .settings: return "gearshape"
        case .spend: return "indianrupeesign.circle"
        case .alerts: return "bell"
        case .office: return "building.2"
        case .releases: return "shippingbox"
        case .newRequest: return "text.bubble"
        case .features: return "square.grid.2x2"
        case .board: return "rectangle.split.3x1"
        case .theme: return "paintpalette"
        }
    }
}

enum CommandTarget: Equatable, Hashable {
    case item(String), inbox(String), talk(String), room(String), action(CommandAction)
}

struct CommandEntry: Identifiable, Equatable {
    /// Tiebreak order when scores are equal (lower first).
    enum Kind: Int, Comparable, CaseIterable {
        case person, inbox, epic, story, task, room, action
        static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }
        var label: String {
            switch self {
            case .person: return "Person"
            case .inbox: return "Decision"
            case .epic: return "Epic"
            case .story: return "Story"
            case .task: return "Task"
            case .room: return "Room"
            case .action: return "Action"
            }
        }
    }
    let id: String
    let kind: Kind
    let title: String
    let subtitle: String?
    let target: CommandTarget
}

enum CommandSearch {
    private static func norm(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespaces)
    }

    /// exact 1000 > prefix 800 > word prefix 600 > substring 400 > subsequence ≤ 200; nil: no match.
    static func score(_ query: String, _ text: String) -> Int? {
        let q = norm(query), t = norm(text)
        guard !q.isEmpty else { return 0 }
        if t == q { return 1000 }
        if t.hasPrefix(q) { return 800 }
        let words = t.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        if words.contains(where: { $0.hasPrefix(q) }) { return 600 }
        if t.contains(q) { return 400 }
        // Subsequence: every query character in order; fewer gaps score higher.
        var ti = t.startIndex, gaps = 0, last: String.Index?
        for c in q {
            guard let found = t[ti...].firstIndex(of: c) else { return nil }
            if let l = last, t.index(after: l) != found { gaps += 1 }
            last = found; ti = t.index(after: found)
        }
        return max(1, 200 - gaps * 10)
    }

    static func rank(_ query: String, _ entries: [CommandEntry], limit: Int = 30) -> [CommandEntry] {
        if norm(query).isEmpty { return Array(entries.prefix(limit)) }
        let scored = entries.compactMap { e -> (CommandEntry, Int)? in
            let s = max(score(query, e.title) ?? -1, (e.subtitle.flatMap { score(query, $0) }).map { $0 / 2 } ?? -1)
            return s > 0 ? (e, s) : nil
        }
        return scored.sorted { a, b in
            if a.1 != b.1 { return a.1 > b.1 }
            if a.0.title.count != b.0.title.count { return a.0.title.count < b.0.title.count }
            if a.0.kind != b.0.kind { return a.0.kind < b.0.kind }
            return a.0.title < b.0.title
        }.prefix(limit).map(\.0)
    }

    /// Everything the phone already has: people, open decisions, epics, stories/tasks, rooms, actions.
    static func entries(plan: PlanResponse?, board: [String: [Item]]?, open: [InboxItem], people: [(id: String, name: String)],
                        rooms: [Room], currentTheme: ThemeID) -> [CommandEntry] {
        var out: [CommandEntry] = []
        var seen = Set<String>()
        func add(_ e: CommandEntry) { if seen.insert(e.id).inserted { out.append(e) } }
        for i in open { add(CommandEntry(id: "inbox:\(i.id)", kind: .inbox, title: i.title, subtitle: i.kind.glyph.label, target: .inbox(i.id))) }
        for p in people { add(CommandEntry(id: "person:\(p.id)", kind: .person, title: p.name, subtitle: "Talk", target: .talk(p.id))) }
        let epics = (plan?.areas.flatMap(\.epics) ?? []) + (plan?.unfiled ?? [])
        for c in epics { add(CommandEntry(id: "item:\(c.epic.id)", kind: .epic, title: c.epic.title, subtitle: c.epic.status.glyph.label, target: .item(c.epic.id))) }
        let items = (plan?.mine ?? []) + (board ?? [:]).keys.sorted().flatMap { board?[$0] ?? [] }
        for i in items where i.level != .epic {
            add(CommandEntry(id: "item:\(i.id)", kind: i.level == .task ? .task : .story, title: i.title, subtitle: i.status.glyph.label, target: .item(i.id)))
        }
        for r in rooms { add(CommandEntry(id: "room:\(r.id)", kind: .room, title: r.title, subtitle: "Room", target: .room(r.id))) }
        let actions: [CommandAction] = [.settings, .spend, .alerts, .office, .releases, .newRequest, .features, .board]
            + ThemeID.allCases.filter { $0 != currentTheme }.map { .theme($0) }
        for a in actions { add(CommandEntry(id: "action:\(a.title)", kind: .action, title: a.title, subtitle: nil, target: .action(a))) }
        return out
    }
}

// MARK: - Quick replies

enum QuickReplies {
    static func suggestions(lastText: String?, lastFromOwner: Bool) -> [String] {
        guard let t = lastText?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, !lastFromOwner else {
            return ["Status?", "What needs me?"]
        }
        return t.contains("?") ? ["Yes, go ahead", "Hold off", "Explain more"] : ["Thanks", "Status?"]
    }
}
