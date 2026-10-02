import XCTest
@testable import IrisWorkplace

/// v2 (LLD §19.8) shapes, decoded from JSON captured from the live Workplace on 2 Oct
/// (`fixtures/live-*.json`, read-only GETs against 127.0.0.1:4317, nothing secret in them).
/// Every fixture decodes and re-encodes without loss, and an unknown enum value never fails a
/// screen: it decodes as `.unknown`.
final class V2ContractTests: XCTestCase {
    private func roundTrip<T: Codable & Equatable>(_ name: String, _ type: T.Type, file: StaticString = #filePath, line: UInt = #line) throws {
        let decoded = try Fixtures.decode(name, as: T.self)
        let reencoded = try jsonObject(decoded)
        let original = stripNulls(try Fixtures.json(name))
        XCTAssertTrue((reencoded as AnyObject).isEqual(original), "\(name): re-encoded JSON differs from the live fixture:\n\(diff(original, reencoded))", file: file, line: line)
    }

    // MARK: live fixtures

    func testLivePlanRoundTripsAndCarriesTheFourAreas() throws {
        try roundTrip("live-plan", PlanResponse.self)
        let plan = try Fixtures.decode("live-plan", as: PlanResponse.self)
        XCTAssertEqual(plan.areas.map(\.area.title), ["Voice & audio", "Character & greeting", "Mac & mobile apps", "Memory"])
        XCTAssertEqual(plan.areas.flatMap(\.epics).count, 4)
        XCTAssertEqual(plan.focus.epicIds, ["ft_mummakwyuew19"])
        let p0 = try XCTUnwrap(plan.areas[0].epics.first)
        XCTAssertTrue(p0.inFocus, "the focus epic is marked")
        XCTAssertEqual(p0.epic.level, .epic)
        XCTAssertEqual(p0.epic.status, .inProgress)
        XCTAssertEqual(p0.progress.storiesTotal, 3)
        XCTAssertEqual(p0.flags.first?.kind, .blocked)
        XCTAssertEqual(p0.flags.first?.waitingOn, "coo")
        XCTAssertTrue(plan.areas[3].epics.isEmpty, "Memory has no epic yet and still decodes")
        XCTAssertNil(plan.board, "no board without ?view=board")
        XCTAssertEqual(plan.counts["in-review"], 6)
    }

    func testLiveBoardGroupsByEveryStatus() throws {
        try roundTrip("live-plan-board", PlanResponse.self)
        let board = try XCTUnwrap(try Fixtures.decode("live-plan-board", as: PlanResponse.self).board)
        XCTAssertEqual(Set(board.keys), Set(ItemStatus.known.map(\.rawValue)))
        XCTAssertEqual(board["in-review"]?.count, 6)
        XCTAssertTrue(board["in-review"]!.allSatisfy { $0.stall?.rule == .unreviewed || $0.stall == nil })
    }

    func testLiveItemsAndDetails() throws {
        try roundTrip("live-items", [Item].self)
        try roundTrip("live-item-epic", ItemDetail.self)
        try roundTrip("live-item-story", ItemDetail.self)
        let epic = try Fixtures.decode("live-item-epic", as: ItemDetail.self)
        XCTAssertEqual(epic.children.count, 3)
        XCTAssertEqual(epic.threadId, "th_epic_ft_mummakwyuew19")
        XCTAssertEqual(epic.area?.title, "Voice & audio")
        XCTAssertNotNil(epic.progress)
        let story = try Fixtures.decode("live-item-story", as: ItemDetail.self)
        XCTAssertEqual(story.item.status, .blocked)
        XCTAssertEqual(story.item.blocked?.waitingOn, "coo")
        XCTAssertEqual(story.parent?.id, "ft_mummakwyuew19")
        XCTAssertEqual(story.item.legacy.kind, .assignment)
        XCTAssertTrue(story.activity.contains { $0.kind == .stall })
    }

