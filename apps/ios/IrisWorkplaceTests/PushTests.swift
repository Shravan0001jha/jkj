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
        XCTAssertNil(AppLink.parse("inbox"))
        XCTAssertNil(AppLink.parse("settings/x"))
        XCTAssertNil(AppLink.parse(url: URL(string: "https://work.irisforu.com/inbox/in_x")!), "only our scheme or a bare link")
        XCTAssertNil(AppLink.parse(url: URL(string: "irisworkplace://auth#token=abc")!), "the sign-in callback is not a deep link")
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
        XCTAssertEqual(Set(PushCategory.all.map(\.identifier)), ["WP_INBOX", "WP_ROOM", "WP_ALERT"])
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
