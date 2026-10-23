import XCTest
@testable import IrisWorkplace

/// The Plan's topic order (owner, 23 Oct): topics (areas) with an open epic first, topics with no epic last,
/// each group in the server's order.
final class PlanOrderTests: XCTestCase {
    private let at = "2026-10-01T00:00:00.000Z"

    private func card(_ id: String, status: ItemStatus = .inProgress) -> EpicCard {
        let i = Item(id: id, level: .epic, title: "Epic \(id)", body: "", status: status, statusSince: at,
                     parentId: nil, epicId: nil, assigneeId: nil, ownerId: nil, rank: 1, acceptance: [],
                     legacy: ItemLegacy(kind: .assignment, state: "proposed"), createdAt: at, updatedAt: at)
        return EpicCard(epic: i, progress: EpicProgress(pointsDone: 0, pointsTotal: 0, storiesDone: 0, storiesTotal: 0, pct: 0),
                        next: nil, flags: [], inFocus: false)
    }

    private func area(_ id: String, _ epics: [EpicCard]) -> PlanArea {
        PlanArea(area: Area(id: id, title: "Area \(id)", description: nil, state: .active, rank: 1, ownerId: "owner",
                            roomId: "r", threadId: "t", createdAt: at, updatedAt: at), epics: epics)
    }

    func testTopicsWithNoEpicSinkBelowTopicsWithEpics() {
        let areas = [area("empty1", []), area("a", [card("e1")]), area("empty2", []), area("b", [card("e2")])]
        let split = PlanArea.splitByOpenEpics(areas)
        XCTAssertEqual(split.withEpics.map(\.id), ["a", "b"])
        XCTAssertEqual(split.withoutEpics.map(\.id), ["empty1", "empty2"], "stable: the server's order within the group")
    }

    func testATopicWhoseEpicsAreAllFinishedCountsAsHavingNoEpic() {
        let split = PlanArea.splitByOpenEpics([area("done", [card("d", status: .done)]), area("live", [card("l"), card("d2", status: .done)])])
        XCTAssertEqual(split.withEpics.map(\.id), ["live"])
        XCTAssertEqual(split.withoutEpics.map(\.id), ["done"])
    }

    func testNothingIsLostOrDuplicated() {
        let areas = [area("x", []), area("y", [card("e")]), area("z", [card("f", status: .done)])]
        let split = PlanArea.splitByOpenEpics(areas)
        XCTAssertEqual(Set((split.withEpics + split.withoutEpics).map(\.id)), Set(areas.map(\.id)))
        XCTAssertEqual(split.withEpics.count + split.withoutEpics.count, areas.count)
    }
}
