import Foundation
import Observation

// v2 stores (LLD §19.8). Same pattern as Stores.swift: `load()` for the first load and
// pull-to-refresh, `handle(_:)` for socket events, actions that change state only once the
// server answered (act, then ack). A cancelled load is never an error (`Error.userMessage`).

// MARK: - Plan

@MainActor @Observable
final class PlanStore {
    private(set) var plan: PlanResponse?
    private(set) var board: [String: [Item]]?
    private(set) var error: String?
    private(set) var loading = false
    private(set) var loaded = false
    /// A story or task moved: its epic's progress and flags are now stale. The app reloads.
    var onStale: (() -> Void)?

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            plan = try await rest.plan()
            error = nil
            loaded = true
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func loadBoard(_ rest: RestClient) async {
        do {
            let p = try await rest.plan(board: true)
            board = p.board ?? [:]
            if plan == nil { plan = p; loaded = true }
            error = nil
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .itemUpdated(let item):
            apply(item)
        case .areaUpdated(let area):
            guard var p = plan, let i = p.areas.firstIndex(where: { $0.area.id == area.id }) else { return }
            p.areas[i].area = area
            plan = p
        default:
            break
        }
    }

    private func apply(_ item: Item) {
        if var p = plan {
            if item.level == .epic {
                for a in p.areas.indices {
                    if let i = p.areas[a].epics.firstIndex(where: { $0.epic.id == item.id }) { p.areas[a].epics[i].epic = item }
                }
                if let i = p.unfiled.firstIndex(where: { $0.epic.id == item.id }) { p.unfiled[i].epic = item }
            }
            p.mine.removeAll { $0.id == item.id }
            if item.assigneeId == "owner", item.status != .done, item.level != .epic {
                p.mine.append(item)
                p.mine.sort { $0.rank < $1.rank }
            }
            plan = p
        }
        if var b = board, item.level != .epic {
            for k in b.keys { b[k]?.removeAll { $0.id == item.id } }
            b[item.status.rawValue, default: []].append(item)
            b[item.status.rawValue]?.sort { $0.rank < $1.rank }
            board = b
        }
        if item.level != .epic { onStale?() }
    }

    var mine: [Item] { plan?.mine ?? [] }
    var focusIds: Set<String> { Set(plan?.focus.epicIds ?? []) }

    /// The board's columns in state-machine order; an unknown status gets its own column last.
    var columns: [(status: ItemStatus, items: [Item])] {
        guard let board else { return [] }
        var out = ItemStatus.order.map { s in (status: s, items: board[s.rawValue] ?? []) }
        let unknown = board.filter { ItemStatus(rawValue: $0.key) == nil }.flatMap(\.value)
        if !unknown.isEmpty { out.append((status: .unknown, items: unknown)) }
        return out
    }

    func epic(_ id: String) -> EpicCard? {
        plan.flatMap { p in (p.areas.flatMap(\.epics) + p.unfiled).first { $0.epic.id == id } }
    }

    // MARK: actions

    func setFocus(_ rest: RestClient, epicId: String, on: Bool) async throws {
        var ids = plan?.focus.epicIds ?? []
        ids.removeAll { $0 == epicId }
        if on { ids.insert(epicId, at: 0) }
        let f = try await rest.setFocus(ids)
        if var p = plan {
            p.focus = f
            for a in p.areas.indices { for i in p.areas[a].epics.indices { p.areas[a].epics[i].inFocus = f.epicIds.contains(p.areas[a].epics[i].epic.id) } }
            for i in p.unfiled.indices { p.unfiled[i].inFocus = f.epicIds.contains(p.unfiled[i].epic.id) }
            plan = p
        }
    }

    /// Reorder an area's epics as the owner sees them (`shown`, after the Plan's filter and sort:
    /// done epics sit at the bottom): only the moved epic gets a new rank, between its new
    /// neighbours on screen.
    func move(_ rest: RestClient, areaId: String, shown: [EpicCard], from source: IndexSet, to destination: Int) async throws {
        guard let p = plan, let a = p.areas.firstIndex(where: { $0.area.id == areaId }), let from = source.first, shown.indices.contains(from) else { return }
        var epics = shown
        let moved = epics[from]
        epics.move(fromOffsets: source, toOffset: destination)
        guard let at = epics.firstIndex(where: { $0.id == moved.id }) else { return }
        let before = at > 0 ? epics[at - 1].epic.rank : nil
        let after = at < epics.count - 1 ? epics[at + 1].epic.rank : nil
        let rank = Self.rank(before: before, after: after)
        var updated = p
        if let i = updated.areas[a].epics.firstIndex(where: { $0.id == moved.id }) { updated.areas[a].epics[i].epic.rank = rank }
        updated.areas[a].epics.sort { $0.epic.rank < $1.epic.rank }
        plan = updated   // the list keeps the row where the owner dropped it while the server confirms
        do {
            _ = try await rest.updateItem(moved.id, UpdateItemRequest(rank: rank))
        } catch {
            plan = p
            throw error
        }
        await load(rest)
    }

    static func rank(before: Double?, after: Double?) -> Double {
        switch (before, after) {
        case let (b?, a?): return (b + a) / 2
        case let (nil, a?): return a - 1
        case let (b?, nil): return b + 1
        case (nil, nil): return 1
        }
    }
}

// MARK: - Items (epic / story / task pages)

@MainActor @Observable
final class ItemsStore {
    private(set) var details: [String: ItemDetail] = [:]
    private(set) var errors: [String: String] = [:]
    private(set) var busy: Set<String> = []

    func load(_ rest: RestClient, id: String) async {
        do {
            details[id] = try await rest.item(id)
            errors[id] = nil
        } catch {
            if let m = error.userMessage { errors[id] = m }
        }
    }

