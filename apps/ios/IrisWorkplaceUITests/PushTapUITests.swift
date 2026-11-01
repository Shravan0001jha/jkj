import XCTest

/// Tapping a chat notification lands in that exact chat, on its newest message (owner, 1 Nov:
/// "tapping a chat notification does not open the chat"). A real APNs payload, shaped exactly as the
/// relay sends it (services/workplace-relay/push.py: `aps` + the data keys at the top level), goes to
/// this simulator through the mock (`POST /api/_simpush` runs `xcrun simctl push`), and the test taps
/// the banner on SpringBoard, as a finger would.
///
/// Mock: `node mock/server.mjs --port <TALK_MOCK_PORT> --talk-threads --reusable-code --no-live`.
/// Run under both themes: TEST_RUNNER_THEME=default and =scifi.
final class PushTapUITests: XCTestCase {
    private var app: XCUIApplication!
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var udid: String { ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "booted" }

    override func setUp() {
        continueAfterFailure = false
        mock("/api/_reset")
        app = XCUIApplication()
        // No WORKPLACE_NO_NOTIF_PROMPT: the app must be allowed to show notifications.
        app.launchEnvironment = ["WORKPLACE_URL": UITestEnv.talkHost, "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_DEVICE_AUTH": "1",
                                 // A banner tap relaunches the app without this environment: keep the mock's address.
                                 "WORKPLACE_PERSIST_CONFIG": "1"]
        app.launchArguments += ["-iris.chatPrefs.v1", ""]
    }

    override func tearDown() { mock("/api/_reset") }

    /// Leave the simulator as other suites expect it: no saved server address.
    override class func tearDown() {
        let app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": UITestEnv.talkHost, "WORKPLACE_FORGET_CONFIG": "1", "WORKPLACE_NO_NOTIF_PROMPT": "1"]
        app.launch()
        app.terminate()
    }

    // MARK: cases

    /// The owner's case: the app was not running.
    func testKilledAppTapOpensThatChatAtNewest() {
        launchAllowingNotifications()
        app.terminate()
        let text = postAndPush(thread: "asha", name: "Asha")
        tapBanner(containing: text)
        expectChat("Asha", newest: text)
        shot("push-killed-asha")
    }

    func testBackgroundTapOpensThatChat() {
        launchAllowingNotifications()
        XCUIDevice.shared.press(.home)
        let text = postAndPush(thread: "coo", name: "Claude — COO")
        tapBanner(containing: text)
        expectChat("Claude — COO", newest: text)
        shot("push-background-coo")
    }

    /// Foreground on another tab: the banner shows over the app; a tap opens the chat.
    func testForegroundOtherTabTapOpensChat() {
        launchAllowingNotifications()
        XCTAssertTrue(app.tabBars.buttons["Plan"].waitForExistence(timeout: 10) || app.buttons["Plan"].waitForExistence(timeout: 2))
        let text = postAndPush(thread: "asha", name: "Asha")
        tapBanner(containing: text)
        expectChat("Asha", newest: text)
    }

