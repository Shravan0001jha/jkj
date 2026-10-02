import XCTest
@testable import IrisWorkplace

/// Every response type decodes from a fixture shaped by the contract and re-encodes to the same
/// JSON. A field the Swift model lacks, misnames or mistypes fails here.
final class ContractTests: XCTestCase {
    private func roundTrip<T: Codable & Equatable>(_ name: String, _ type: T.Type) throws {
        let decoded = try Fixtures.decode(name, as: T.self)
        let reencoded = try jsonObject(decoded)
        // `x: T | null` in TypeScript is `T?` in Swift, which encodes as an absent key: strip nulls before comparing.
        let original = stripNulls(try Fixtures.json(name))
        XCTAssertTrue((reencoded as AnyObject).isEqual(original), "\(name): re-encoded JSON differs from the fixture (a field is missing, renamed or mistyped in \(T.self)):\n\(diff(original, reencoded))")
        let again = try JSONDecoder().decode(T.self, from: try JSONEncoder().encode(decoded))
        XCTAssertEqual(again, decoded)
    }

    func testHealth() throws { try roundTrip("health", WorkplaceHealthResponse.self) }

    func testMacHealthLinesFromResilience() throws {
        let h = try Fixtures.decode("health", as: WorkplaceHealthResponse.self)
        let r = try XCTUnwrap(h.resilience)
        let now = Format.date("2026-09-27T09:00:00.000Z")!
        XCTAssertTrue(r.onBattery)
        XCTAssertTrue(r.sleptRecently(now: now))
        XCTAssertEqual(r.macLine(now: now), "on battery 62% · slept 1×, last 20 min ago")
        XCTAssertEqual(r.officeWarning(now: now), "Mac is on battery — Workplace may drop when it sleeps")
        XCTAssertEqual(h.workplace.push?.sentToday, 3)

        var ac = r
        ac.power = Resilience.Power(source: "ac", percent: 100, charging: true, readAt: nil)
        XCTAssertEqual(ac.officeWarning(now: now), "Mac slept 1× recently — sessions may have paused", "a recent sleep still warns on charger")
        XCTAssertNil(ac.officeWarning(now: now.addingTimeInterval(2 * 3600)), "an old sleep does not")
        ac.sleeps = Resilience.Sleeps(count: 0, lastAt: nil, lastSeconds: 0, totalSeconds: 0)
        XCTAssertEqual(ac.macLine(now: now), "on charger · awake")
        XCTAssertNil(ac.officeWarning(now: now))
        ac.tunnel?.status = "reconnecting"
        XCTAssertEqual(ac.officeWarning(now: now), "Mac's tunnel is reconnecting — the relay may not reach it")

        // An older server without the block still decodes.
        let old = Data(#"{"ok":true,"name":"jkj","version":"0.1.0","uptimeSeconds":1,"claudeHome":null,"workplace":{"dataDir":"/x","capInr":1000,"day":"2026-09-29","telegram":true,"published":"connected"}}"#.utf8)
        let decoded = try JSONDecoder().decode(WorkplaceHealthResponse.self, from: old)
        XCTAssertNil(decoded.resilience); XCTAssertNil(decoded.workplace.push)
        XCTAssertEqual(Format.duration(24_000), "6 h 40 min")
    }
    func testOffice() throws { try roundTrip("office", OfficeResponse.self) }
    func testOrg() throws { try roundTrip("org", OrgResponse.self) }
    func testCharter() throws { try roundTrip("charter", Charter.self) }
    func testInbox() throws { try roundTrip("inbox", [InboxItem].self) }
    func testEmployees() throws { try roundTrip("employees", [Employee].self) }
    func testEmployeeDetail() throws { try roundTrip("employee-detail", EmployeeDetail.self) }
    func testAgent() throws { try roundTrip("agent", Agent.self) }
    func testAgentLog() throws { try roundTrip("agent-log", [LogEntry].self) }
    func testFeatures() throws { try roundTrip("features", FeatureBoard.self) }
    func testFeatureDetail() throws { try roundTrip("feature-detail", FeatureDetail.self) }
    func testPivots() throws {
        try roundTrip("pivot-charter", Pivot.self)
        try roundTrip("pivot-platform", Pivot.self)
        try roundTrip("pivot-team", Pivot.self)
    }
    func testRequirements() throws { try roundTrip("requirements", [Requirement].self) }
    func testCoverage() throws { try roundTrip("coverage", Coverage.self) }
    func testSpend() throws { try roundTrip("spend", SpendSummary.self) }
    func testSpendEntries() throws { try roundTrip("spend-entries", [SpendEntry].self) }
    func testRequestsProposalDetailAndReleasesReady() throws {
        try roundTrip("requests", [RequestResponse].self)
        try roundTrip("proposal-detail", ProposalDetail.self)
        try roundTrip("releases-ready", [ReleaseReadiness].self)
        let office = try Fixtures.decode("office", as: OfficeResponse.self)
        XCTAssertEqual(office.chiefOfStaff, "asha")
        let board = try Fixtures.decode("features", as: FeatureBoard.self)
        XCTAssertEqual(board.status["f-errands"]?.stage, .blocked)
        XCTAssertEqual(board.status["f-push"]?.stage, .withAsha)
        let pivot = try Fixtures.decode("pivot-charter", as: Pivot.self)
        XCTAssertEqual(pivot.cells["desktop-mac"]?["f-errands"]?.items.first?.evidence?.tests, "212 passed, 0 failed")
    }

    func testRoom() throws {
        try roundTrip("room", RoomResponse.self)
        try roundTrip("room-thread", RoomThreadDetail.self)
    }

    func testNewContractFieldsAreCarried() throws {
        let office = try Fixtures.decode("office", as: OfficeResponse.self)
        XCTAssertEqual(office.counts, OfficeCounts(working: 2, blocked: 1, stalled: 1, needsYou: 5, total: 8), "seven office employees plus the COO")
        XCTAssertEqual(office.cards().first { $0.employee.id == "tara" }?.employee.stateReason, "Paused — daily budget reached (₹150). You can still talk to Tara.")
        XCTAssertEqual(office.spend.bySource["anthropic-api"], 318.0)
        XCTAssertEqual(office.spend.subscription.windows.map(\.window), [.fiveHour, .sevenDay, .sevenDayOpus])
        XCTAssertEqual(office.spend.subscription.windows[1].status, .allowedWarning)
        let detail = try Fixtures.decode("employee-detail", as: EmployeeDetail.self)
        XCTAssertEqual(detail.needsYou.map(\.id), ["ib-5"])
        let inbox = try Fixtures.decode("inbox", as: [InboxItem].self)
        let release = inbox.first { $0.id == "ib-1" }!
        XCTAssertEqual(release.affects, ["nikhil", "rohan", "asha"])
        XCTAssertNotNil(release.onApprove); XCTAssertNotNil(release.onDeny)
        XCTAssertEqual(release.links?.count, 2)
        XCTAssertEqual(release.links?[1].roomThreadId, "rt-release")
        XCTAssertNil(release.links?[0].roomThreadId)
        XCTAssertEqual(release.links?[0].url?.host, "github.com")
        XCTAssertEqual(inbox.first { $0.id == "ib-8" }?.answer?.via, .workplace)
        let feature = try Fixtures.decode("feature-detail", as: FeatureDetail.self)
        XCTAssertEqual(feature.assignments.first { $0.id == "a-2" }?.stalledSince?.isEmpty, false)
        let health = try Fixtures.decode("health", as: WorkplaceHealthResponse.self)
        XCTAssertEqual(health.workplace.published, .connected)
    }
    func testSignals() throws { try roundTrip("signals", HealthSignals.self) }
    func testRelease() throws { try roundTrip("release", Release.self) }
    func testProposal() throws { try roundTrip("proposal", OrgProposal.self) }
    func testRoute() throws { try roundTrip("route", RouteResult.self) }
    func testPair() throws {
        try roundTrip("pair", PairResponse.self)
        try roundTrip("pair-exchange", PairExchangeResponse.self)
    }

    func testOfficeFixtureHasEveryEmployeeState() throws {
        let office = try Fixtures.decode("office", as: OfficeResponse.self)
        let cards = office.units.flatMap(\.employees)
        // online/offline is the COO bridge's presence, not a work state: only a virtual employee
        // ever has it, and a single snapshot can only show her one way at a time (see
        // OfficeStoreTests for the online↔offline flip itself).
        let workStates = Set(EmployeeState.known).subtracting([.online, .offline])
        let states = Set(cards.map(\.employee.state)).subtracting([.online, .offline])
        XCTAssertEqual(states, workStates, "the office fixture must exercise every work state")
        XCTAssertTrue(cards.contains { $0.employee.virtual == true && $0.employee.state == .online }, "the COO's card is there too")
        XCTAssertEqual(cards.count, 8, "seven ordinary employees plus the COO")
    }

    func testInboxFixtureHasEveryKindAndState() throws {
        let items = try Fixtures.decode("inbox", as: [InboxItem].self)
        XCTAssertEqual(Set(items.map(\.kind)), Set(InboxKind.known))
        XCTAssertEqual(Set(items.map(\.state)), Set(InboxState.known))
        XCTAssertTrue(items.contains { $0.options.contains { $0.danger == true } })
        XCTAssertTrue(items.contains { $0.options.contains { $0.needsNote == true } })
        XCTAssertEqual(items.first { $0.id == "ib-6" }?.answer?.via, .telegram)
    }

    func testInboxContextIsArbitraryJSON() throws {
        let items = try Fixtures.decode("inbox", as: [InboxItem].self)
        let release = items.first { $0.id == "ib-1" }!
        XCTAssertEqual(release.context["action"], .string("release"))
        guard case .array(let unreleased)? = release.context["unreleased"] else { return XCTFail("unreleased should be an array") }
        XCTAssertEqual(unreleased.count, 3)
        XCTAssertEqual(JSONValue.number(150).display, "150")
        XCTAssertEqual(JSONValue.number(1.5).display, "1.5")
        XCTAssertEqual(JSONValue.bool(true).display, "yes")
        XCTAssertEqual(JSONValue.null.display, "—")
    }

    func testWorkStateIsTheUnionOfFeatureAndAssignmentStates() {
        XCTAssertEqual(Set(WorkState.featureStates + WorkState.assignmentStates), Set(WorkState.known))
        XCTAssertEqual(WorkState.inProgress.rawValue, "in-progress")
    }

    func testEveryKnownServerEventDecodes() throws {
        let raw = try Fixtures.json("events") as! [[String: Any]]
        let data = try Fixtures.data("events")
        let events = try JSONDecoder().decode([ServerEvent].self, from: data)
        XCTAssertEqual(events.count, raw.count)
        var seen: Set<String> = []
        for (i, e) in events.enumerated() {
            let type = raw[i]["type"] as! String
            if case .unknown(let t) = e {
                XCTAssertEqual(t, "future.event", "known event type \(type) decoded as unknown")
            } else {
                seen.insert(type)
            }
        }
        XCTAssertEqual(seen, Set(ServerEvent.knownTypes), "the events fixture must cover every known event type")
    }

    func testEventPayloadsAreDecodedNotJustRecognised() throws {
        let events = try Fixtures.decode("events", as: [ServerEvent].self)
        guard case .alert(let a) = events.first(where: { if case .alert = $0 { return true } else { return false } })! else { return XCTFail() }
        XCTAssertEqual(a.level, .needsYou)
        XCTAssertEqual(a.inboxId, "ib-5")
        guard case .snapshot(let agents) = events[1] else { return XCTFail("second event is the snapshot") }
        XCTAssertEqual(agents.count, 4)
        guard case .agentUpdated(let agent) = events[2] else { return XCTFail() }
        XCTAssertEqual(agent.approval?.tool, "Bash")
        XCTAssertEqual(agent.status, .waiting)
        guard case .roomMessage(let message, let thread) = events.first(where: { if case .roomMessage = $0 { return true } else { return false } })! else { return XCTFail() }
        XCTAssertEqual(message.threadId, thread.id)
        XCTAssertEqual(message.by, "workplace")
    }

    func testClientCommandsEncodeToTheContract() throws {
        let cases: [(ClientCommand, [String: Any])] = [
            (.subscribe(projectId: "p"), ["type": "subscribe", "projectId": "p"]),
            (.agentMessage(agentId: "a", text: "hi"), ["type": "agent.message", "agentId": "a", "text": "hi"]),
            (.agentInterrupt(agentId: "a"), ["type": "agent.interrupt", "agentId": "a"]),
            (.agentApprove(agentId: "a", approvalId: "ap", decision: .always), ["type": "agent.approve", "agentId": "a", "approvalId": "ap", "decision": "always"]),
            (.agentMode(agentId: "a", mode: .acceptEdits), ["type": "agent.mode", "agentId": "a", "mode": "acceptEdits"]),
            (.inboxAnswer(id: "i", optionId: "approve", note: nil), ["type": "inbox.answer", "id": "i", "optionId": "approve"]),
            (.inboxAnswer(id: "i", optionId: "reject", note: "why"), ["type": "inbox.answer", "id": "i", "optionId": "reject", "note": "why"]),
        ]
        var types: Set<String> = []
        for (cmd, expected) in cases {
            let obj = try jsonObject(cmd) as! [String: Any]
            XCTAssertTrue((obj as NSDictionary).isEqual(to: expected), "\(cmd) encoded as \(obj)")
            types.insert(expected["type"] as! String)
        }
        XCTAssertEqual(types, Set(ClientCommand.knownTypes))
    }

    func testUnknownEnumValueFallsBackInsteadOfFailing() throws {
        // Was: a decoding error. RCA (v2): one new kind on the server failed the whole `[InboxItem]`
        // decode and blanked the Inbox. An unknown value now decodes as `.unknown`; a missing
        // required field is still an error.
        let unknown = Data(#"{"id":"x","kind":"bribe","title":"","body":"","context":{},"options":[],"state":"open","raisedBy":"","createdAt":"","affects":[],"summary":""}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(InboxItem.self, from: unknown).kind, .unknown)
        let missing = Data(#"{"id":"x","kind":"decision","title":"","body":"","context":{},"options":[],"state":"open","raisedBy":"","createdAt":""}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(InboxItem.self, from: missing))
    }
}
