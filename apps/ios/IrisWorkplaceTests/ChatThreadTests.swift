import XCTest
@testable import IrisWorkplace

/// The unified Talk chat (owner's spec, 2 Oct): grouping, day separators, id chips, list order.
final class ChatThreadTests: XCTestCase {
    private func msg(_ id: String, _ at: String, mine: Bool, _ text: String = "x") -> ChatItem {
        ChatItem(id: id, at: at, kind: .message(mine: mine, text: text, details: nil))
    }

    func testConsecutiveSameSideMessagesGroupAndDaysSeparate() {
        let items = [
            msg("1", "2026-10-01T10:00:00.000Z", mine: true),
            msg("2", "2026-10-01T10:01:00.000Z", mine: true),
            msg("3", "2026-10-01T10:02:00.000Z", mine: false),
            msg("4", "2026-10-01T10:30:00.000Z", mine: false),
            msg("5", "2026-10-02T09:00:00.000Z", mine: false),
        ]
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        let rows = ChatLayout.rows(items, calendar: cal)
        XCTAssertNotNil(rows[0].day, "the first message gets a day")
        XCTAssertEqual(rows.map(\.continuesGroup), [false, true, false, false, false], "same side within 5 min groups; 28 min later starts anew")
        XCTAssertEqual(rows.map(\.groupContinues), [true, false, false, false, false])
        XCTAssertNotNil(rows[4].day, "a new day gets a separator")
        XCTAssertNil(rows[1].day)
    }

    func testANoteNeverGroups() {
        let note = ChatItem(id: "n", at: "2026-10-01T10:00:30.000Z", kind: .note(text: "worked", steps: [], error: false))
        let rows = ChatLayout.rows([msg("1", "2026-10-01T10:00:00.000Z", mine: false), note, msg("2", "2026-10-01T10:01:00.000Z", mine: false)])
        XCTAssertEqual(rows.map(\.continuesGroup), [false, false, false])
    }

    func testRawIdsBecomeTitledChipsNeverBareIds() {
        let text = "Blocked on as_muqecr89jhjst; see th_epic_ft_mummakwyuew19 and ft_unknown123."
        XCTAssertEqual(IdLinks.ids(in: text), ["as_muqecr89jhjst", "th_epic_ft_mummakwyuew19", "ft_unknown123"])
        let a = IdLinks.linkified(text, mine: false) { $0 == "as_muqecr89jhjst" ? "Mic stays live at volume 0" : nil }
        let plain = String(a.characters)
        XCTAssertFalse(plain.contains("as_muq"), plain)
        XCTAssertFalse(plain.contains("ft_unknown"), "an unknown id still never shows bare: \(plain)")
        XCTAssertTrue(plain.contains("Mic stays live at volume 0"))
        XCTAssertTrue(plain.contains("a thread") && plain.contains("an epic"))
        let links = a.runs.compactMap(\.link)
        XCTAssertEqual(links.map(\.absoluteString), ["irisworkplace://item/as_muqecr89jhjst", "irisworkplace://room/th_epic_ft_mummakwyuew19", "irisworkplace://item/ft_unknown123"])
        XCTAssertEqual(AppLink.parse(url: links[0]), .item("as_muqecr89jhjst"))
    }

    func testChatItemsNeverDropOrTruncateText() throws {
        let long = String(repeating: "word ", count: 200)
        let e = LogEntry(id: "a", agentId: "x", at: "2026-10-01T10:00:00.000Z", kind: .assistant, label: "", text: long, summary: "short", details: "more")
        guard case .message(let mine, let text, let details) = ChatItem.from(log: [e])[0].kind else { return XCTFail() }
        XCTAssertFalse(mine)
        XCTAssertEqual(text, long, "the whole text, never the summary line")
        XCTAssertEqual(details, "more", "only details folds")
    }

    func testTalkListPinsTheCooThenAshaThenByLastActivity() throws {
        let office = try Fixtures.decode("office", as: OfficeResponse.self)
        let cards = office.units.flatMap(\.employees)
        let ordered = TalkListView.ordered(cards + cards.prefix(1), chiefOfStaff: office.chiefOfStaff)
        XCTAssertEqual(ordered.count, cards.count, "no duplicate card")
        XCTAssertEqual(ordered[0].employee.virtual, true, "the COO first")
        XCTAssertEqual(ordered[1].employee.id, "asha", "Asha second")
        let rest = ordered.dropFirst(2).map { TalkListView.lastActivity($0) ?? "" }
        XCTAssertEqual(rest, rest.sorted(by: >), "then newest activity first")
    }
}

/// Typing comes only from a reply the owner is waiting for, never from a working state.
@MainActor
final class TypingRuleTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/employees/mira": return (200, try! Fixtures.data("employee-detail"))
            case "/api/agents/s-mira-1/log": return (200, try! Fixtures.data("agent-log"))
            case "/api/employees/mira/talk": return (200, try! Fixtures.data("agent"))
            case "/api/coo/message": return (200, Data(#"{"id":"cm_1","at":"2026-10-02T06:00:00.000Z","from":"owner","text":"hi"}"#.utf8))
            default: return (404, Data(#"{"error":"no route"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    func testAWorkingSessionAloneNeverTypes() async {
        let s = TalkStore()
        await s.select(rest, employeeId: "mira")
        var running = s.session!; running.status = .running
        s.handle(.agentUpdated(running))
        XCTAssertTrue(s.isRunning)
        XCTAssertFalse(s.isTyping(), "busy is not typing")
    }

    func testTypingFromSendUntilTheReplyOrTwoMinutes() async throws {
        let s = TalkStore()
        await s.select(rest, employeeId: "mira")
        try await s.send(rest, text: "status?")
        XCTAssertTrue(s.isTyping(), "a reply to the owner's message is pending")
        XCTAssertFalse(s.isTyping(now: Date().addingTimeInterval(121)), "two-minute safety timeout")
        let sid = s.session!.id
        s.handle(.agentLog(LogEntry(id: "r1", agentId: sid, at: "2026-10-02T06:00:01.000Z", kind: .bash, label: "Bash", text: "ls")))
        XCTAssertTrue(s.isTyping(), "a tool run is not the reply")
        s.handle(.agentLog(LogEntry(id: "r2", agentId: sid, at: "2026-10-02T06:00:02.000Z", kind: .assistant, label: "", text: "All green.")))
        XCTAssertFalse(s.isTyping(), "the reply landed")
    }

    func testCooTypesOnlyUntilTheCooAnswers() async throws {
        let c = CooStore()
        XCTAssertFalse(c.isTyping())
        try await c.send(rest, text: "hi")
        XCTAssertTrue(c.isTyping())
        c.handle(.cooMessage(CooMessage(id: "cm_2", at: "2026-10-02T06:00:05.000Z", from: .coo, text: "Here.")))
        XCTAssertFalse(c.isTyping())
    }
}