    /// Foreground in Talk with ANOTHER chat open: the tap swaps to the notified chat.
    func testForegroundOtherChatTapSwapsToThatChat() {
        app.launchEnvironment["WORKPLACE_TALK"] = "coo"
        launchAllowingNotifications()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 10))
        let text = postAndPush(thread: "asha", name: "Asha")
        tapBanner(containing: text)
        expectChat("Asha", newest: text)
        shot("push-foreground-other-chat")
    }

    /// The same chat twice in a row from the Talk list after backing out: the second tap still opens it.
    func testSecondTapForSameChatAfterBackingOut() {
        launchAllowingNotifications()
        let first = postAndPush(thread: "asha", name: "Asha")
        tapBanner(containing: first)
        expectChat("Asha", newest: first)
        // Back to the Talk list, then another push for the same chat.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.55))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)))
        XCTAssertTrue(any("talk.row.asha").waitForExistence(timeout: 5))
        let second = postAndPush(thread: "asha", name: "Asha")
        tapBanner(containing: second)
        expectChat("Asha", newest: second)
    }

    /// "It didn't expand when I clicked": a tap opens the app (iOS); a long-press expands the
    /// notification. It must expand, show the text, and offer Reply and Mute.
    func testLongPressExpandsWithReplyAndMute() {
        launchAllowingNotifications()
        XCUIDevice.shared.press(.home)
        let text = postAndPush(thread: "asha", name: "Asha")
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 10))
        banner.press(forDuration: 1.2)
        XCTAssertTrue(springboard.buttons["Reply"].waitForExistence(timeout: 5), "Reply on the expanded notification")
        XCTAssertTrue(springboard.buttons["Mute for 1 hour"].exists)
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = "push-expanded"; a.lifetime = .keepAlways; add(a)
        // Dismiss the expanded view without acting.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
    }

    /// Bug 2 (owner, 1 Nov: "opening a chat shows loading"): a chat the phone has seen opens on its
    /// cached messages while the network is slow, with no spinner; the fresh page merges in after.
    func testChatOpensFromCacheWhileTheNetworkIsSlow() {
        // A first visit fills the cache.
        app.launchEnvironment["WORKPLACE_NO_NOTIF_PROMPT"] = "1"
        app.launchEnvironment["WORKPLACE_TALK"] = "asha"
        app.launchThemed()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 10))
        let last = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Here is the evidence pack'")).firstMatch
        XCTAssertTrue(last.waitForExistence(timeout: 10), "the newest fixture message loaded")
        app.terminate()

        // Every chat request now takes 8 s, and a new message waits on the server.
        let freshText = "Fresh while you were away \(UUID().uuidString.prefix(6))"
        XCTAssertEqual(mock("/api/_chat/message", ["threadId": "asha", "text": freshText]), 201)
        XCTAssertEqual(mock("/api/_delay", ["ms": 8000]), 200)
        app.launchThemed()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 5))
        XCTAssertTrue(last.waitForExistence(timeout: 3), "cached messages on screen at once")
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = "chat-from-cache-slow-network"; a.lifetime = .keepAlways; add(a)
        let fresh = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", freshText)).firstMatch
        XCTAssertFalse(fresh.exists, "shown before the (8 s) network answered: this is the phone's copy")
        XCTAssertTrue(last.isHittable, "on the newest cached message")
        XCTAssertFalse(any("chat.loading").exists, "no chat spinner when the phone has the chat (a photo still loading may spin)")
        let header = any("chat.header")
        XCTAssertTrue(header.label.contains("Updating"), "a quiet Updating… in the header: \(header.label)")
        // The fresh page lands and merges in at the bottom.
        XCTAssertTrue(fresh.waitForExistence(timeout: 20))
        let shown = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: fresh)
        XCTAssertEqual(XCTWaiter().wait(for: [shown], timeout: 5), .completed, "followed to the new message")
        let b = XCTAttachment(screenshot: app.screenshot()); b.name = "chat-from-cache-merged"; b.lifetime = .keepAlways; add(b)
        mock("/api/_delay", ["ms": 0])
    }

    // MARK: helpers

    private func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    /// Launch, and answer iOS's notification prompt with Allow if it is asked (first run on a simulator).
    private func launchAllowingNotifications() {
        app.launchThemed()
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        // Give the app a moment to register categories and settle on its first screen.
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 10)
    }

    /// The server's side of a chat message: the mock stores it (so the chat has it), then the push
    /// the server would send for it, in the relay's exact APNs shape.
    private func postAndPush(thread: String, name: String) -> String {
        let text = "Push check \(UUID().uuidString.prefix(6))"
        XCTAssertEqual(mock("/api/_chat/message", ["threadId": thread, "text": text]), 201)
        var data: [String: Any] = ["link": "chat/\(thread)", "threadId": thread]
        if thread != "coo" { data["employeeId"] = thread }
        let payload: [String: Any] = [
            "aps": ["alert": ["title": name, "body": text], "sound": "default", "thread-id": "chat:\(thread)",
                    "category": "WP_CHAT", "interruption-level": "active", "mutable-content": 0],
            "level": "info",
        ].merging(data) { a, _ in a }
        XCTAssertEqual(mock("/api/_simpush", ["udid": udid, "payload": payload]), 200, "simctl push through the mock")
        return text
    }

    private func tapBanner(containing text: String) {
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 10), "the banner for '\(text)'")
        banner.tap()
    }

    private func expectChat(_ name: String, newest text: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), file: file, line: line)
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 15), "a chat is open", file: file, line: line)
        let header = any("chat.header")
        XCTAssertTrue(header.waitForExistence(timeout: 5), file: file, line: line)
        let named = expectation(for: NSPredicate(format: "label CONTAINS %@", name), evaluatedWith: header)
        XCTAssertEqual(XCTWaiter().wait(for: [named], timeout: 8), .completed,
                       "the chat open is \(name)'s (header: \(header.label))", file: file, line: line)
        let msg = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        let shown = expectation(for: NSPredicate(format: "exists == true AND hittable == true"), evaluatedWith: msg)
        XCTAssertEqual(XCTWaiter().wait(for: [shown], timeout: 10), .completed, "the newest message is on screen", file: file, line: line)
    }

    /// A test hook on the mock (loopback: no token needed).
    @discardableResult
    private func mock(_ path: String, _ body: [String: Any] = [:]) -> Int {
        var req = URLRequest(url: URL(string: "http://\(UITestEnv.talkHost)\(path)")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 20
        let done = DispatchSemaphore(value: 0)
        var status = 0
        URLSession.shared.dataTask(with: req) { _, r, _ in status = (r as? HTTPURLResponse)?.statusCode ?? 0; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 20)
        return status
    }
}
