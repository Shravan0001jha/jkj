import XCTest

/// Read-only checks of the 4 Oct fixes on the owner's iPhone against his live Workplace. Runs only
/// with TEST_RUNNER_DEVICE_VERIFY=1. Never sends, pins, copies, answers or signs out: it opens
/// screens, filters, searches, expands, opens a long-press menu and dismisses it.
final class DeviceVerifyUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["DEVICE_VERIFY"] == "1" else { throw XCTSkip("DEVICE_VERIFY not set") }
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1"]
    }
    private func shot(_ n: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = "device-\(n)"; a.lifetime = .keepAlways; add(a) }
    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    func test1PlanDoneLastFilterSearch() {
        app.launch()
        XCTAssertTrue(any("plan.filter").waitForExistence(timeout: 20))
        sleep(3); shot("plan")
        // Done epics sit below open ones in every area: the first "Done" card comes after the last open one.
        any("plan.filter").tap()
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(any("plan.filter.summary").waitForExistence(timeout: 4)); sleep(1); shot("plan-done-only")
        any("plan.filter").tap()
        app.buttons["Open"].firstMatch.tap(); sleep(1); shot("plan-open-only")
        any("plan.filter").tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Sort'")).firstMatch.tap()
        app.buttons["Recently updated"].tap(); sleep(1); shot("plan-open-recent")
        any("plan.filter.clear").tap()
        app.swipeDown()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("greeting")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'result' OR label ENDSWITH 'results'")).firstMatch.waitForExistence(timeout: 15))
        sleep(1); shot("plan-search")
    }

    func test2TalkListAndSenders() {
        app.launchEnvironment["WORKPLACE_TAB"] = "talk"
        app.launch()
        XCTAssertTrue(any("talk.row.coo").waitForExistence(timeout: 20))
        sleep(3); shot("talk-list")
        // The pin action is there (revealed, not tapped).
        any("talk.row.asha").swipeRight()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == 'Pin' OR label == 'Unpin'")).firstMatch.waitForExistence(timeout: 3))
        shot("talk-pin-action")
        app.tap()
    }

    func test3ChatExpandMenuLinks() {
        for who in ["asha", "coo"] {
            app.launchEnvironment["WORKPLACE_TALK"] = who
            app.launch()
            XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 20))
            sleep(4); shot("chat-\(who)")
            let mores = app.buttons.matching(identifier: "message.showMore")
            var n = 0
            func hittableMore() -> XCUIElement? { mores.allElementsBoundByIndex.first { $0.exists && $0.isHittable } }
            while hittableMore() == nil && n < 10 { app.swipeDown(); n += 1 }
            let more = hittableMore() ?? mores.firstMatch
            if more.exists && more.isHittable {
                more.tap()
                XCTAssertTrue(app.buttons["message.showLess"].waitForExistence(timeout: 3)); shot("chat-\(who)-expanded")
                app.buttons["message.showLess"].tap()
            }
            let bubble = app.descendants(matching: .any).matching(identifier: "chat.theirs").allElementsBoundByIndex.last { $0.exists && $0.isHittable } ?? any("chat.theirs")
            if bubble.exists && bubble.isHittable {
                bubble.press(forDuration: 1.0)
                XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3), "long-press menu")
                shot("chat-\(who)-menu")
                // Dismiss without choosing anything.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
                sleep(1)
            }
            print("DEVICE \(who): expandedChecked=\(more.isHittable) links=\(app.links.count) showMore=\(more.exists) senders=\(app.descendants(matching: .any).matching(identifier: "chat.sender").count)")
            app.terminate()
        }
    }
}
