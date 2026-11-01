import XCTest

/// Screens no launch hook reaches (the Dashboard below the fold, a product), for the theme evidence
/// (docs/THEMES.md §8). Opt-in: runs only with TEST_RUNNER_THEME_SHOTS=1, against a mock started
/// with --no-live. Scrolls with momentum-free drags so two runs land on the same pixels; the
/// screenshots are attachments named dash-<n>, pulled from the result bundle and diffed.
final class ThemeShotsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["THEME_SHOTS"] == "1", "theme evidence only")
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": UITestEnv.host, "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1", "WORKPLACE_TAB": "dashboard"]
    }

    private func shot(_ name: String) {
        sleep(2)   // settle (scroll indicators fade)
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    /// Drag the content up by `points` with no fling.
    private func drag(_ points: CGFloat) {
        let w = app.windows.firstMatch
        let h = w.frame.height
        let from = w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        let to = w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75 - points / h))
        from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
    }

    func testDashboardScreens() {
        app.launchThemed()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "dash.tile.products").firstMatch.waitForExistence(timeout: 10))
        shot("dash-1-top")
        drag(450); shot("dash-2")
        drag(450); shot("dash-3")
        drag(450); shot("dash-4")
        drag(450); shot("dash-5")
        for _ in 0..<6 { drag(-450) }
        let p = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Plans & credits'")).firstMatch
        XCTAssertTrue(p.waitForExistence(timeout: 4))
        p.tap()
        XCTAssertTrue(app.staticTexts["Burn-up"].waitForExistence(timeout: 4))
        shot("dash-6-product")
        drag(450); shot("dash-7-product-more")
    }

    /// For the motion evidence (scripts/anim-frames.sh records the screen meanwhile): tab switches.
    func testTabSwitchesForVideo() {
        app.launchEnvironment["WORKPLACE_TAB"] = "plan"
        app.launchThemed()
        XCTAssertTrue(app.tabBars.buttons["Inbox"].waitForExistence(timeout: 10))
        sleep(3)
        app.tabBars.buttons["Inbox"].tap(); sleep(2)
        app.tabBars.buttons["Room"].tap(); sleep(2)
        app.tabBars.buttons["Plan"].tap(); sleep(2)
    }
}