    func testLiveUpdatesAreasRoomsInboxStatus() throws {
        try roundTrip("live-updates", [Update].self)
        try roundTrip("live-areas", [Area].self)
        try roundTrip("live-rooms", [Room].self)
        try roundTrip("live-room-area", RoomDetail.self)
        try roundTrip("live-room-general", RoomDetail.self)
        try roundTrip("live-room-releases", RoomDetail.self)
        try roundTrip("live-room-thread-epic", RoomThreadDetail.self)
        try roundTrip("live-inbox-thread", InboxThread.self)
        try roundTrip("live-inbox", [InboxItem].self)
        try roundTrip("live-status", StatusAnswer.self)
        try roundTrip("live-agent-log", [LogEntry].self)

        let updates = try Fixtures.decode("live-updates", as: [Update].self)
        XCTAssertEqual(updates.first?.kind, .blocked)
        XCTAssertEqual(updates.first?.href, "item/as_muqecr89jhjst")
        XCTAssertEqual(Set(updates.map(\.kind)), [.blocked, .brief, .unblocked])
        let rooms = try Fixtures.decode("live-rooms", as: [Room].self)
        XCTAssertEqual(rooms.map(\.kind), [.general, .area, .area, .area, .area, .releases])
        let area = try Fixtures.decode("live-room-area", as: RoomDetail.self)
        XCTAssertEqual(area.threads.first?.epicId, "ft_mummakwyuew19")
        let epicThread = try Fixtures.decode("live-room-thread-epic", as: RoomThreadDetail.self)
        XCTAssertEqual(epicThread.messages.first?.kind, .update, "a named update line, not an authored message")
        XCTAssertEqual(epicThread.messages.first?.itemId, "as_muqecr89jhjst")
        let log = try Fixtures.decode("live-agent-log", as: [LogEntry].self)
        XCTAssertEqual(log.first?.from, .workplace, "the assignment prompt is the Workplace's, not the owner's")
    }

    // MARK: unknown values never fail a screen

    func testUnknownEnumValuesDecodeAsUnknown() throws {
        var raw = try Fixtures.json("live-plan") as! [String: Any]
        var areas = raw["areas"] as! [[String: Any]]
        var epics = areas[0]["epics"] as! [[String: Any]]
        var card = epics[0]
        var epic = card["epic"] as! [String: Any]
        epic["status"] = "parked"
        epic["level"] = "initiative"
        var legacy = epic["legacy"] as! [String: Any]
        legacy["kind"] = "incident"
        epic["legacy"] = legacy
        card["epic"] = epic
        var flags = card["flags"] as! [[String: Any]]
        flags[0]["kind"] = "on-fire"
        card["flags"] = flags
        epics[0] = card
        areas[0]["epics"] = epics
        var area = areas[0]["area"] as! [String: Any]
        area["state"] = "frozen"
        areas[0]["area"] = area
        raw["areas"] = areas
        let plan = try JSONDecoder().decode(PlanResponse.self, from: JSONSerialization.data(withJSONObject: raw))
        let e = plan.areas[0].epics[0]
        XCTAssertEqual(e.epic.status, .unknown)
        XCTAssertEqual(e.epic.level, .unknown)
        XCTAssertEqual(e.epic.legacy.kind, .unknown)
        XCTAssertEqual(e.flags[0].kind, .unknown)
        XCTAssertEqual(plan.areas[0].area.state, .unknown)
        XCTAssertEqual(plan.areas.count, 4, "the rest of the plan is intact")
    }

    func testAnUnknownInboxKindOrUrgencyKeepsTheWholeInbox() throws {
        // RCA: the old strict enums made one unknown `kind` fail the whole `[InboxItem]` decode, so
        // a single new kind on the server blanked the entire Inbox. It now decodes as `.unknown`.
        var items = try Fixtures.json("live-inbox") as! [[String: Any]]
        items[0]["kind"] = "bribe"
        items[0]["state"] = "snoozed"
        items[0]["urgency"] = "apocalyptic"
        var opts = items[0]["options"] as! [[String: Any]]
        opts[0]["recommended"] = true
        items[0]["options"] = opts
        let decoded = try JSONDecoder().decode([InboxItem].self, from: JSONSerialization.data(withJSONObject: items))
        XCTAssertEqual(decoded.count, items.count)
        XCTAssertEqual(decoded[0].kind, .unknown)
        XCTAssertEqual(decoded[0].state, .unknown)
        XCTAssertEqual(decoded[0].urgency, .unknown)
        XCTAssertEqual(decoded[0].options[0].recommended, true)
        XCTAssertEqual(InboxKind.unknown.glyph.label, "Other")
    }

