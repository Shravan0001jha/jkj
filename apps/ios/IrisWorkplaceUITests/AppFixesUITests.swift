import XCTest

/// The 4 Oct fixes against the mock with Talk threads (`node mock/server.mjs --port 4411 --talk-threads`):
/// real senders, fold/expand, long-press menu, reply, receipts, typing, links, Plan filter and search.
final class AppFixesUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": "127.0.0.1:4411", "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1"]
    }

    private func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    func testTalkThreadSenderExpandMenuReplyReceiptsTyping() {
        app.launchEnvironment["WORKPLACE_TALK"] = "asha"
        app.launch()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 10))
        // The COO's words in Asha's thread are named, never "You".
        let sender = app.staticTexts["Claude — COO"]
        var n = 0
        while !sender.exists && n < 8 { app.swipeDown(); n += 1 }
        XCTAssertTrue(sender.exists, "the COO is named as the sender")
        shot("talk-sender")
        // A long message folds with Show more; a tap anywhere expands it.
        let more = app.buttons["message.showMore"]
        n = 0
        while !(more.exists && more.isHittable) && n < 8 { app.swipeUp(); n += 1 }
        XCTAssertTrue(more.exists, "long message folds")
        more.tap()
        XCTAssertTrue(app.buttons["message.showLess"].waitForExistence(timeout: 3), "Show less after expanding")
        shot("talk-expanded")
        app.buttons["message.showLess"].tap()
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        // Long-press: Copy, Copy link, Reply.
        let linkBubble = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'The spec is in'")).firstMatch
        n = 0
        while !(linkBubble.exists && linkBubble.isHittable) && n < 8 { app.swipeDown(); n += 1 }
        linkBubble.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Copy link"].exists, "Copy link when the message has links")
        shot("talk-menu")
        app.buttons["Reply"].tap()
        XCTAssertTrue(any("chat.replyStrip").waitForExistence(timeout: 3), "reply strip above the field")
        let field = app.textFields["chat.composer"]
        field.tap(); field.typeText("Thanks @de")
        XCTAssertTrue(any("mention.suggest.dev").waitForExistence(timeout: 3), "mention autocomplete")
        any("mention.suggest.dev").tap()
        app.buttons["chat.send"].tap()
        XCTAssertTrue(any("chat.receipt.read").waitForExistence(timeout: 6), "read once the agent took it in")
        let typing = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Asha is typing'")).firstMatch
        XCTAssertTrue(typing.waitForExistence(timeout: 6), "typing while the reply is drafted")
        shot("talk-typing")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Got it. Details'")).firstMatch.waitForExistence(timeout: 8))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: typing)
        wait(for: [gone], timeout: 3)
        shot("talk-reply")
    }

    func testALinkOpensSafari() {
        app.launchEnvironment["WORKPLACE_TALK"] = "coo"
        app.launch()
        let link = app.links.matching(NSPredicate(format: "label CONTAINS 'github.com'")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(for: .runningForeground, timeout: 10), "Safari opens the link")
    }

    func testTalkListPinnedThenUnread() {
        app.launch()
        app.tabBars.buttons["Talk"].tap()
        let coo = any("talk.row.coo"), asha = any("talk.row.asha"), dev = any("talk.row.dev")
        XCTAssertTrue(coo.waitForExistence(timeout: 10))
        XCTAssertTrue(asha.waitForExistence(timeout: 5))
        XCTAssertLessThan(coo.frame.minY, asha.frame.minY, "pinned first")
        if dev.exists { XCTAssertLessThan(asha.frame.minY, dev.frame.minY, "unread before read") }
        shot("talk-list")
    }

    func testPlanFilterAndSearch() {
        app.launch()
        XCTAssertTrue(any("plan.filter").waitForExistence(timeout: 10))
        any("plan.filter").tap()
        app.buttons["Open"].tap()
        XCTAssertTrue(any("plan.filter.summary").waitForExistence(timeout: 3), "the active filter is named")
        shot("plan-filter-open")
        any("plan.filter.clear").tap()
        app.swipeDown()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 4))
        search.tap(); search.typeText("greeting")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'results' OR label ENDSWITH 'result'")).firstMatch.waitForExistence(timeout: 6))
        shot("plan-search")
    }
}
