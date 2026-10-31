import XCTest
@testable import IrisWorkplace

final class AppLinkTests: XCTestCase {
    func testPushLinksAndURLsRouteTheSame() {
        XCTAssertEqual(AppLink.parse("inbox/in_x"), .inbox("in_x", decide: false))
        XCTAssertEqual(AppLink.parse("inbox/in_x", decide: true), .inbox("in_x", decide: true))
        XCTAssertEqual(AppLink.parse("room/th_y"), .room("th_y"))
        XCTAssertEqual(AppLink.parse("employee/dev"), .employee("dev"))
        XCTAssertEqual(AppLink.parse("office"), .office)
        XCTAssertEqual(AppLink.parse(url: URL(string: "irisworkplace://inbox/in_x")!), .inbox("in_x", decide: false))
        XCTAssertEqual(AppLink.parse(url: URL(string: "irisworkplace://room/th%20y")!), .room("th y"))
        XCTAssertEqual(AppLink.parse("inbox/in_x/extra"), .inbox("in_x/extra", decide: false), "the id keeps everything after the first slash")
    }

    func testJunkIsRejected() {
        XCTAssertNil(AppLink.parse(""))
        XCTAssertNil(AppLink.parse("#/"))
        XCTAssertNil(AppLink.parse("settings/x"))
        XCTAssertNil(AppLink.parse("mailto:owner@example.com"))
        XCTAssertNil(AppLink.parse(url: URL(string: "https://work.irisforu.com/inbox/in_x")!), "only our scheme or a bare link")
        XCTAssertNil(AppLink.parse(url: URL(string: "irisworkplace://auth#token=abc")!), "the sign-in callback is not a deep link")
    }

    /// Every link form packages/server/src produces (push.ts, trail.ts, status.ts, rhythm.ts, room.ts,
    /// coo.ts, views.ts) and the web's own routes.
    func testEveryServerLinkForm() {
        let cases: [(String, AppLink)] = [
            // push.ts
            ("inbox/in_1", .inbox("in_1", decide: false)),
            ("inbox", .inboxList),                                   // the burst summary
            ("office", .office),                                     // a ring / an alert with no employee
            ("employee/dev", .employee("dev")),                      // an alert about an employee
            ("item/as_1", .item("as_1")),                            // alerts once they carry their item
            // Update hrefs (trail.ts, status.ts, rhythm.ts)
            ("plan", .plan), ("updates", .updates), ("releases/rp_1", .releasePost("rp_1")), ("room/th_1", .room("th_1")),
            // The web's hash form (room.ts, coo.ts, trail.ts, views.ts)
            ("#/room/th_2", .room("th_2")),
            ("#/item/as_2", .item("as_2")),
            ("#/employee/dev?item=as_3", .employee("dev")),
            ("#/assign?item=as_4", .item("as_4")),
            ("#/assign", .plan),
            ("#/inbox", .inboxList), ("#/inbox/in_2", .inbox("in_2", decide: false)),
            ("#/room", .roomList), ("#/office", .office), ("#/org", .office),
            ("#/features", .features), ("#/spend", .spend), ("#/releases", .releases),
            // Leading slashes, a trailing slash, percent-encoding, case
            ("/inbox/in_3", .inbox("in_3", decide: false)), ("/#/room/th_3", .room("th_3")), ("inbox/", .inboxList),
            ("#/room/th%20y", .room("th y")), ("Inbox/in_4", .inbox("in_4", decide: false)),
            // Our scheme
            ("irisworkplace://inbox", .inboxList), ("irisworkplace://item/as_5", .item("as_5")),
        ]
        for (raw, want) in cases { XCTAssertEqual(AppLink.parse(raw), want, raw) }
        XCTAssertEqual(AppLink.parse("inbox", decide: true), .inboxList)
        XCTAssertEqual(AppLink.parse("#/inbox/in_5", decide: true), .inbox("in_5", decide: true))
    }

