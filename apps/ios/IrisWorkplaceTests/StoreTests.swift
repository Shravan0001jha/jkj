import XCTest
@testable import IrisWorkplace

@MainActor
final class StoreTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            let p = req.url!.path
            switch p {
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            case "/api/employees/mira": return (200, try! Fixtures.data("employee-detail"))
            case "/api/agents/s-mira-1/log": return (200, try! Fixtures.data("agent-log"))
            case "/api/features": return (200, try! Fixtures.data("features"))
            case "/api/features/f-errands": return (200, try! Fixtures.data("feature-detail"))
            case "/api/features/pivot": return (200, try! Fixtures.data("pivot-team"))
            default: return (404, Data(#"{"error":"no route \#(p)"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    // MARK: Office

    func testOfficeLoadsAndAppliesLiveUpdates() async throws {
        let s = OfficeStore()
        await s.load(rest)
        XCTAssertNil(s.error)
        XCTAssertEqual(s.data?.units.count, 4)
        XCTAssertEqual(s.data?.needsYou, 5)
        XCTAssertEqual(s.data?.spend.companyInr, 412.5)

        var card = s.card("mira")!
        XCTAssertEqual(card.employee.state, .needsOwner)
        card.employee.state = .working
        card.needsYou = 0
        s.handle(.officeUpdated(card))
        XCTAssertEqual(s.card("mira")?.employee.state, .working)
        XCTAssertEqual(s.data?.needsYou, 4, "needs-you is recomputed from the cards")

        var moved = s.card("kabir")!
        moved.employee.unitId = "platforms"
        s.handle(.officeUpdated(moved))
        XCTAssertEqual(s.data?.units.first { $0.unit.id == "capabilities" }?.employees.map(\.id), ["dev", "mira"])
        XCTAssertTrue(s.data!.units.first { $0.unit.id == "platforms" }!.employees.contains { $0.id == "kabir" })

        var spend = s.data!.spend
        spend.companyInr = 999
        s.handle(.spendUpdated(spend))
        XCTAssertEqual(s.data?.spend.companyInr, 999)
    }

    func testOfficeSnapshotReplacesTheWholeOffice() async throws {
        let s = OfficeStore()
        XCTAssertNil(s.data)
        var office = try Fixtures.decode("office", as: OfficeResponse.self)
        office.needsYou = 1
        s.handle(.officeSnapshot(office))
        XCTAssertEqual(s.data?.needsYou, 1, "a snapshot fills an empty store")
        office.needsYou = 3
        s.handle(.officeSnapshot(office))
        XCTAssertEqual(s.data?.needsYou, 3, "and replaces a loaded one")
    }

    func testOfficeKeepsOldDataOnALoadError() async {
        let s = OfficeStore()
        await s.load(rest)
        StubURLProtocol.handler = { _ in (500, Data(#"{"error":"boom"}"#.utf8)) }
        await s.load(rest)
        XCTAssertEqual(s.error, "boom")
        XCTAssertEqual(s.data?.units.count, 4)
    }

    // MARK: Inbox

    func testInboxSortsOpenFirstNewestFirst() async {
        let s = InboxStore()
        await s.load(rest)
        XCTAssertEqual(s.open.map(\.id), ["ib-1", "ib-5", "ib-2", "ib-3", "ib-4"])
        XCTAssertEqual(s.closed.map(\.id), ["ib-8", "ib-6", "ib-7"])
    }

    func testInboxAnswerFlipsOnlyAfterTheServerConfirms() async throws {
        let s = InboxStore()
        await s.load(rest)
        var answered = s.item("ib-1")!
        answered.state = .answered
        answered.answer = InboxAnswer(optionId: "approve", note: nil, at: "2026-09-27T10:00:00.000Z", via: .phone)
        let confirmed = answered
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/api/inbox/ib-1/answer")
            return (200, try! JSONEncoder().encode(confirmed))
        }
        try await s.answer(rest, id: "ib-1", optionId: "approve", note: nil)
        XCTAssertEqual(s.item("ib-1")?.state, .answered)
        XCTAssertEqual(s.item("ib-1")?.answer?.via, .phone)
        XCTAssertEqual(s.open.count, 4)
        XCTAssertTrue(s.answering.isEmpty)
    }

    func testInboxAnswerErrorLeavesTheItemOpen() async {
        let s = InboxStore()
        await s.load(rest)
        StubURLProtocol.handler = { _ in (409, Data(#"{"error":"Already answered"}"#.utf8)) }
        do {
            try await s.answer(rest, id: "ib-1", optionId: "approve", note: nil)
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? WorkplaceError, .server(status: 409, message: "Already answered"))
        }
        XCTAssertEqual(s.item("ib-1")?.state, .open)
        XCTAssertTrue(s.answering.isEmpty)
    }

    func testInboxUpsertsSocketUpdates() async {
        let s = InboxStore()
        await s.load(rest)
        var item = s.item("ib-2")!
        item.state = .answered
        s.handle(.inboxUpdated(item))
        XCTAssertEqual(s.open.count, 4)
        var fresh = item
        fresh.id = "ib-9"; fresh.state = .open; fresh.createdAt = "2026-09-27T12:00:00.000Z"
        s.handle(.inboxUpdated(fresh))
        XCTAssertEqual(s.open.first?.id, "ib-9")
        XCTAssertEqual(s.items.count, 9)
    }

    // MARK: Talk

    func testTalkSelectsTheLiveSessionAndLoadsItsLog() async {
        let s = TalkStore()
        await s.select(rest, employeeId: "mira")
        XCTAssertNil(s.error)
        XCTAssertEqual(s.detail?.employee.name, "Mira")
        XCTAssertEqual(s.session?.id, "s-mira-1")
        XCTAssertEqual(s.log.count, 7)
        XCTAssertEqual(s.pendingApproval?.tool, "Bash")
        XCTAssertFalse(s.isRunning)
    }

    func testCurrentSessionPrefersLiveThenNewest() {
        let base = try! Fixtures.decode("agent", as: Agent.self)
        var old = base; old.id = "old"; old.status = .done; old.startedAt = "2026-09-27T01:00:00.000Z"
        var newer = base; newer.id = "newer"; newer.status = .error; newer.startedAt = "2026-09-27T05:00:00.000Z"
        var live = base; live.id = "live"; live.status = .running; live.startedAt = "2026-09-27T02:00:00.000Z"
        XCTAssertEqual(TalkStore.currentSession([old, newer, live])?.id, "live")
        XCTAssertEqual(TalkStore.currentSession([old, newer])?.id, "newer")
        XCTAssertNil(TalkStore.currentSession([]))
    }

    func testTalkAppendsLogForItsSessionOnlyAndDedupes() async {
        let s = TalkStore()
        await s.select(rest, employeeId: "mira")
        let entry = LogEntry(id: "l-8", agentId: "s-mira-1", at: "2026-09-27T09:10:00.000Z", kind: .assistant, label: "", text: "48 passed.")
        s.handle(.agentLog(entry))
        s.handle(.agentLog(entry))
        XCTAssertEqual(s.log.count, 8)
        var other = entry; other.id = "l-x"; other.agentId = "s-asha-1"
        s.handle(.agentLog(other))
        XCTAssertEqual(s.log.count, 8)
        var updated = s.session!
        updated.status = .running; updated.approval = nil
        s.handle(.agentUpdated(updated))
        XCTAssertTrue(s.isRunning)
        XCTAssertNil(s.pendingApproval)
        s.handle(.agentRemoved(agentId: "s-mira-1"))
        XCTAssertNil(s.session)
        XCTAssertTrue(s.log.isEmpty)
    }

    func testTalkSendSwitchesToTheReturnedSession() async throws {
        let s = TalkStore()
        await s.select(rest, employeeId: "mira")
        var fresh = s.session!
        fresh.id = "s-mira-2"; fresh.status = .running
        let returned = fresh
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/employees/mira/talk":
                return (200, try! JSONEncoder().encode(returned))
            case "/api/agents/s-mira-2/log": return (200, Data("[]".utf8))
            default: return (404, Data(#"{"error":"nope"}"#.utf8))
            }
        }
        try await s.send(rest, text: "status?")
        XCTAssertEqual(s.session?.id, "s-mira-2")
        XCTAssertTrue(s.log.isEmpty, "a new session starts with its own (empty) log")
    }

    // MARK: Features

    func testFeaturesBoardGroupsByStateInMachineOrder() async {
        let s = FeaturesStore()
        await s.load(rest)
        XCTAssertEqual(s.byState.map(\.state), [.stated, .specced, .inProgress, .built, .released])
        XCTAssertEqual(s.byState.first?.features.count, 2)
        await s.loadDetail(rest, id: "f-errands")
        XCTAssertEqual(s.details["f-errands"]?.assignments.count, 5)
        await s.loadPivot(rest, rows: .team)
        XCTAssertEqual(s.pivots[.team]?.rows, ["capabilities", "platforms", "product", "quality"])
    }

    func testFeaturesApplyWorkUpdates() async {
        let s = FeaturesStore()
        await s.load(rest)
        await s.loadDetail(rest, id: "f-errands")
        var f = s.board!.features.first { $0.id == "f-errands" }!
        f.state = .built
        s.handle(.workUpdated(f))
        XCTAssertEqual(s.board?.features.first { $0.id == "f-errands" }?.state, .built)
        XCTAssertEqual(s.board?.byState["built"], 2)
        XCTAssertEqual(s.board?.byState["in-progress"], nil)
        XCTAssertEqual(s.details["f-errands"]?.feature.state, .built)
        var a = s.details["f-errands"]!.assignments[1]
        a.state = .building
        s.handle(.workUpdated(a))
        XCTAssertEqual(s.details["f-errands"]?.assignments[1].state, .building)
        var novel = a; novel.id = "a-9"
        s.handle(.workUpdated(novel))
        XCTAssertEqual(s.details["f-errands"]?.assignments.count, 6)
    }

    // MARK: Alerts

    func testAlertsBannerAndNotificationWhenNotActive() {
        let n = FakeNotifier()
        let s = AlertsStore(notifier: n)
        var active = true
        s.isActive = { active }
        let a = AlertEvent(level: .needsYou, title: "Mira needs you", body: "Approve pytest?", inboxId: "ib-5")
        s.handle(.alert(a))
        XCTAssertEqual(s.banner?.event, a)
        XCTAssertEqual(s.unread, 1)
        XCTAssertTrue(n.delivered.isEmpty, "no local notification while the app is on screen")
        active = false
        s.handle(.alert(AlertEvent(level: .cap, title: "Cap", body: "₹1000", inboxId: nil)))
        XCTAssertEqual(n.delivered.count, 1)
        XCTAssertEqual(s.alerts.count, 2)
        XCTAssertEqual(s.alerts.first?.event.level, .cap, "newest first")
        s.dismissBanner()
        XCTAssertNil(s.banner)
        s.markAllRead()
        XCTAssertEqual(s.unread, 0)
        s.handle(.spendUpdated(try! Fixtures.decode("spend", as: SpendSummary.self)))
        XCTAssertEqual(s.alerts.count, 2, "other events are ignored")
    }
}

@MainActor
final class RoomStoreTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch (req.httpMethod ?? "GET", req.url!.path) {
            case ("GET", "/api/room"): return (200, try! Fixtures.data("room"))
            case ("GET", "/api/room/rt-socket"): return (200, try! Fixtures.data("room-thread"))
            default: return (404, Data(#"{"error":"no route \#(req.url!.path)"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    func testThreadsSortOpenFirstThenNewest() async {
        let s = RoomStore()
        await s.load(rest)
        XCTAssertNil(s.error)
        XCTAssertEqual(s.open.map(\.id), ["rt-socket", "rt-release", "rt-voice", "rt-split"])
        XCTAssertEqual(s.resolved.map(\.id), ["rt-lipsync"])
        XCTAssertEqual(s.thread("rt-lipsync")?.summary?.isEmpty, false)
    }

    func testThreadMessagesLoadAndLiveUpdatesAppendOnce() async {
        let s = RoomStore()
        await s.load(rest)
        await s.loadThread(rest, id: "rt-socket")
        XCTAssertEqual(s.messages["rt-socket"]?.count, 4)
        let thread = s.thread("rt-socket")!
        let m = RoomMessage(id: "m-new", threadId: "rt-socket", at: "2026-09-27T12:00:00.000Z", by: "mira", owner: false, text: "Published the shape.", mentions: ["kabir"])
        var t2 = thread; t2.lastAt = m.at; t2.messageCount = 5
        s.handle(.roomMessage(m, thread: t2))
        s.handle(.roomMessage(m, thread: t2))
        XCTAssertEqual(s.messages["rt-socket"]?.count, 5)
        XCTAssertEqual(s.thread("rt-socket")?.messageCount, 5)
        XCTAssertTrue(s.unread.contains("rt-socket"), "an employee's message marks the thread unread")
        s.markRead("rt-socket")
        XCTAssertFalse(s.unread.contains("rt-socket"))
        let mine = RoomMessage(id: "m-own", threadId: "rt-socket", at: "2026-09-27T12:01:00.000Z", by: "owner", owner: true, text: "Thanks.", mentions: [])
        s.handle(.roomMessage(mine, thread: t2))
        XCTAssertFalse(s.unread.contains("rt-socket"), "the owner's own message is not unread")
        var resolved = t2; resolved.state = .resolved; resolved.summary = "Reuse ask_mac."
        s.handle(.roomThread(resolved))
        XCTAssertEqual(s.resolved.map(\.id).sorted(), ["rt-lipsync", "rt-socket"])
    }

    func testPostShowsTheMessageOnlyAfterTheServerReturnedIt() async throws {
        let s = RoomStore()
        await s.load(rest)
        await s.loadThread(rest, id: "rt-socket")
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/api/room/rt-socket/messages")
            let m = RoomMessage(id: "m-99", threadId: "rt-socket", at: "2026-09-27T13:00:00.000Z", by: "owner", owner: true, text: "Reuse ask_mac. @kabir go ahead.", mentions: ["kabir"])
            return (200, try! JSONEncoder().encode(m))
        }
        try await s.post(rest, threadId: "rt-socket", text: "Reuse ask_mac. @kabir go ahead.", mentions: ["kabir"])
        XCTAssertEqual(s.messages["rt-socket"]?.last?.id, "m-99")
        XCTAssertEqual(s.messages["rt-socket"]?.last?.owner, true)
        StubURLProtocol.handler = { _ in (500, Data(#"{"error":"boom"}"#.utf8)) }
        await XCTAssertThrowsErrorAsync(try await s.post(rest, threadId: "rt-socket", text: "again", mentions: []))
        XCTAssertEqual(s.messages["rt-socket"]?.count, 5, "a failed post adds nothing")
    }

    func testMentionsAreParsedAgainstKnownEmployees() {
        let known = ["asha", "dev", "mira", "kabir"]
        XCTAssertEqual(RoomStore.mentions(in: "@mira and @Kabir, see @asha. @nobody @mira", known: known), ["mira", "kabir", "asha"])
        XCTAssertEqual(RoomStore.mentions(in: "no mentions here", known: known), [])
    }
}

final class CompactTextTests: XCTestCase {
    func testFirstLineIsTheSummaryWhenTheServerSendsNone() {
        let c = CompactText(text: "Not published yet. The errand expert validates the shape.\n\nDetails: source is phone or cloud.")
        XCTAssertEqual(c.line, "Not published yet. The errand expert validates the shape.")
        XCTAssertEqual(c.details, "Details: source is phone or cloud.")
        XCTAssertTrue(c.hasDetails)
    }

    func testSingleLineHasNoDetails() {
        let c = CompactText(text: "Merged as 8034a09.")
        XCTAssertEqual(c.line, "Merged as 8034a09.")
        XCTAssertFalse(c.hasDetails)
    }

    func testLeadingBlankLinesAreSkippedAndLongLinesTruncated() {
        let c = CompactText(text: "\n\nA first line after blanks\nmore")
        XCTAssertEqual(c.line, "A first line after blanks")
        XCTAssertEqual(c.details, "more")
        let long = CompactText(text: String(repeating: "word ", count: 60))
        XCTAssertLessThanOrEqual(long.line.count, 160)
        XCTAssertTrue(long.line.hasSuffix("…"))
        XCTAssertTrue(long.hasDetails)
    }

    func testAHeadingAloneCarriesTheNextLine() {
        let c = CompactText(text: "## Plan\n1. Add an `errand` expert that validates the instruction.\n2. Run it through the act-then-ack path.")
        XCTAssertEqual(c.line, "Plan — 1. Add an `errand` expert that validates the instruction.")
        XCTAssertEqual(c.details, "2. Run it through the act-then-ack path.")
        XCTAssertEqual(CompactText.plain("### Done"), "Done")
        XCTAssertEqual(CompactText.plain("- bullet"), "bullet")
    }

    func testServerSummaryWinsWhenPresent() {
        let c = CompactText(text: "Long body\nwith lines", summary: "Short summary", details: "Long body\nwith lines")
        XCTAssertEqual(c.line, "Short summary")
        XCTAssertEqual(c.details, "Long body\nwith lines")
        let same = CompactText(text: "Just this", summary: "Just this")
        XCTAssertFalse(same.hasDetails, "summary equal to the text means nothing to expand")
    }
}

@MainActor
final class EmployeeNeedsYouTests: XCTestCase {
    func testNeedsYouFollowsInboxUpdates() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/employees/mira": return (200, try! Fixtures.data("employee-detail"))
            case "/api/agents/s-mira-1/log": return (200, try! Fixtures.data("agent-log"))
            default: return (404, Data(#"{"error":"no"}"#.utf8))
            }
        }
        let rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!), tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
        let s = TalkStore()
        await s.select(rest, employeeId: "mira")
        XCTAssertEqual(s.detail?.needsYou.map(\.id), ["ib-5"])
        var answered = s.detail!.needsYou[0]
        answered.state = .answered
        s.handle(.inboxUpdated(answered))
        XCTAssertEqual(s.detail?.needsYou.count, 0, "answered anywhere → gone from the employee page")
        var fresh = try Fixtures.decode("inbox", as: [InboxItem].self).first { $0.id == "ib-1" }!
        fresh.affects = ["mira"]
        s.handle(.inboxUpdated(fresh))
        XCTAssertEqual(s.detail?.needsYou.map(\.id), ["ib-1"], "a new open item that affects her appears")
        var other = fresh; other.id = "ib-x"; other.affects = ["dev"]; other.raisedBy = "dev"
        s.handle(.inboxUpdated(other))
        XCTAssertEqual(s.detail?.needsYou.count, 1, "items about someone else stay away")
    }
}

@MainActor
final class RequestsStoreTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch (req.httpMethod ?? "GET", req.url!.path) {
            case ("GET", "/api/requests"): return (200, try! Fixtures.data("requests"))
            case ("POST", "/api/requests"):
                let f = try! Fixtures.decode("features", as: FeatureBoard.self).features[1]
                let r = RequestResponse(feature: f, status: RequestStatus(stage: .withAsha, line: "Asha is writing the spec", assignments: [], askedAgentId: nil))
                return (201, try! JSONEncoder().encode(r))
            default: return (404, Data(#"{"error":"no"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!), tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    func testLoadCreateAndLiveStatus() async throws {
        let s = RequestsStore()
        await s.load(rest)
        XCTAssertEqual(s.items.count, 3)
        XCTAssertEqual(s.status(for: "f-errands")?.stage, .blocked)
        XCTAssertEqual(s.status(for: "f-errands")?.askedAgentId, "s-asha-1")
        let r = try await s.create(rest, text: "Push alerts", platformIds: ["ios"])
        XCTAssertEqual(s.items.first?.feature.id, r.feature.id)
        XCTAssertEqual(s.status(for: r.feature.id)?.stage, .withAsha)
        var f = r.feature; f.state = .specced
        s.handle(.workUpdated(f))
        XCTAssertEqual(s.status(for: r.feature.id)?.stage, .specced, "a feature update moves the stage until the server's status arrives")
        XCTAssertEqual(s.latestFeature(r.feature).state, .specced)
        var a = try Fixtures.decode("feature-detail", as: FeatureDetail.self).assignments[1]
        a.state = .building
        s.handle(.workUpdated(a))
        XCTAssertEqual(s.status(for: "f-errands")?.assignments.first { $0.id == a.id }?.state, .building)
        let board = try Fixtures.decode("features", as: FeatureBoard.self)
        s.absorb(board)
        XCTAssertEqual(s.status(for: "f-errands")?.stage, .blocked, "the board's status is authoritative")
    }
}