    func update(_ rest: RestClient, id: String, _ req: UpdateItemRequest) async throws {
        busy.insert(id)
        defer { busy.remove(id) }
        let d = try await rest.updateItem(id, req)
        details[id] = d
        apply(d.item)
    }

    @discardableResult
    func create(_ rest: RestClient, _ req: CreateItemRequest) async throws -> ItemDetail {
        let d = try await rest.createItem(req)
        details[d.item.id] = d
        apply(d.item)
        return d
    }

    func comment(_ rest: RestClient, id: String, text: String) async throws {
        busy.insert(id)
        defer { busy.remove(id) }
        add(try await rest.comment(item: id, text: text))
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .itemUpdated(let item): apply(item)
        case .itemComment(let c): add(c)
        case .activityRecorded(let a):
            guard let id = a.itemId, var d = details[id], !d.activity.contains(where: { $0.id == a.id }) else { return }
            d.activity.append(a)
            details[id] = d
        default: break
        }
    }

    private func add(_ c: Comment) {
        guard var d = details[c.itemId], !d.comments.contains(where: { $0.id == c.id }) else { return }
        d.comments.append(c)
        d.comments.sort { $0.at < $1.at }
        details[c.itemId] = d
    }

    /// An item changed: wherever a loaded page shows it (itself, a child, its parent or epic).
    private func apply(_ item: Item) {
        for (id, var d) in details {
            var changed = false
            if d.item.id == item.id { d.item = item; changed = true }
            if let i = d.children.firstIndex(where: { $0.id == item.id }) { d.children[i] = item; changed = true }
            else if item.parentId == id, item.level != .epic { d.children.append(item); d.children.sort { $0.rank < $1.rank }; changed = true }
            if d.parent?.id == item.id { d.parent = item; changed = true }
            if d.epic?.id == item.id { d.epic = item; changed = true }
            if changed { details[id] = d }
        }
    }
}

// MARK: - Updates

@MainActor @Observable
final class UpdatesStore {
    private(set) var updates: [Update] = []
    private(set) var error: String?
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var hasMore = true
    /// Arrived over the socket since the owner last looked at the feed.
    private(set) var unseen = 0
    static let pageSize = 50

    func load(_ rest: RestClient) async {
        loading = true
        defer { loading = false }
        do {
            let page = try await rest.updates(limit: Self.pageSize)
            updates = Self.sorted(page)
            hasMore = page.count >= Self.pageSize
            error = nil
            loaded = true
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func loadMore(_ rest: RestClient) async {
        guard hasMore, !loading, let last = updates.last else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await rest.updates(limit: Self.pageSize, before: last.id)
            let known = Set(updates.map(\.id))
            updates = Self.sorted(updates + page.filter { !known.contains($0.id) })
            hasMore = page.count >= Self.pageSize
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        guard case .updatePosted(let u) = event, !updates.contains(where: { $0.id == u.id }) else { return }
        updates = Self.sorted([u] + updates)
        unseen += 1
    }

    func markSeen() { unseen = 0 }

    static func sorted(_ u: [Update]) -> [Update] { u.sorted { $0.at > $1.at } }
}

// MARK: - Rooms (v2: General, one per area, Releases)

@MainActor @Observable
final class RoomsStore {
    private(set) var rooms: [Room] = []
    private(set) var details: [String: RoomDetail] = [:]
    private(set) var error: String?
    private(set) var loaded = false

    func load(_ rest: RestClient) async {
        do {
            rooms = try await rest.rooms()
            error = nil
            loaded = true
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func loadRoom(_ rest: RestClient, id: String) async {
        do {
            var d = try await rest.roomDetail(id)
            d.threads = Self.sorted(d.threads)
            details[id] = d
            error = nil
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .roomThread(let t): upsert(t)
        case .roomMessage(_, let t): upsert(t)
        default: break
        }
    }

    private func upsert(_ t: RoomThread) {
        let roomId = t.roomId ?? "general"
        if var d = details[roomId] {
            if let i = d.threads.firstIndex(where: { $0.id == t.id }) { d.threads[i] = t } else { d.threads.append(t) }
            d.threads = Self.sorted(d.threads)
            details[roomId] = d
        }
        if let i = rooms.firstIndex(where: { $0.id == roomId }), t.lastAt > rooms[i].lastAt {
            rooms[i].lastAt = t.lastAt
            if !rooms[i].threadIds.contains(t.id) { rooms[i].threadIds.append(t.id) }
        }
    }

    /// Open first, then the most recent; General's own channel always on top.
    static func sorted(_ threads: [RoomThread]) -> [RoomThread] {
        threads.sorted { a, b in
            if (a.id == RoomStore.generalId) != (b.id == RoomStore.generalId) { return a.id == RoomStore.generalId }
            if (a.state == .resolved) != (b.state == .resolved) { return a.state != .resolved }
            return a.lastAt > b.lastAt
        }
    }
}

// MARK: - Release posts

@MainActor @Observable
final class ReleasePostsStore {
    private(set) var posts: [ReleasePost] = []
    private(set) var error: String?
    private(set) var loaded = false

    func load(_ rest: RestClient) async {
        do {
            posts = try await rest.releasePosts().sorted { $0.at > $1.at }
            error = nil
            loaded = true
        } catch {
            if let m = error.userMessage { self.error = m }
        }
    }

    func handle(_ event: ServerEvent) {
        guard case .releasePost(let p) = event else { return }
        posts.removeAll { $0.id == p.id }
        posts.insert(p, at: 0)
        posts.sort { $0.at > $1.at }
    }

    func post(_ id: String) -> ReleasePost? { posts.first { $0.id == id } }
}
