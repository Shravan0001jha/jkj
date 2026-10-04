import XCTest
@testable import IrisWorkplace

/// The v2 stores, fed by the live fixtures over a stubbed REST client and by socket events.
@MainActor
final class V2StoreTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            let p = req.url!.path
            let q = req.url!.query ?? ""
            switch (p, q) {
            case ("/api/plan", ""): return (200, try! Fixtures.data("live-plan"))
            case ("/api/plan", "view=board"): return (200, try! Fixtures.data("live-plan-board"))
            case ("/api/items/ft_mummakwyuew19", _): return (200, try! Fixtures.data("live-item-epic"))
            case ("/api/items/as_muqecr89jhjst", _): return (200, try! Fixtures.data("live-item-story"))
            case ("/api/updates", _): return (200, try! Fixtures.data("live-updates"))
            case ("/api/rooms", _): return (200, try! Fixtures.data("live-rooms"))
            case ("/api/rooms/area:ar_muqhzr5khct7v", _): return (200, try! Fixtures.data("live-room-area"))
            case ("/api/inbox/in_muqel76q1h1i1", _): return (200, try! Fixtures.data("live-inbox-thread"))
            case ("/api/releases/posts", _): return (200, Data("[]".utf8))
            default: return (404, Data(#"{"error":"no route \#(p)?\#(q)"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    private func story(_ id: String, status: ItemStatus, assignee: String?, parent: String = "ft_mummakwyuew19") -> Item {
        Item(id: id, level: .story, title: "Story \(id)", body: "", status: status, statusSince: "2026-10-02T06:00:00.000Z",
             parentId: parent, epicId: parent, assigneeId: assignee, rank: 9, acceptance: [],
             legacy: ItemLegacy(kind: .assignment, state: "proposed"), createdAt: "2026-10-02T06:00:00.000Z", updatedAt: "2026-10-02T06:00:00.000Z")
    }

    // MARK: Plan

    func testPlanLoadsAreasFocusAndBoard() async throws {
        let s = PlanStore()
        await s.load(rest)
        XCTAssertEqual(s.plan?.areas.count, 4)
        XCTAssertEqual(s.focusIds, ["ft_mummakwyuew19"])
        XCTAssertNil(s.error)
        await s.loadBoard(rest)
        XCTAssertEqual(s.columns.map(\.status), ItemStatus.order)
        XCTAssertEqual(s.columns.first { $0.status == .inReview }?.items.count, 6)
    }

    func testAssignedToMeFollowsItemUpdates() async throws {
        let s = PlanStore()
        await s.load(rest)
        XCTAssertTrue(s.mine.isEmpty)
        let mine = story("as_new", status: .ready, assignee: "owner")
        s.handle(.itemUpdated(mine))
        XCTAssertEqual(s.mine.map(\.id), ["as_new"], "assigned to the owner: on top of the Plan")
        var done = mine; done.status = .done
        s.handle(.itemUpdated(done))
        XCTAssertTrue(s.mine.isEmpty, "done items leave the list")
        var other = mine; other.assigneeId = "dev"
        s.handle(.itemUpdated(other))
        XCTAssertTrue(s.mine.isEmpty)
    }

    func testAnEpicUpdateReplacesItsCardAndAStoryUpdateAsksForAReload() async throws {
        let s = PlanStore()
        var stale = 0
        s.onStale = { stale += 1 }
        await s.load(rest)
        var epic = s.plan!.areas[0].epics[0].epic
        epic.title = "P0: Iris during music"
        s.handle(.itemUpdated(epic))
        XCTAssertEqual(s.plan?.areas[0].epics[0].epic.title, "P0: Iris during music")
        s.handle(.itemUpdated(story("as_muqecr89jhjst", status: .inProgress, assignee: "dev")))
        XCTAssertEqual(stale, 1, "a story's move changes its epic's progress and flags: reload the plan")
    }

    func testBoardMovesAnItemBetweenColumns() async throws {
        let s = PlanStore()
        await s.loadBoard(rest)
        let item = s.columns.first { $0.status == .blocked }!.items[0]
        var moved = item; moved.status = .inProgress
        s.handle(.itemUpdated(moved))
        XCTAssertFalse(s.columns.first { $0.status == .blocked }!.items.contains { $0.id == item.id })
        XCTAssertTrue(s.columns.first { $0.status == .inProgress }!.items.contains { $0.id == item.id })
    }

    func testRankBetweenNeighbours() {
        XCTAssertEqual(PlanStore.rank(before: 1, after: 3), 2)
        XCTAssertEqual(PlanStore.rank(before: nil, after: 3), 2, "first: one below the next")
        XCTAssertEqual(PlanStore.rank(before: 4, after: nil), 5, "last: one above the previous")
        XCTAssertEqual(PlanStore.rank(before: nil, after: nil), 1)
    }

    func testReorderSendsTheNewRankOnly() async throws {
        let s = PlanStore()
        await s.load(rest)
        let epics = s.plan!.areas[1].epics   // Character & greeting: two epics
        XCTAssertEqual(epics.count, 2)
        StubURLProtocol.handler = { req in
            if req.httpMethod == "POST" { return (200, try! Fixtures.data("live-item-epic")) }
            return (200, try! Fixtures.data("live-plan"))
        }
        try await s.move(rest, areaId: s.plan!.areas[1].area.id, shown: epics, from: IndexSet(integer: 1), to: 0)
        let post = StubURLProtocol.recorded.first { $0.request.httpMethod == "POST" }!
        XCTAssertEqual(post.request.url?.path, "/api/items/\(epics[1].epic.id)")
        let body = try JSONSerialization.jsonObject(with: post.body!) as! [String: Any]
        XCTAssertEqual(Set(body.keys), ["rank"])
        XCTAssertLessThan(body["rank"] as! Double, epics[0].epic.rank)
    }

    func testACancelledLoadIsNeverAnError() async {
        // RCA: a pull-to-refresh released early, or a `.task` torn down by navigation, cancels its
        // URLSession load; that surfaced as a red "cancelled" error on the screen.
        StubURLProtocol.handler = { _ in (StubURLProtocol.cancelledStatus, Data()) }
        let s = PlanStore()
        await s.load(rest)
        XCTAssertNil(s.error)
        let inbox = InboxStore()
        await inbox.load(rest)
        XCTAssertNil(inbox.error, "the old stores follow the same rule")
        do { _ = try await rest.plan(); XCTFail("expected a cancellation") } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
            XCTAssertNil(error.userMessage)
        }
    }

    // MARK: Items

    func testItemDetailAppliesCommentsActivityAndChildUpdates() async throws {
        let s = ItemsStore()
        await s.load(rest, id: "ft_mummakwyuew19")
        let d = try XCTUnwrap(s.details["ft_mummakwyuew19"])
        XCTAssertEqual(d.children.count, 3)
        let c = Comment(id: "com_1", itemId: "ft_mummakwyuew19", at: "2026-10-02T06:00:00.000Z", by: "owner", text: "@dev status?", mentions: ["dev"])
        s.handle(.itemComment(c))
        s.handle(.itemComment(c))
        XCTAssertEqual(s.details["ft_mummakwyuew19"]?.comments.map(\.id), ["com_1"], "once, however often it arrives")
        let a = Activity(id: "act_x", at: "2026-10-02T06:00:01.000Z", itemId: "ft_mummakwyuew19", by: "owner", kind: .comment, text: "commented")
        s.handle(.activityRecorded(a))
        XCTAssertEqual(s.details["ft_mummakwyuew19"]?.activity.last?.id, "act_x")
        s.handle(.itemUpdated(story("as_muqecr8avlkkr", status: .ready, assignee: "owner")))
        XCTAssertEqual(s.details["ft_mummakwyuew19"]?.children.first { $0.id == "as_muqecr8avlkkr" }?.assigneeId, "owner")
    }

    func testItemUpdatePostsAndKeepsTheServersAnswer() async throws {
        let s = ItemsStore()
        await s.load(rest, id: "as_muqecr89jhjst")
        StubURLProtocol.handler = { req in
            var d = try! Fixtures.decode("live-item-story", as: ItemDetail.self)
            d.item.assigneeId = "owner"
            return (200, try! JSONEncoder().encode(d))
        }
        try await s.update(rest, id: "as_muqecr89jhjst", UpdateItemRequest(assigneeId: "owner"))
        XCTAssertEqual(s.details["as_muqecr89jhjst"]?.item.assigneeId, "owner")
        let body = try JSONSerialization.jsonObject(with: StubURLProtocol.recorded.last!.body!) as! [String: Any]
        XCTAssertEqual(body as NSDictionary, ["assigneeId": "owner"] as NSDictionary)
    }

    func testAServerRefusalIsShownInItsOwnWords() async throws {
        let s = ItemsStore()
        StubURLProtocol.handler = { _ in (400, Data(#"{"error":"a reviewer is required to enter review"}"#.utf8)) }
        do {
            try await s.update(rest, id: "as_1", UpdateItemRequest(status: .inReview))
            XCTFail("expected the refusal")
        } catch {
            XCTAssertEqual(error.userMessage, "a reviewer is required to enter review")
        }
    }

    // MARK: Updates

    func testUpdatesNewestFirstLiveAndDeduped() async throws {
        let s = UpdatesStore()
        await s.load(rest)
        XCTAssertEqual(s.updates.count, 4)
        let u = Update(id: "up_new", at: "2026-10-02T06:00:00.000Z", kind: .started, line: "Started: Mic stays live — Dev, 3 pts", by: "asha", itemId: "as_1", href: "item/as_1", push: true)
        s.handle(.updatePosted(u))
        s.handle(.updatePosted(u))
        XCTAssertEqual(s.updates.first?.id, "up_new")
        XCTAssertEqual(s.updates.count, 5)
        XCTAssertEqual(s.unseen, 1)
        s.markSeen()
        XCTAssertEqual(s.unseen, 0)
    }

    // MARK: Inbox threads

    func testInboxThreadLoadsAndAppendsLiveMessages() async throws {
        let s = InboxStore()
        await s.loadThread(rest, id: "in_muqel76q1h1i1")
        XCTAssertEqual(s.item("in_muqel76q1h1i1")?.options.count, 3)
        XCTAssertEqual(s.messages["in_muqel76q1h1i1"], [])
        let m = InboxMessage(id: "im_1", inboxId: "in_muqel76q1h1i1", at: "2026-10-02T06:00:00.000Z", by: "asha", text: "Yes — the two entries only.")
        s.handle(.inboxMessage(m))
        s.handle(.inboxMessage(m))
        XCTAssertEqual(s.messages["in_muqel76q1h1i1"]?.map(\.id), ["im_1"])
    }

    func testFreeTextReplyPostsTextAndKeepsTheThreadOpen() async throws {
        let s = InboxStore()
        await s.loadThread(rest, id: "in_muqel76q1h1i1")
        StubURLProtocol.handler = { req in
            var t = try! Fixtures.decode("live-inbox-thread", as: InboxThread.self)
            t.messages = [InboxMessage(id: "im_2", inboxId: t.item.id, at: "2026-10-02T06:01:00.000Z", by: "owner", text: "Why not the remap kind?")]
            t.item.messageCount = 1
            return (200, try! JSONEncoder().encode(t))
        }
        try await s.reply(rest, id: "in_muqel76q1h1i1", text: "Why not the remap kind?")
        let r = StubURLProtocol.recorded.last!
        XCTAssertEqual(r.request.url?.path, "/api/inbox/in_muqel76q1h1i1/reply")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: r.body!) as! NSDictionary, ["text": "Why not the remap kind?"] as NSDictionary)
        XCTAssertEqual(s.messages["in_muqel76q1h1i1"]?.map(\.by), ["owner"])
        XCTAssertEqual(s.item("in_muqel76q1h1i1")?.state, .open, "text alone leaves it open")
    }

    // MARK: Rooms and releases

    func testRoomsLoadAndAThreadUpdateLandsInItsRoom() async throws {
        let s = RoomsStore()
        await s.load(rest)
        XCTAssertEqual(s.rooms.map(\.kind), [.general, .area, .area, .area, .area, .releases])
        await s.loadRoom(rest, id: "area:ar_muqhzr5khct7v")
        var t = s.details["area:ar_muqhzr5khct7v"]!.threads[1]
        t.lastAt = "2026-10-02T07:00:00.000Z"; t.messageCount = 4; t.headline = "Dev: mic gate fixed"
        let msg = RoomMessage(id: "m1", threadId: t.id, at: t.lastAt, by: "dev", owner: false, text: "fixed", mentions: [])
        s.handle(.roomMessage(msg, thread: t))
        XCTAssertEqual(s.details["area:ar_muqhzr5khct7v"]?.threads.first?.id, t.id, "the busiest thread rises to the top")
        XCTAssertEqual(s.details["area:ar_muqhzr5khct7v"]?.threads.first?.headline, "Dev: mic gate fixed")
    }

    func testReleasePostsArriveLive() async throws {
        let s = ReleasePostsStore()
        await s.load(rest)
        XCTAssertTrue(s.loaded)
        XCTAssertTrue(s.posts.isEmpty)
        let post = ReleasePost(id: "rp_1", at: "2026-10-02T06:00:00.000Z", title: "Iris 0.2.16", version: "0.2.16", by: "nikhil",
                               groups: [ReleasePostGroup(areaId: "ar_1", areaTitle: "Voice & audio", items: [ReleasePostItem(id: "as_1", title: "Mic stays live at volume 0", level: .story, kind: .story)])],
                               text: "", threadId: "th_releases")
        s.handle(.releasePost(post))
        XCTAssertEqual(s.posts.map(\.id), ["rp_1"])
    }

    // MARK: Talk is a chat

    func testChatViewFoldsWorkplacePromptsAndSystemNotesIntoActivity() throws {
        // The live log: a Workplace assignment prompt (from: workplace), then tool runs.
        let log = try Fixtures.decode("live-agent-log", as: [LogEntry].self)
        let chat = ChatView.collapse(log)
        XCTAssertFalse(chat.contains { $0.kind == .user }, "nothing appears as the owner's that he did not write")
        XCTAssertEqual(chat.first?.kind, .activity)
        XCTAssertEqual(chat.filter { $0.kind == .assistant }.count, log.filter { $0.kind == .assistant }.count, "every written reply stays")
        // Same shape as the server's own ?view=chat for this log.
        XCTAssertEqual(chat.map(\.kind), [.activity, .assistant, .activity, .assistant, .activity])

        let owner = LogEntry(id: "o", agentId: "a", at: "2026-10-02T06:00:00.000Z", kind: .user, label: "", text: "hi", from: .owner)
        let legacy = LogEntry(id: "l", agentId: "a", at: "2026-10-02T06:00:01.000Z", kind: .user, label: "", text: "old")
        let system = LogEntry(id: "s", agentId: "a", at: "2026-10-02T06:00:02.000Z", kind: .system, label: "", text: "stalled")
        let reply = LogEntry(id: "r", agentId: "a", at: "2026-10-02T06:00:03.000Z", kind: .assistant, label: "", text: "ok")
        let lone = LogEntry(id: "b", agentId: "a", at: "2026-10-02T06:00:04.000Z", kind: .bash, label: "", text: "ls")
        let out = ChatView.collapse([owner, legacy, system, reply, lone])
        XCTAssertEqual(out.map(\.kind), [.user, .user, .activity, .assistant, .bash], "absent from = the owner; a lone system note folds; a lone tool stays")
    }
}
