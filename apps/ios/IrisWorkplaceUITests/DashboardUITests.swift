import XCTest

/// The Dashboard tab against the mock (`make mock`), which serves IrisWorkplaceTests/Fixtures/snapshot-v1.json
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

    private func reveal(_ e: XCUIElement, swipes: Int = 10) -> Bool {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(); n += 1; _ = e.waitForExistence(timeout: 0.5) }
        return e.exists && e.isHittable
    }

    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func label(_ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testDashboardTilesProductsTrendsWorkplaceAndAProduct() {
        app.launch()
        let tab = app.tabBars.buttons["Dashboard"]
        XCTAssertTrue(tab.waitForExistence(timeout: 8))
        XCTAssertEqual(app.tabBars.buttons.count, 5, "five tabs, no More")
        tab.tap()

        // Top row, from the fixture: 2 of 9 products delivered, 41 delivered (+24), 11 open bugs (falling).
        let products = any("dash.tile.products")
        XCTAssertTrue(products.waitForExistence(timeout: 8))
        XCTAssertEqual(products.label, "2 of 9 products complete")
        XCTAssertEqual(any("dash.tile.delivered").label, "41 stories delivered this week, +24 on last week")
        XCTAssertEqual(any("dash.tile.bugs").label, "11 open bugs, falling")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Updated'")).firstMatch.exists, "its age")
        shot("dashboard-top")

        let smart = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Smart home'")).firstMatch
        XCTAssertTrue(smart.exists, "a product card")
        XCTAssertTrue(smart.label.contains("On track") && smart.label.contains("14 of 15"), smart.label)

        XCTAssertTrue(reveal(label("Stories delivered per week")), "the trends section")
        shot("dashboard-trends")
        XCTAssertTrue(reveal(any("dash.review.approval2")), "the Workplace section")
        XCTAssertTrue(label("Waiting, story-days per week").exists)
        XCTAssertEqual(any("dash.review.approval1").label, "Approval 1 median wait 2.2 h")
        XCTAssertTrue(label("Other").exists, "top four causes plus Other")
        app.swipeUp()   // past the floating tab bar
        shot("dashboard-workplace")

        // A product: bigger burn-up and the weekly bars.
        for _ in 0..<8 { app.swipeDown() }
        let plans = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Plans & credits'")).firstMatch
        XCTAssertTrue(reveal(plans))
        XCTAssertTrue(plans.label.contains("Late"), plans.label)
        plans.tap()
        XCTAssertTrue(app.staticTexts["Burn-up"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["Delivered per week"].exists)
        shot("dashboard-product")
        XCTAssertTrue(reveal(app.staticTexts["Bugs opened per week"]))
        shot("dashboard-product-bugs")

        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Updates"].tap()
        XCTAssertTrue(app.navigationBars["Updates"].waitForExistence(timeout: 4), "Updates lives under the Dashboard tab")
        app.tabBars.buttons["Plan"].tap()
        app.tabBars.buttons["Dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Updates"].waitForExistence(timeout: 4), "and the tab remembers the pane")
    }
}
