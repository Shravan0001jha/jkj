import Foundation

/// The Plan's filter, sort and search (owner, 4 Oct): pure, so the same rules order the Areas
/// view, the Board and the flat results, and are unit-tested without a screen.
///
/// Finished work always sinks: within any list, open items come first and done ones last,
/// whatever the sort. "Done" here is `status == .done` (a resolution of won't-do or duplicate
/// is done too).
struct PlanQuery: Equatable {
    enum StatusFilter: String, CaseIterable, Identifiable {
        case open, done, all
        var id: String { rawValue }
        var label: String {
            switch self {
            case .open: return "Open"
            case .done: return "Done"
            case .all: return "All"
            }
        }
    }

    enum Sort: String, CaseIterable, Identifiable {
        /// The plan's own order (rank): what the owner set by dragging.
        case plan
        case recent
        case title
        var id: String { rawValue }
        var label: String {
            switch self {
            case .plan: return "Plan order"
            case .recent: return "Recently updated"
            case .title: return "Title"
            }
        }
    }

    var status: StatusFilter = .all
    /// An epic's owner or a story/task's assignee; nil = anyone.
    var personId: String?
    /// nil = every level.
    var level: ItemLevel?
    var sort: Sort = .plan
    var text: String = ""

    var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Anything narrowing the plan beyond the defaults (the filter button shows filled).
    var isFiltering: Bool { status != .all || personId != nil || level != nil }

    /// A level filter (other than epics) or a search shows one flat list of matches instead of
    /// the areas: a story is not an area's card.
    var showsFlatResults: Bool { !trimmedText.isEmpty || (level != nil && level != .epic) }

    /// Reordering by drag only makes sense in plan order with nothing hidden.
    var allowsReorder: Bool { sort == .plan && !isFiltering && trimmedText.isEmpty }

    // MARK: matching

    func matches(_ item: Item) -> Bool {
        switch status {
        case .open: if item.status == .done { return false }
        case .done: if item.status != .done { return false }
        case .all: break
        }
        if let level, item.level != level { return false }
        if let personId, Self.person(of: item) != personId { return false }
        let q = trimmedText
        if !q.isEmpty {
            let hit = item.title.localizedCaseInsensitiveContains(q) || item.body.localizedCaseInsensitiveContains(q) || item.id == q
            if !hit { return false }
        }
        return true
    }

    /// Who an item belongs to: the owner of an epic, the assignee of a story or task.
    static func person(of item: Item) -> String? {
        item.level == .epic ? item.ownerId : item.assigneeId
    }

    // MARK: ordering

    /// Open first, done last; inside each, by the chosen sort.
    func sorted(_ items: [Item]) -> [Item] {
        items.sorted { a, b in
            let da = a.status == .done, db = b.status == .done
            if da != db { return !da }
            return before(a, b)
        }
    }

    private func before(_ a: Item, _ b: Item) -> Bool {
        switch sort {
        case .plan:
            if a.rank != b.rank { return a.rank < b.rank }
        case .recent:
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
        case .title:
            let c = a.title.localizedCaseInsensitiveCompare(b.title)
            if c != .orderedSame { return c == .orderedAscending }
        }
        return a.id < b.id
    }

    /// An area's epic cards, filtered and ordered (done epics at the bottom).
    func epics(_ cards: [EpicCard]) -> [EpicCard] {
        let byId = Dictionary(cards.map { ($0.epic.id, $0) }, uniquingKeysWith: { a, _ in a })
        let shown = level == nil || level == .epic ? cards.map(\.epic).filter(matches) : []
        return sorted(shown).compactMap { byId[$0.id] }
    }

    /// An area's epics that are still going: finished ones leave for the Plan's "Done (N)".
    func openEpics(_ cards: [EpicCard]) -> [EpicCard] { epics(cards.filter { !$0.isFinished }) }

    /// Every finished epic of the plan (each area's and the unfiled), filtered and ordered: the
    /// collapsed "Done (N)" section at the bottom of the Plan.
    func finishedEpics(_ plan: PlanResponse) -> [EpicCard] {
        epics((plan.areas.flatMap(\.epics) + plan.unfiled).filter(\.isFinished))
    }

    /// One board column, filtered and ordered.
    func column(_ items: [Item]) -> [Item] { sorted(items.filter(matches)) }

    /// The flat results: every epic of the plan and every story/task of the board, deduplicated.
    func results(plan: PlanResponse?, board: [String: [Item]]?) -> [Item] {
        var seen = Set<String>()
        var all: [Item] = []
        let epics = (plan?.areas.flatMap(\.epics) ?? []) + (plan?.unfiled ?? [])
        for i in epics.map(\.epic) + (plan?.mine ?? []) + (board?.values.flatMap { $0 } ?? []) where seen.insert(i.id).inserted {
            all.append(i)
        }
        return sorted(all.filter(matches))
    }
}
