import XCTest

/// The Dashboard tab against the mock (`make mock`), which serves fixtures/dashboard-snapshot.json
/// at /api/metrics/snapshot. The mock's port defaults to 4399; `TEST_RUNNER_MOCK_PORT=<n>` on the
/// xcodebuild line points the run at another one.
final class DashboardUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        let port = ProcessInfo.processInfo.environment["MOCK_PORT"] ?? "4399"
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": "127.0.0.1:\(port)", "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1"]
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    private func reveal(_ e: XCUIElement, swipes: Int = 8) -> Bool {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(); n += 1; _ = e.waitForExistence(timeout: 0.5) }
        return e.exists && e.isHittable
    }

    func testDashboardShowsFeaturesGapsAndAFeaturesScopeAndHistory() {
        app.launch()
        let tab = app.tabBars.buttons["Dashboard"]
        XCTAssertTrue(tab.waitForExistence(timeout: 8))
        XCTAssertEqual(app.tabBars.buttons.count, 5, "five tabs, no More")
        tab.tap()
        let store = app.buttons.matching(NSPredicate(format: "label CONTAINS 'App Store 1.0'")).firstMatch
        XCTAssertTrue(store.waitForExistence(timeout: 8), "features from the snapshot")
        XCTAssertTrue(store.label.contains("Late"), "the health pill: \(store.label)")
        XCTAssertTrue(store.label.contains("Due 28 Oct"), "committed date and forecast: \(store.label)")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Updated'")).firstMatch.exists, "its age")
        shot("dashboard")

        let review = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '1. Review'")).firstMatch
        XCTAssertTrue(reveal(review), "the top gap cause")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '3. Owner decision'")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '4. '")).firstMatch.exists, "only three")
        shot("dashboard-gaps")

        app.swipeDown(); app.swipeDown(); app.swipeDown()
        store.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'of 3 verified'")).firstMatch.waitForExistence(timeout: 4),
                      "the scope checklist")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Store listing'")).firstMatch.exists)
        let history = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Second review round'")).firstMatch
        XCTAssertTrue(reveal(history), "the date history with its reason")
        shot("dashboard-feature")

        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Updates"].tap()
        XCTAssertTrue(app.navigationBars["Updates"].waitForExistence(timeout: 4), "Updates lives under the Dashboard tab")
        app.tabBars.buttons["Plan"].tap()
        app.tabBars.buttons["Dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Updates"].waitForExistence(timeout: 4), "and the tab remembers the pane")
    }
}
