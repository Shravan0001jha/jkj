import XCTest

/// Scroll smoothness of the Plan under the run's theme (docs/THEMES.md §2.5): XCTest's scrolling
/// signpost metric reports hitch time ratio (ms of hitches per second of scrolling) and frame count.
/// Opt-in: TEST_RUNNER_THEME_PERF=1 (and TEST_RUNNER_THEME=default|scifi).
final class ThemePerfUITests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["THEME_PERF"] == "1", "perf evidence only")
    }

    func testPlanScrollHitches() {
        let app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": UITestEnv.host, "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1", "WORKPLACE_FRAME_PROBE": "1",
                                 "WORKPLACE_AMBIENT_OFF": ProcessInfo.processInfo.environment["AMBIENT_OFF"] ?? ""]
        app.launchThemed()
        XCTAssertTrue(app.staticTexts["Assigned to you"].waitForExistence(timeout: 10))
        sleep(2)
        let list = app.collectionViews.firstMatch
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        options.invocationOptions = [.manuallyStop]
        measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
            list.swipeUp(velocity: .fast)
            list.swipeUp(velocity: .fast)
            list.swipeDown(velocity: .fast)
            list.swipeDown(velocity: .fast)
            stopMeasuring()
            // Back to the top for the next iteration.
            list.swipeDown(velocity: .fast)
        }
    }
}
