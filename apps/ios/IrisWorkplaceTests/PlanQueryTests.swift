import XCTest
@testable import IrisWorkplace

/// The Plan's filter, sort and search (owner, 4 Oct): done work sinks, filters narrow, search finds.
final class PlanQueryTests: XCTestCase {
    private func item(_ id: String, _ level: ItemLevel = .epic, status: ItemStatus = .inProgress, rank: Double = 1,
                      owner: String? = nil, assignee: String? = nil, title: String? = nil, updated: String = "2026-10-01T00:00:00.000Z") -> Item {
        Item(id: id, level: level, title: title ?? "Item \(id)", body: "", status: status, statusSince: updated,
             parentId: nil, epicId: nil, assigneeId: assignee, ownerId: owner, rank: rank, acceptance: [],
             legacy: ItemLegacy(kind: .assignment, state: "proposed"), createdAt: updated, updatedAt: updated)
    }
    private func card(_ i: Item) -> EpicCard {
        EpicCard(epic: i, progress: EpicProgress(pointsDone: 0, pointsTotal: 0, storiesDone: 0, storiesTotal: 0, pct: 0), next: nil, flags: [], inFocus: false)
    }

    func testDoneEpicsSinkToTheBottomWhateverTheirRank() {
        let cards = [card(item("a", status: .done, rank: 1)), card(item("b", rank: 2)), card(item("c", status: .done, rank: 0)), card(item("d", rank: 3))]
        XCTAssertEqual(PlanQuery().epics(cards).map(\.id), ["b", "d", "c", "a"])
    }

    func testStatusFilterOpenDoneAll() {
        let cards = [card(item("a", status: .done)), card(item("b"))]
        var q = PlanQuery(); q.status = .open
        XCTAssertEqual(q.epics(cards).map(\.id), ["b"])
        q.status = .done
        XCTAssertEqual(q.epics(cards).map(\.id), ["a"])
        q.status = .all
        XCTAssertEqual(q.epics(cards).count, 2)
    }

    func testOwnerMeansTheEpicsOwnerAndTheStorysAssignee() {
        var q = PlanQuery(); q.personId = "dev"
        XCTAssertTrue(q.matches(item("e", owner: "dev")))
        XCTAssertFalse(q.matches(item("e2", owner: "asha", assignee: "dev")))
        XCTAssertTrue(q.matches(item("s", .story, assignee: "dev")))
        XCTAssertFalse(q.matches(item("s2", .story, owner: "dev", assignee: "asha")))
    }

    func testSortsKeepDoneLast() {
        let items = [item("a", title: "Zeta", updated: "2026-10-03T00:00:00.000Z"), item("b", status: .done, title: "Alpha", updated: "2026-10-04T00:00:00.000Z"),
                     item("c", title: "Beta", updated: "2026-10-01T00:00:00.000Z")]
        var q = PlanQuery(); q.sort = .title
        XCTAssertEqual(q.sorted(items).map(\.id), ["c", "a", "b"])
        q.sort = .recent
        XCTAssertEqual(q.sorted(items).map(\.id), ["a", "c", "b"])
    }

    func testSearchOrAStoryLevelShowsFlatResultsAcrossPlanAndBoard() {
        var q = PlanQuery()
        XCTAssertFalse(q.showsFlatResults)
        q.text = "  greet "
        XCTAssertTrue(q.showsFlatResults)
        XCTAssertFalse(q.allowsReorder)
        let plan = PlanResponse(areas: [PlanArea(area: Area(id: "ar", title: "A", description: nil, state: .active, rank: 1, ownerId: "asha", roomId: "r", threadId: "t",
                                                             createdAt: "", updatedAt: ""), epics: [card(item("e", title: "Daily greeting"))])],
                                unfiled: [], mine: [], focus: Focus(epicIds: [], setBy: "owner", at: ""), counts: [:], board: nil)
        let board = ["ready": [item("s", .story, title: "Greeting copy"), item("t", .task, title: "Unrelated")]]
        XCTAssertEqual(q.results(plan: plan, board: board).map(\.id).sorted(), ["e", "s"])
        q.text = ""; q.level = .task
        XCTAssertTrue(q.showsFlatResults)
        XCTAssertEqual(q.results(plan: plan, board: board).map(\.id), ["t"])
        q.level = .epic
        XCTAssertFalse(q.showsFlatResults, "epics stay in their areas")
    }
}