    func testUnknownActivityUpdateRoomAndLogKinds() throws {
        let a = try JSONDecoder().decode(Activity.self, from: Data(#"{"id":"a","at":"2026-10-02T05:00:00.000Z","itemId":null,"by":"dev","kind":"deploy","text":"x"}"#.utf8))
        XCTAssertEqual(a.kind, .unknown)
        XCTAssertNil(a.itemId)
        let u = try JSONDecoder().decode(Update.self, from: Data(#"{"id":"u","at":"2026-10-02T05:00:00.000Z","kind":"celebrated","line":"x","by":"asha","href":"plan","push":false}"#.utf8))
        XCTAssertEqual(u.kind, .unknown)
        let r = try JSONDecoder().decode(Room.self, from: Data(#"{"id":"x","kind":"lounge","title":"x","headline":"","lastAt":"2026-10-02T05:00:00.000Z","threadIds":[]}"#.utf8))
        XCTAssertEqual(r.kind, .unknown)
        let l = try JSONDecoder().decode(LogEntry.self, from: Data(#"{"id":"l","agentId":"a","at":"2026-10-02T05:00:00.000Z","kind":"thinking","label":"","text":"x","from":"cron"}"#.utf8))
        XCTAssertEqual(l.kind, .unknown)
        XCTAssertEqual(l.from, .unknown)
        XCTAssertFalse(PermissionMode.choices.contains(.unknown), "a picker never offers unknown")
    }

    // MARK: socket events

    func testV2SocketEventsDecode() throws {
        let events = try Fixtures.decode("events", as: [ServerEvent].self)
        func first(_ match: (ServerEvent) -> Bool) -> ServerEvent? { events.first(where: match) }
        guard case .itemUpdated(let item)? = first({ if case .itemUpdated = $0 { return true }; return false }) else { return XCTFail("item.updated") }
        XCTAssertFalse(item.id.isEmpty)
        guard case .itemComment(let c)? = first({ if case .itemComment = $0 { return true }; return false }) else { return XCTFail("item.comment") }
        XCTAssertFalse(c.itemId.isEmpty)
        guard case .activityRecorded? = first({ if case .activityRecorded = $0 { return true }; return false }) else { return XCTFail("activity.recorded") }
        guard case .updatePosted(let u)? = first({ if case .updatePosted = $0 { return true }; return false }) else { return XCTFail("update.posted") }
        XCTAssertFalse(u.line.isEmpty)
        guard case .areaUpdated? = first({ if case .areaUpdated = $0 { return true }; return false }) else { return XCTFail("area.updated") }
        guard case .inboxMessage(let m)? = first({ if case .inboxMessage = $0 { return true }; return false }) else { return XCTFail("inbox.message") }
        XCTAssertFalse(m.inboxId.isEmpty)
        guard case .releasePost(let p)? = first({ if case .releasePost = $0 { return true }; return false }) else { return XCTFail("release.post") }
        XCTAssertFalse(p.groups.isEmpty)
    }

    // MARK: paths and requests

    func testV2Paths() {
        XCTAssertEqual(API.plan(), "/api/plan")
        XCTAssertEqual(API.plan(view: "board"), "/api/plan?view=board")
        XCTAssertEqual(API.items(level: .story, status: .inProgress, assigneeId: "owner"), "/api/items?level=story&status=in-progress&assigneeId=owner")
        XCTAssertEqual(API.items(), "/api/items")
        XCTAssertEqual(API.item("as 1"), "/api/items/as%201")
        XCTAssertEqual(API.itemComments("as_1"), "/api/items/as_1/comments")
        XCTAssertEqual(API.itemMerge("as_1"), "/api/items/as_1/merge")
        XCTAssertEqual(API.updates(limit: 50, before: "up_1"), "/api/updates?limit=50&before=up_1")
        XCTAssertEqual(API.updates(), "/api/updates")
        XCTAssertEqual(API.inboxThread("in_1"), "/api/inbox/in_1")
        XCTAssertEqual(API.inboxReply("in_1"), "/api/inbox/in_1/reply")
        XCTAssertEqual(API.status("music fix"), "/api/status?q=music+fix")
        XCTAssertEqual(API.roomDetail("area:ar_1"), "/api/rooms/area%3Aar_1")
        XCTAssertEqual(API.releasePost("rp_1"), "/api/releases/posts/rp_1")
        XCTAssertEqual(API.focus, "/api/focus")
    }

    func testUpdateRequestSendsOnlyWhatChanged() throws {
        let body = try jsonObject(UpdateItemRequest(assigneeId: "owner")) as! [String: Any]
        XCTAssertEqual(body as NSDictionary, ["assigneeId": "owner"] as NSDictionary, "absent, not null: nothing else is cleared")
        let blocked = try jsonObject(UpdateItemRequest(status: .blocked, blockedReason: "waiting on the API key", waitingOn: "owner")) as! [String: Any]
        XCTAssertEqual(blocked as NSDictionary, ["status": "blocked", "blockedReason": "waiting on the API key", "waitingOn": "owner"] as NSDictionary)
    }

    // MARK: links

    func testV2DeepLinksFromUpdateHrefs() {
        XCTAssertEqual(AppLink.parse("item/as_1"), .item("as_1"))
        XCTAssertEqual(AppLink.parse("plan"), .plan)
        XCTAssertEqual(AppLink.parse("updates"), .updates)
        XCTAssertEqual(AppLink.parse("releases/rp_1"), .releasePost("rp_1"))
        XCTAssertEqual(AppLink.parse("inbox/in_1"), .inbox("in_1", decide: false))
        XCTAssertEqual(AppLink.parse("room/th_epic_x"), .room("th_epic_x"))
        XCTAssertNil(AppLink.parse("item"))
    }
}
