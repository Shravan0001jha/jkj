import XCTest
@testable import IrisWorkplace

/// The October 2026 rework (docs/LLD-rework-2026-10.md W5, TDD W5): waiting/parked, the story's
/// chain and audit, a reason on every status change, the Plan's Done bucket, the COO note, super
/// focus and the Mac queue. Old servers send none of the new fields; nothing here may break them.
@MainActor
final class ReworkTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/items/as_rework1": return (200, try! Fixtures.data("rework-item-story"))
            default: return (404, Data(#"{"error":"Not found"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    private func body(_ i: Int = -1) throws -> [String: Any] {
        let r = i < 0 ? StubURLProtocol.recorded.last! : StubURLProtocol.recorded[i]
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(r.body)) as? [String: Any])
    }

    private func item(_ id: String, status: ItemStatus = .inProgress, rank: Double = 1) -> Item {
        Item(id: id, level: .epic, title: "Epic \(id)", body: "", status: status, statusSince: "2026-10-01T00:00:00.000Z",
             parentId: nil, epicId: id, assigneeId: nil, ownerId: "asha", rank: rank, acceptance: [],
             legacy: ItemLegacy(kind: .feature, state: "planned"), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z")
    }
    private func card(_ i: Item, finished: Bool? = nil) -> EpicCard {
        EpicCard(epic: i, progress: EpicProgress(pointsDone: 0, pointsTotal: 0, storiesDone: 0, storiesTotal: 0, pct: 0),
                 next: nil, flags: [], inFocus: false, finished: finished)
    }

    // MARK: TDD 1–2: decoding

    func testItemDetailWithAuditAndChainDecodesAndRoundTrips() throws {
        let d = try Fixtures.decode("rework-item-story", as: ItemDetail.self)
        XCTAssertEqual(d.item.status, .waiting)
        XCTAssertEqual(d.item.trueStatus, .waiting)
        XCTAssertEqual(d.item.type, .bug)
        XCTAssertEqual(d.item.waiting?.on, "tara")
        XCTAssertEqual(d.item.waiting?.reason, "Needs the QA device profile")
        XCTAssertEqual(d.item.docUrl, "https://www.notion.so/wake-word-hld")
        XCTAssertEqual(d.item.rca?.by, "dev")
        let audit = try XCTUnwrap(d.audit)
        XCTAssertEqual(audit.map(\.kind), [.created, .assigned, .status, .doc])
        XCTAssertNil(audit[0].reason)
        let odd = try JSONDecoder().decode(AuditEntry.self, from: Data(#"{"at":"a","by":"coo","kind":"teleported"}"#.utf8))
        XCTAssertEqual(odd.kind, .unknown, "an unknown audit kind decodes as .unknown")
        let chain = try XCTUnwrap(d.chain)
        XCTAssertEqual(chain.developer, "dev")
        XCTAssertEqual(chain.extraReviewers, ["sec1"])
        XCTAssertEqual(chain.chiefOfStaff, "asha")
        XCTAssertEqual(chain.charterTitle, "Voice & audio")

        let reencoded = try jsonObject(d)
        let original = stripNulls(try Fixtures.json("rework-item-story"))
        XCTAssertTrue((reencoded as AnyObject).isEqual(original), "re-encoded differs:\n\(diff(original, reencoded))")
    }

    func testUnknownStatusDecodesAsUnknownAndParkedDecodes() throws {
        let json = #"""
        {"id":"a","level":"story","title":"t","body":"","status":"foo","statusSince":"s","rank":1,"acceptance":[],
         "legacy":{"kind":"assignment","state":"x"},"trueStatus":"bar","type":"spike","createdAt":"c","updatedAt":"u"}
        """#
        let i = try JSONDecoder().decode(Item.self, from: Data(json.utf8))
        XCTAssertEqual(i.status, .unknown)
        XCTAssertEqual(i.trueStatus, .unknown)
        XCTAssertEqual(i.type, .unknown)

        let parked = #"""
        {"id":"b","level":"story","title":"t","body":"","status":"parked","statusSince":"s","rank":1,"acceptance":[],
         "legacy":{"kind":"assignment","state":"x"},"parked":{"reason":"After the release","resumeWhen":"1.4 ships","by":"owner","since":"s"},
         "createdAt":"c","updatedAt":"u"}
        """#
        let p = try JSONDecoder().decode(Item.self, from: Data(parked.utf8))
        XCTAssertEqual(p.status, .parked)
        XCTAssertEqual(p.parked?.resumeWhen, "1.4 ships")
    }

    func testAChainMissingOptionalPartsStillDecodes() throws {
        let c = try JSONDecoder().decode(StoryChain.self, from: Data(#"{"developer":"dev"}"#.utf8))
        XCTAssertEqual(c.extraReviewers, [])
        XCTAssertNil(c.chiefOfStaff)
        XCTAssertEqual(c.people.map(\.id), ["dev"])
    }

    func testOldServerShapesStillDecodeWithoutTheNewFields() throws {
        let d = try Fixtures.decode("live-item-story", as: ItemDetail.self)
        XCTAssertNil(d.audit)
        XCTAssertNil(d.chain)
        XCTAssertNil(d.item.waiting)
        let plan = try Fixtures.decode("live-plan", as: PlanResponse.self)
        XCTAssertTrue(plan.areas.flatMap(\.epics).allSatisfy { $0.finished == nil })
    }

    // MARK: TDD 3: the Plan's Done bucket

    func testPlanQuerySplitsFinishedEpicsIntoADoneBucket() {
        let a1 = PlanArea(area: Area(id: "ar1", title: "A", description: nil, state: .active, rank: 1, ownerId: "asha", roomId: "r", threadId: "t", createdAt: "", updatedAt: ""),
                          epics: [card(item("open1", rank: 1), finished: false), card(item("fin1", status: .done, rank: 2), finished: true)])
        let a2 = PlanArea(area: Area(id: "ar2", title: "B", description: nil, state: .active, rank: 2, ownerId: "asha", roomId: "r", threadId: "t", createdAt: "", updatedAt: ""),
                          epics: [card(item("fin2", status: .done, rank: 1), finished: true), card(item("open2", rank: 2))])
        let plan = PlanResponse(areas: [a1, a2], unfiled: [card(item("fin3", status: .done), finished: true)], mine: [],
                                focus: Focus(epicIds: [], setBy: "owner", at: ""), counts: [:], board: nil)
        let q = PlanQuery()
        XCTAssertEqual(q.openEpics(a1.epics).map(\.id), ["open1"], "finished epics leave their area")
        XCTAssertEqual(q.openEpics(a2.epics).map(\.id), ["open2"])
        XCTAssertEqual(q.finishedEpics(plan).map(\.id), ["fin2", "fin3", "fin1"], "one bucket for every area and the unfiled, in the plan's order")

        var open = PlanQuery(); open.status = .open
        XCTAssertTrue(open.finishedEpics(plan).isEmpty, "the status filter still applies to the bucket")
        var text = PlanQuery(); text.text = "fin2"
        XCTAssertEqual(text.finishedEpics(plan).map(\.id), ["fin2"])
    }

    func testWithoutTheFinishedFieldADoneEpicCountsAsFinished() {
        XCTAssertTrue(card(item("d", status: .done)).isFinished)
        XCTAssertFalse(card(item("o")).isFinished)
        XCTAssertFalse(card(item("d2", status: .done), finished: false).isFinished, "the server's word wins")
    }

    // MARK: TDD 4–5: every status change carries a reason

    func testAStatusChangeWithoutAReasonIsNeverSent() async throws {
        let s = ItemsStore()
        for reason in ["", "  ", "ok"] {
            do {
                try await s.changeStatus(rest, id: "as_rework1", StatusChange(to: .ready, reason: reason))
                XCTFail("expected a refusal for reason '\(reason)'")
            } catch {
                XCTAssertEqual(error as? StatusChange.Invalid, .reason)
            }
        }
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty, "nothing reached the server")
    }

    func testAnUpdateThatChangesStatusOrAssigneeWithoutAReasonIsRefused() async throws {
        let s = ItemsStore()
        do { try await s.update(rest, id: "as_rework1", UpdateItemRequest(assigneeId: "dev")); XCTFail("expected a refusal") }
        catch { XCTAssertEqual(error as? StatusChange.Invalid, .reason) }
        do { try await s.update(rest, id: "as_rework1", UpdateItemRequest(status: .ready)); XCTFail("expected a refusal") }
        catch { XCTAssertEqual(error as? StatusChange.Invalid, .reason) }
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
    }

    func testParkedSendsReasonAndResumeWhen() async throws {
        let s = ItemsStore()
        do {
            try await s.changeStatus(rest, id: "as_rework1", StatusChange(to: .parked, reason: "After the release"))
            XCTFail("parked needs a resume-when")
        } catch { XCTAssertEqual(error as? StatusChange.Invalid, .resumeWhen) }
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)

        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("rework-item-story")) }
        try await s.changeStatus(rest, id: "as_rework1", StatusChange(to: .parked, reason: " After the release ", resumeWhen: "1.4 ships"))
        let b = try body()
        XCTAssertEqual(StubURLProtocol.recorded.last?.request.httpMethod, "POST")
        XCTAssertEqual(StubURLProtocol.recorded.last?.request.url?.path, "/api/items/as_rework1")
        XCTAssertEqual(b["status"] as? String, "parked")
        XCTAssertEqual(b["reason"] as? String, "After the release")
        XCTAssertEqual(b["resumeWhen"] as? String, "1.4 ships")
        XCTAssertNil(b["waitingOn"])
    }

    func testWaitingNeedsAPersonAndAskingTheOwnerNeedsARecommendation() async throws {
        let s = ItemsStore()
        do { try await s.changeStatus(rest, id: "as_rework1", StatusChange(to: .waiting, reason: "Needs QA")); XCTFail() }
        catch { XCTAssertEqual(error as? StatusChange.Invalid, .waitingOn) }
        do { try await s.changeStatus(rest, id: "as_rework1", StatusChange(to: .waiting, reason: "Needs a call", waitingOn: "owner")); XCTFail() }
        catch { XCTAssertEqual(error as? StatusChange.Invalid, .recommendation) }
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)

        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("rework-item-story")) }
        try await s.changeStatus(rest, id: "as_rework1", StatusChange(to: .waiting, reason: "Needs the QA profile", waitingOn: "tara"))
        let b = try body()
        XCTAssertEqual(b["status"] as? String, "waiting")
        XCTAssertEqual(b["waitingOn"] as? String, "tara")
        XCTAssertEqual(b["reason"] as? String, "Needs the QA profile")
        XCTAssertNil(b["resumeWhen"])
        XCTAssertEqual(s.details["as_rework1"]?.item.status, .waiting, "the server's answer is kept")
    }

    func testBlockedIsExternalOnlyAndCarriesItsReason() throws {
        let r = try StatusChange(to: .blocked, reason: "Apple review", blockedOn: "release").request()
        XCTAssertEqual(r.status, .blocked)
        XCTAssertEqual(r.waitingOn, "release")
        XCTAssertEqual(r.blockedReason, "Apple review")
        XCTAssertEqual(r.reason, "Apple review")
        XCTAssertThrowsError(try StatusChange(to: .blocked, reason: "Apple review", blockedOn: "tara").request())
    }

    func testAReassignCarriesTheReason() async throws {
        let s = ItemsStore()
        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("rework-item-story")) }
        try await s.update(rest, id: "as_rework1", UpdateItemRequest(assigneeId: "dev", reason: "Voice is his charter"))
        let b = try body()
        XCTAssertEqual(b["assigneeId"] as? String, "dev")
        XCTAssertEqual(b["reason"] as? String, "Voice is his charter")
    }

    // MARK: audit and chain, for the screen

    func testAuditReadsNewestFirstAndAMissingReasonIsNotRecorded() throws {
        let d = try Fixtures.decode("rework-item-story", as: ItemDetail.self)
        let rows = AuditEntry.newestFirst(d.audit ?? [])
        XCTAssertEqual(rows.first?.kind, .doc)
        XCTAssertEqual(rows.last?.kind, .created)
        XCTAssertEqual(rows.last?.reasonLine, "not recorded")
        let names: (String?) -> String = { $0 ?? "—" }
        let status = try XCTUnwrap(rows.first { $0.kind == .status })
        XCTAssertEqual(status.what(names), "In progress → Waiting")
        XCTAssertEqual(status.reasonLine, "Needs the QA device profile")
        XCTAssertEqual(rows.first { $0.kind == .assigned }?.what(names), "assigned to dev")
    }

    func testChainListsEveryPersonInOrder() throws {
        let chain = try XCTUnwrap(try Fixtures.decode("rework-item-story", as: ItemDetail.self).chain)
        XCTAssertEqual(chain.people.map(\.role), ["Developer", "Reviewer", "Extra reviewer", "QA", "Charter lead", "Chief of staff", "CTO"])
        XCTAssertEqual(chain.people.map(\.id), ["dev", "lead1", "sec1", "tara", "lead1", "asha", "cto"])
    }

    // MARK: Inbox COO note

    func testCooNoteDecodesFromTextOrAnObject() throws {
        let base = #""id":"in_1","kind":"decision","title":"t","body":"b","summary":"s","context":{},"options":[],"state":"open","raisedBy":"dev","createdAt":"c","affects":[]"#
        let plain = try JSONDecoder().decode(InboxItem.self, from: Data("{\(base),\"cooNote\":\"the release waits on this\"}".utf8))
        XCTAssertEqual(plain.cooNote?.text, "the release waits on this")
        let object = try JSONDecoder().decode(InboxItem.self, from: Data("{\(base),\"cooNote\":{\"text\":\"pick one\",\"at\":\"2026-10-10T06:00:00.000Z\"}}".utf8))
        XCTAssertEqual(object.cooNote?.text, "pick one")
        XCTAssertEqual(object.cooNote?.at, "2026-10-10T06:00:00.000Z")
        let none = try JSONDecoder().decode(InboxItem.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(none.cooNote)
        // Re-encodes in the shape it came in.
        let again = try JSONDecoder().decode(InboxItem.self, from: try JSONEncoder().encode(plain))
        XCTAssertEqual(again, plain)
    }

    // MARK: Settings: super focus

    func testSuperFocusReadsAndSets() async throws {
        StubURLProtocol.handler = { req in
            if req.httpMethod == "GET" { return (200, Data(#"{"until":null}"#.utf8)) }
            return (200, Data(#"{"until":"2026-10-10T10:00:00.000Z"}"#.utf8))
        }
        let s = SuperFocusStore()
        await s.load(rest)
        XCTAssertTrue(s.supported)
        XCTAssertNil(s.until)
        XCTAssertEqual(StubURLProtocol.recorded.last?.request.url?.path, "/api/settings/super-focus")
        try await s.set(rest, hours: 4)
        XCTAssertEqual(StubURLProtocol.recorded.last?.request.httpMethod, "POST")
        XCTAssertEqual(try body()["hours"] as? Int, 4)
        XCTAssertEqual(s.until, "2026-10-10T10:00:00.000Z")
        XCTAssertTrue(s.isActive(now: ISO8601DateFormatter().date(from: "2026-10-10T09:00:00Z")!))
        XCTAssertFalse(s.isActive(now: ISO8601DateFormatter().date(from: "2026-10-10T11:00:00Z")!))
    }

    func testSuperFocusOffSendsZero() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"until":null}"#.utf8)) }
        let s = SuperFocusStore()
        try await s.set(rest, hours: 0)
        XCTAssertEqual(try body()["hours"] as? Int, 0)
        XCTAssertNil(s.until)
    }

    func testAnOldServerWithoutSuperFocusHidesItQuietly() async {
        let s = SuperFocusStore()
        await s.load(rest)
        XCTAssertFalse(s.supported)
        XCTAssertNil(s.error, "a 404 is an older server, not an error")
    }

    // MARK: Settings: Mac queue

    func testMacQueueDecodesAnArrayOrAWrappedListAndFindsTheHead() async throws {
        let entries = #"[{"id":3,"emp":"dev","itemId":"as_1","minutes":30,"why":"robot suite","at":"2026-10-10T06:05:00.000Z","state":"queued"},"#
            + #"{"id":"2","employeeId":"tara","item_id":"as_2","minutes":20,"at":"2026-10-10T06:00:00.000Z","state":"granted"},"#
            + #"{"id":"4","emp":"kavya","at":"2026-10-10T06:01:00.000Z","state":"queued"},"#
            + #"{"id":"1","emp":"nikhil","at":"2026-10-10T05:00:00.000Z","state":"done"}]"#
        for payload in [entries, #"{"queue":"# + entries + "}"] {
            StubURLProtocol.reset()
            StubURLProtocol.handler = { _ in (200, Data(payload.utf8)) }
            let s = MacQueueStore()
            await s.load(rest)
            XCTAssertTrue(s.supported)
            XCTAssertEqual(StubURLProtocol.recorded.last?.request.url?.path, "/api/mac-queue")
            XCTAssertEqual(s.shown.map(\.id), ["2", "4", "3"], "the grant first, then the queue by time; finished ones hidden")
            XCTAssertEqual(s.head?.id, "4")
            XCTAssertEqual(s.shown.first?.emp, "tara")
            XCTAssertEqual(s.shown.first?.itemId, "as_2")
        }
    }

    func testGrantNowPostsAndReloads() async throws {
        StubURLProtocol.handler = { req in
            if req.httpMethod == "POST" { return (200, Data(#"{"ok":true}"#.utf8)) }
            return (200, Data(#"[{"id":"7","emp":"dev","state":"queued","at":"a"}]"#.utf8))
        }
        let s = MacQueueStore()
        await s.load(rest)
        try await s.grant(rest, id: "7")
        let paths = StubURLProtocol.recorded.map { "\($0.request.httpMethod!) \($0.request.url!.path)" }
        XCTAssertEqual(paths, ["GET /api/mac-queue", "POST /api/mac-queue/7/grant", "GET /api/mac-queue"])
    }

    func testAnOldServerWithoutAMacQueueHidesItQuietly() async {
        let s = MacQueueStore()
        await s.load(rest)
        XCTAssertFalse(s.supported)
        XCTAssertNil(s.error)
    }

    // MARK: statuses on the board

    func testTheBoardShowsWaitingAndParkedOnlyWhenTheServerKnowsThem() async throws {
        let p = PlanStore()
        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("live-plan-board")) }
        await p.loadBoard(rest)
        XCTAssertEqual(p.columns.map(\.status), [.backlog, .ready, .inProgress, .inReview, .blocked, .done], "an old server: the six columns it has")
        XCTAssertTrue(ItemStatus.order.contains(.waiting))
        XCTAssertTrue(ItemStatus.order.contains(.parked))
        XCTAssertEqual(ItemStatus.waiting.glyph.label, "Waiting")
        XCTAssertEqual(ItemStatus.parked.glyph.label, "Parked")
    }
}