    /// A tap always opens something: the link, else an id in the payload, else the category's screen, else home.
    func testANotificationTapAlwaysResolves() {
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "inbox"], category: "WP_INBOX"), .inboxList, "the summary push")
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "inbox/in_1", "inboxId": "in_1"]), .inbox("in_1", decide: false))
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "inbox/in_1"], decide: true), .inbox("in_1", decide: true))
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "office"], category: "WP_ALERT"), .office)
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "office", "itemId": "as_1"], category: "WP_ALERT"), .item("as_1"), "a specific id beats a list link")
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "employee/dev", "employeeId": "dev"], category: "WP_ALERT"), .employee("dev"))
        XCTAssertEqual(AppLink.resolve(userInfo: ["inboxId": "in_9"]), .inbox("in_9", decide: false), "the app's own local notification carries only the id")
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "#/room/th_1"], category: "WP_ROOM"), .room("th_1"))
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "whatever/x"], category: "WP_ROOM"), .roomList, "unknown: the category's screen")
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "whatever/x"], category: "WP_UPDATE"), .updates)
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "whatever/x"], category: "WP_INBOX"), .inboxList)
        XCTAssertEqual(AppLink.resolve(userInfo: [:]), .plan, "nothing at all: home, never nothing")
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": ""], category: "WP_ALERT"), .office)
    }

    /// A cold launch: iOS hands the tap to the delegate before the app has wired `onOpen`. It waits, then applies.
    @MainActor
    func testATapBeforeTheAppIsReadyIsQueuedNotDropped() {
        let push = PushManager()
        var opened: [AppLink] = []
        push.deliver(.inbox("in_1", decide: false))
        push.deliver(.inboxList)
        XCTAssertEqual(push.pendingLink, .inboxList, "the latest tap is kept")
        push.onOpen = { opened.append($0) }
        XCTAssertEqual(opened, [.inboxList])
        XCTAssertNil(push.pendingLink)
        push.deliver(.item("as_1"))
        XCTAssertEqual(opened, [.inboxList, .item("as_1")], "once wired, a tap goes straight through")
    }

    /// The model applies a link before any screen exists; the screens read the router when they appear.
    @MainActor
    func testALinkAppliedBeforeStartSurvivesStart() {
        let m = AppModel(relayTokens: MemoryTokenStore(token: "s"), lanTokens: MemoryTokenStore(),
                         defaults: UserDefaults(suiteName: "AppLinkTests")!, notifier: FakeNotifier(),
                         urlSession: StubURLProtocol.session(), makeTransport: { FakeSocketTransport() },
                         webAuth: FakeWebAuth(), env: [:], pathMonitor: nil, deviceAuth: FakeDeviceAuth())
        m.open(.inbox("in_1", decide: true))
        m.start()
        XCTAssertEqual(m.router.tab, .inbox)
        XCTAssertEqual(m.router.inboxItemId, "in_1")
        XCTAssertEqual(m.router.decideItemId, "in_1")
    }

    func testTokenHex() {
        XCTAssertEqual(Data([0x00, 0xab, 0xff]).hexToken, "00abff")
        XCTAssertEqual(Data(repeating: 0x7f, count: 32).hexToken.count, 64)
    }

    func testAnswerGate() {
        var item = try! Fixtures.decode("inbox", as: [InboxItem].self).first { $0.id == "ib-2" }!   // decision
        let plain = item.options[0]
        XCTAssertFalse(AnswerGate.needsDeviceOwner(item: item, option: plain))
        var danger = plain; danger.danger = true
        XCTAssertTrue(AnswerGate.needsDeviceOwner(item: item, option: danger), "a dangerous option always asks")
        for kind in [InboxKind.approval, .release, .orgChange, .cap] {
            item.kind = kind
            XCTAssertTrue(AnswerGate.needsDeviceOwner(item: item, option: plain), "\(kind) asks even for a plain option")
        }
        item.kind = .question
        XCTAssertFalse(AnswerGate.needsDeviceOwner(item: item, option: plain))
    }

    func testCategoriesAreForegroundOnly() {
        for c in PushCategory.all {
            for a in c.actions {
                XCTAssertTrue(a.options.contains(.foreground), "\(c.identifier)/\(a.identifier) must open the app")
                XCTAssertFalse(a.options.contains(.destructive))
            }
        }
        XCTAssertEqual(Set(PushCategory.all.map(\.identifier)), ["WP_INBOX", "WP_ROOM", "WP_ALERT", "WP_UPDATE"])
        XCTAssertEqual(PushCategory.all.first { $0.identifier == "WP_INBOX" }?.actions.map(\.identifier), ["OPEN", "DECIDE"])
    }
}

final class SocketAlertDedupeTests: XCTestCase {
    @MainActor
    func testAPushForAnItemTheSocketJustShowedIsADuplicate() {
        let s = AlertsStore()
        s.handle(.alert(AlertEvent(level: .needsYou, title: "t", body: "b", inboxId: "in_x")))
        XCTAssertTrue(s.recentlyShown(inboxId: "in_x", threadId: nil))
        XCTAssertFalse(s.recentlyShown(inboxId: "in_y", threadId: nil))
        XCTAssertFalse(s.recentlyShown(inboxId: nil, threadId: nil))
        XCTAssertFalse(s.recentlyShown(inboxId: "in_x", threadId: nil, now: Date().addingTimeInterval(120)), "a minute later it is new again")
    }

    @MainActor
    func testLocalNotificationsStopOncePushesAreRegistered() {
        let n = FakeNotifier()
        let s = AlertsStore(notifier: n)
        s.isActive = { false }
        s.handle(.alert(AlertEvent(level: .blocked, title: "a", body: "", inboxId: nil)))
        XCTAssertEqual(n.delivered.count, 1)
        s.suppressLocal = { true }
        s.handle(.alert(AlertEvent(level: .blocked, title: "b", body: "", inboxId: nil)))
        XCTAssertEqual(n.delivered.count, 1, "the relay's push covers it now")
    }
}
