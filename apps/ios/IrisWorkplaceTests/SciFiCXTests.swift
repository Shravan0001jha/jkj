import XCTest
@testable import IrisWorkplace

/// docs/THEMES.md §3: the logic behind the Sci-fi CX — since-you-last-looked, the decision queue
/// and its undo window, command-palette ranking and quick replies.
private func item(_ id: String, _ level: ItemLevel = .epic, status: ItemStatus = .inProgress, title: String? = nil) -> Item {
    Item(id: id, level: level, title: title ?? "Item \(id)", body: "", status: status, statusSince: "2026-10-01T00:00:00.000Z",
         parentId: nil, epicId: nil, assigneeId: nil, ownerId: nil, rank: 1, acceptance: [],
         legacy: ItemLegacy(kind: .assignment, state: "proposed"), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z")
}

private func card(_ i: Item, blocked: [String] = []) -> EpicCard {
    EpicCard(epic: i, progress: EpicProgress(pointsDone: 0, pointsTotal: 0, storiesDone: 0, storiesTotal: 0, pct: 0), next: nil,
             flags: blocked.map { PlanFlag(kind: .blocked, itemId: $0, title: "t", reason: "r", waitingOn: nil, since: "2026-10-01T00:00:00.000Z") },
             inFocus: false)
}

private func plan(counts: [String: Int], epics: [EpicCard] = []) -> PlanResponse {
    PlanResponse(areas: [], unfiled: epics, mine: [], focus: Focus(epicIds: [], setBy: "owner", at: "2026-10-01T00:00:00.000Z"), counts: counts)
}

private func inbox(_ id: String, state: InboxState = .open, urgency: InboxUrgency? = nil, created: String = "2026-10-01T00:00:00.000Z",
                   options: [InboxOption] = [InboxOption(id: "yes", label: "Yes", recommended: true), InboxOption(id: "no", label: "No")]) -> InboxItem {
    InboxItem(id: id, kind: .decision, title: "Decide \(id)", body: "", context: [:], options: options, state: state, raisedBy: "asha",
              createdAt: created, affects: [], summary: "", urgency: urgency)
}

private func update(_ id: String) -> Update {
    Update(id: id, at: "2026-10-01T00:00:00.000Z", kind: .shipped, line: "l", by: "asha", href: "", push: false)
}

// MARK: - Since you last looked

final class BridgeDigestTests: XCTestCase {
    func testFirstLookHasNoDigest() {
        let now = BridgeSnapshot.capture(plan: plan(counts: ["done": 1]), open: [], updates: [], at: Date())
        XCTAssertNil(BridgeDigest.diff(from: nil, to: now))
    }

    func testDiffCountsDoneBlockedDecisionsAndUpdates() {
        let old = BridgeSnapshot.capture(plan: plan(counts: ["done": 3, "blocked": 1], epics: [card(item("e1"), blocked: ["s1"])]),
                                         open: [inbox("a"), inbox("b")], updates: [update("u1")], at: Date(timeIntervalSince1970: 0))
        let new = BridgeSnapshot.capture(plan: plan(counts: ["done": 5, "blocked": 2], epics: [card(item("e1"), blocked: ["s2", "s3"])]),
                                         open: [inbox("b"), inbox("c"), inbox("d")], updates: [update("u3"), update("u2"), update("u1")],
                                         at: Date(timeIntervalSince1970: 3600))
        let d = BridgeDigest.diff(from: old, to: new)!
        XCTAssertEqual(d.newlyDone, 2)
        XCTAssertEqual(d.newlyBlocked, 2, "s2 and s3 are new; s1 cleared")
        XCTAssertEqual(d.unblocked, 1)
        XCTAssertEqual(d.newDecisions, 2)
        XCTAssertEqual(d.resolved, 1, "a left the open set")
        XCTAssertEqual(d.updates, 2)
        XCTAssertEqual(d.since, Date(timeIntervalSince1970: 0))
        XCTAssertEqual(d.lines, ["+2 done", "2 newly blocked", "1 unblocked", "2 new decisions", "1 resolved", "2 updates"])
        XCTAssertFalse(d.isEmpty)
    }

    func testNothingChangedIsEmptyAndDoneNeverGoesNegative() {
        let a = BridgeSnapshot.capture(plan: plan(counts: ["done": 5]), open: [inbox("a")], updates: [update("u1")], at: Date())
        let b = BridgeSnapshot.capture(plan: plan(counts: ["done": 4]), open: [inbox("a")], updates: [update("u1")], at: Date())
        let d = BridgeDigest.diff(from: a, to: b)!
        XCTAssertTrue(d.isEmpty)
        XCTAssertEqual(d.lines, [])
    }

    func testSingularWording() {
        let a = BridgeSnapshot.capture(plan: plan(counts: [:]), open: [], updates: [], at: Date())
        let b = BridgeSnapshot.capture(plan: plan(counts: ["done": 1]), open: [inbox("x")], updates: [update("u")], at: Date())
        XCTAssertEqual(BridgeDigest.diff(from: a, to: b)!.lines, ["+1 done", "1 new decision", "1 update"])
    }

    func testSnapshotRoundTripsThroughDefaults() {
        let d = UserDefaults(suiteName: "bridge-\(UUID().uuidString)")!
        let store = BridgeSnapshotStore(defaults: d)
        XCTAssertNil(store.load())
        let s = BridgeSnapshot.capture(plan: plan(counts: ["done": 2]), open: [inbox("a")], updates: [update("u")], at: Date(timeIntervalSince1970: 42))
        store.save(s)
        XCTAssertEqual(store.load(), s)
    }

    func testSnapshotKeepsAtMostTwoHundredUpdateIds() {
        let ups = (0..<300).map { update("u\($0)") }
        let s = BridgeSnapshot.capture(plan: nil, open: [], updates: ups, at: Date())
        XCTAssertEqual(s.updateIds.count, 200)
        XCTAssertEqual(s.updateIds.first, "u0", "newest first, as the store has them")
    }
}

// MARK: - Decision queue

final class DecisionQueueTests: XCTestCase {
    func testUrgentFirstThenOldestAndClosedItemsDrop() {
        var q = DecisionQueue()
        q.sync(open: [inbox("a", created: "2026-10-02T00:00:00.000Z"), inbox("b", urgency: .urgent, created: "2026-10-03T00:00:00.000Z"),
                      inbox("c", created: "2026-10-01T00:00:00.000Z"), inbox("d", urgency: .high)])
        XCTAssertEqual(q.order, ["b", "d", "c", "a"])
        q.sync(open: [inbox("a"), inbox("c"), inbox("d", urgency: .high)])
        XCTAssertEqual(q.order, ["d", "c", "a"], "b was answered elsewhere")
        XCTAssertEqual(q.top, "d")
    }

    func testDeferMovesToTheBackAndSurvivesASync() {
        var q = DecisionQueue()
        q.sync(open: [inbox("a"), inbox("b"), inbox("c")])
        q.defer("a")
        XCTAssertEqual(q.order, ["b", "c", "a"])
        q.sync(open: [inbox("a"), inbox("b"), inbox("c"), inbox("new")])
        XCTAssertEqual(q.order, ["b", "c", "a", "new"], "known items keep the owner's order; new ones join the end")
    }

    func testSwipeOnlyEverRunsASafeRecommendedOption() {
        XCTAssertEqual(DecisionQueue.swipeOption(inbox("a"))?.id, "yes")
        XCTAssertNil(DecisionQueue.swipeOption(inbox("b", options: [InboxOption(id: "go", label: "Go", danger: true, recommended: true)])), "danger confirms")
        XCTAssertNil(DecisionQueue.swipeOption(inbox("c", options: [InboxOption(id: "n", label: "Note", recommended: true, needsNote: true)])), "needs a note")
        XCTAssertNil(DecisionQueue.swipeOption(inbox("d", options: [InboxOption(id: "x", label: "X"), InboxOption(id: "y", label: "Y")])), "no recommendation, no swipe")
        XCTAssertNil(DecisionQueue.swipeOption(inbox("e", state: .answered)))
    }
}

@MainActor
final class DecisionStagerTests: XCTestCase {
    private var fired: [String] = []

    private func stager(window: TimeInterval = 0.15) -> DecisionStager {
        DecisionStager(window: window) { [weak self] p in self?.fired.append("\(p.itemId):\(p.option.id)") }
    }

    func testCommitsAfterTheWindow() async {
        let s = stager()
        s.stage(item: inbox("a"), option: InboxOption(id: "yes", label: "Yes"), note: nil)
        XCTAssertTrue(s.isStaged("a"))
        XCTAssertEqual(fired, [], "nothing is sent inside the undo window")
        let ok = await eventually(2) { self.fired == ["a:yes"] }
        XCTAssertTrue(ok)
        XCTAssertFalse(s.isStaged("a"))
    }

    func testUndoInsideTheWindowSendsNothing() async {
        let s = stager()
        s.stage(item: inbox("a"), option: InboxOption(id: "yes", label: "Yes"), note: nil)
        s.undo("a")
        XCTAssertFalse(s.isStaged("a"))
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(fired, [])
    }

    func testCommitAllSendsAtOnceExactlyOnce() async {
        let s = stager(window: 5)
        s.stage(item: inbox("a"), option: InboxOption(id: "yes", label: "Yes"), note: nil)
        s.stage(item: inbox("b"), option: InboxOption(id: "no", label: "No"), note: nil)
        await s.commitAll()
        XCTAssertEqual(Set(fired), ["a:yes", "b:no"])
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(fired.count, 2)
    }

    func testRestagingAnItemReplacesItsOption() async {
        let s = stager()
        s.stage(item: inbox("a"), option: InboxOption(id: "yes", label: "Yes"), note: nil)
        s.stage(item: inbox("a"), option: InboxOption(id: "no", label: "No"), note: nil)
        XCTAssertEqual(s.pending.count, 1)
        let ok = await eventually(2) { !self.fired.isEmpty }
        XCTAssertTrue(ok)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(fired, ["a:no"])
    }
}

// MARK: - Command palette

final class CommandSearchTests: XCTestCase {
    private func e(_ title: String, _ kind: CommandEntry.Kind = .epic) -> CommandEntry {
        CommandEntry(id: title, kind: kind, title: title, subtitle: nil, target: .item(title))
    }

    func testScoreOrder() {
        let exact = CommandSearch.score("music", "Music")!
        let prefix = CommandSearch.score("music", "Music fix")!
        let word = CommandSearch.score("music", "Iris during music")!
        let sub = CommandSearch.score("usic", "Iris during music")!
        let seq = CommandSearch.score("idm", "Iris during music")!
        XCTAssertGreaterThan(exact, prefix)
        XCTAssertGreaterThan(prefix, word)
        XCTAssertGreaterThan(word, sub)
        XCTAssertGreaterThan(sub, seq)
        XCTAssertNil(CommandSearch.score("xyz", "Iris during music"))
    }

    func testCaseAndDiacriticsInsensitive() {
        XCTAssertNotNil(CommandSearch.score("cafe", "Café rollout"))
        XCTAssertNotNil(CommandSearch.score("IRIS", "iris"))
    }

    func testRankBreaksTiesByKindThenLength() {
        let entries = [e("Settings sync", .story), e("Settings", .action), e("Settings sync", .epic), e("Sett", .person)]
        let r = CommandSearch.rank("sett", entries)
        XCTAssertEqual(r.first?.kind, .person, "exact match wins")
        XCTAssertEqual(r.map(\.kind), [.person, .action, .epic, .story], "prefix ties: shorter title, then kind")
    }

    func testEmptyQueryKeepsTheGivenOrderAndLimit() {
        let entries = (0..<50).map { e("Item \($0)") }
        XCTAssertEqual(CommandSearch.rank("  ", entries, limit: 5).map(\.title), (0..<5).map { "Item \($0)" })
    }

    func testEntriesCoverPeopleEpicsStoriesInboxRoomsAndActions() {
        let card1 = card(item("ep1", title: "Music fix"))
        let p = PlanResponse(areas: [], unfiled: [card1], mine: [item("st1", .story, title: "Duck the music")],
                             focus: Focus(epicIds: [], setBy: "o", at: "x"), counts: [:])
        let entries = CommandSearch.entries(plan: p, board: nil, open: [inbox("ib1")], people: [("mira", "Mira")],
                                            rooms: [Room(id: "r1", kind: .general, title: "General", headline: "", lastAt: "", threadIds: [])],
                                            currentTheme: .default)
        let kinds = Set(entries.map(\.kind))
        XCTAssertEqual(kinds, [.epic, .story, .inbox, .person, .room, .action])
        XCTAssertTrue(entries.contains { $0.target == .action(.theme(.scifi)) }, "switch theme is an action")
        XCTAssertFalse(entries.contains { $0.target == .action(.theme(.default)) }, "never offers the current theme")
        XCTAssertEqual(CommandSearch.rank("music", entries).first?.target, .item("ep1"))
    }
}

// MARK: - Quick replies

final class QuickRepliesTests: XCTestCase {
    func testAQuestionGetsYesNoMore() {
        XCTAssertEqual(QuickReplies.suggestions(lastText: "Shall I ship 0.2.21 tonight?", lastFromOwner: false),
                       ["Yes, go ahead", "Hold off", "Explain more"])
    }
    func testAStatementGetsThanksAndStatus() {
        XCTAssertEqual(QuickReplies.suggestions(lastText: "Shipped.", lastFromOwner: false), ["Thanks", "Status?"])
    }
    func testOwnerSpokeLastOrEmptyThread() {
        XCTAssertEqual(QuickReplies.suggestions(lastText: "hi", lastFromOwner: true), ["Status?", "What needs me?"])
        XCTAssertEqual(QuickReplies.suggestions(lastText: nil, lastFromOwner: false), ["Status?", "What needs me?"])
    }
}
