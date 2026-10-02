import XCTest

/// Read-only screenshots on the owner's iPhone against the live Workplace (through the relay).
/// Runs only with TEST_RUNNER_DEVICE_SHOTS=1. It never taps an action, never sends, never signs
/// out: each screen opens from a debug launch variable and is photographed.
final class DeviceShotsUITests: XCTestCase {
    func testScreenshotEveryScreen() throws {
        guard ProcessInfo.processInfo.environment["DEVICE_SHOTS"] == "1" else { throw XCTSkip("DEVICE_SHOTS not set") }
        let screens: [(String, [String: String])] = [
            ("plan", [:]),
            ("board", ["WORKPLACE_BOARD": "1"]),
            ("epic", ["WORKPLACE_ITEM": "ft_mummakwyuew19"]),
            ("story", ["WORKPLACE_ITEM": "as_muqecr89jhjst"]),
            ("inbox", ["WORKPLACE_TAB": "inbox"]),
            ("talk-list", ["WORKPLACE_TAB": "talk"]),
            ("talk-coo", ["WORKPLACE_TALK": "coo"]),
            ("talk-asha", ["WORKPLACE_TALK": "asha"]),
            ("room", ["WORKPLACE_ROOM": "list"]),
            ("epic-thread", ["WORKPLACE_ROOM": "th_epic_ft_mummakwyuew19"]),
            ("updates", ["WORKPLACE_TAB": "updates"]),
            ("office", ["WORKPLACE_TAB": "office"]),
        ]
        for (name, env) in screens {
            let app = XCUIApplication()
            app.launchEnvironment = env.merging(["WORKPLACE_NO_NOTIF_PROMPT": "1"]) { a, _ in a }
            app.launch()
            sleep(10)
            let a = XCTAttachment(screenshot: app.screenshot()); a.name = "device-\(name)"; a.lifetime = .keepAlways; add(a)
            app.terminate()
        }
    }
}
