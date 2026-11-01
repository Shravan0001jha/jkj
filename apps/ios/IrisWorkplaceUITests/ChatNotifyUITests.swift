import XCTest

/// Chat profile and per-chat mute (docs/CHAT-NOTIFY-CONTRACT.md §6.8) against the mock with Talk
/// threads (`node mock/server.mjs --port <TALK_MOCK_PORT> --talk-threads --reusable-code`).
/// Run under both themes: TEST_RUNNER_THEME=default and =scifi.
final class ChatNotifyUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        mock("/api/_reset")
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": UITestEnv.talkHost, "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1"]
        // Every run starts from the server's prefs, not a previous run's local copy.
        app.launchArguments += ["-iris.chatPrefs.v1", ""]
    }

    override func tearDown() { mock("/api/_reset") }

    private func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    /// A test hook on the mock (loopback: no token needed).
    @discardableResult
    private func mock(_ path: String, _ body: [String: Any] = [:]) -> Int {
        var req = URLRequest(url: URL(string: "http://\(UITestEnv.talkHost)\(path)")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let done = DispatchSemaphore(value: 0)
        var status = 0
        URLSession.shared.dataTask(with: req) { _, r, _ in status = (r as? HTTPURLResponse)?.statusCode ?? 0; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 5)
        return status
    }

    /// Back by the edge swipe: the mock's scripted alert banner can drop over the back button at
    /// any moment (and tapping it opens the Inbox), but never covers the middle of the left edge.
    private func back() {
        let before = app.navigationBars.firstMatch.identifier
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.55))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)))
        _ = XCTWaiter().wait(for: [expectation(for: NSPredicate(format: "identifier != %@", before), evaluatedWith: app.navigationBars.firstMatch)], timeout: 3)
    }

    func testOpenChatProfileMuteAndBackShowsMuted() {
        app.launchEnvironment["WORKPLACE_TALK"] = "asha"
        app.launchThemed()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 10))
        XCTAssertFalse(any("chat.muted").exists, "not muted to start with")

        // The header opens the profile.
        any("chat.header").tap()
        XCTAssertTrue(any("profile.name").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Asha'")).firstMatch.exists)
        XCTAssertTrue(any("profile.fact.Role").exists)
        shot("profile-top")
        scrollTo(any("profile.sharedTabs"))
        XCTAssertTrue(any("profile.media").waitForExistence(timeout: 8), "the photo Asha sent")
        shot("profile-media")

        // Mute for an hour from the Notifications row.
        let row = any("profile.notifications")
        scrollTo(row, up: true)
        row.tap()
        XCTAssertTrue(app.buttons["1 hour"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["8 hours"].exists && app.buttons["1 day"].exists && app.buttons["Forever"].exists)
        shot("profile-mute-menu")
        app.buttons["1 hour"].tap()
        let status = any("profile.notifications.status")
        XCTAssertTrue(status.waitForExistence(timeout: 3))
        expectLabel(status, contains: "Muted until")
        shot("profile-muted")

        // Files and links tabs.
        scrollTo(any("profile.sharedTabs"))
        app.buttons["Files"].tap()
        XCTAssertTrue(any("profile.file").waitForExistence(timeout: 5), "the PDF")
        app.buttons["Links"].tap()
        XCTAssertTrue(any("profile.link").waitForExistence(timeout: 5), "the PR link")
        shot("profile-links")

        // Back in the chat: the header says muted. Back in the list: the row too.
        back()
        XCTAssertTrue(any("chat.muted").waitForExistence(timeout: 5), "bell.slash in the chat header")
        shot("chat-header-muted")
        back()
        let asha = any("talk.row.asha")
        XCTAssertTrue(asha.waitForExistence(timeout: 5))
        expectLabel(asha, contains: "Muted")
        shot("talk-list-muted")

        // Another device mutes the COO: the row follows over the socket.
        let coo = any("talk.row.coo")
        XCTAssertFalse(coo.label.contains("Muted"))
        XCTAssertEqual(mock("/api/_chat/prefs", ["threadId": "coo", "muted": true]), 200)
        expectLabel(coo, contains: "Muted")
        XCTAssertEqual(mock("/api/_chat/prefs", ["threadId": "coo", "muted": false]), 200)
        expectLabel(coo, contains: "Muted", negate: true)
    }

    func testUnmuteFromTheListAndThePhoneOnlyFallback() {
        XCTAssertEqual(mock("/api/_chats", ["on": false]), 200, "the server has no /api/chats yet")
        app.launchEnvironment["WORKPLACE_TALK"] = "coo"
        app.launchThemed()
        XCTAssertTrue(app.textFields["chat.composer"].waitForExistence(timeout: 10))
        any("chat.header").tap()
        XCTAssertTrue(any("profile.name").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Your COO: runs the Workplace, routes work, reports to you."].exists)
        any("profile.mute").tap()
        XCTAssertTrue(app.buttons["Forever"].waitForExistence(timeout: 3))
        app.buttons["Forever"].tap()
        expectLabel(any("profile.notifications.status"), contains: "Muted")
        let note = any("profile.localNote")
        scrollTo(note)
        XCTAssertTrue(note.exists, "says it applies on this phone only")
        scrollTo(any("profile.sharedTabs"))
        app.buttons["Links"].tap()
        XCTAssertTrue(any("profile.shared.recent").waitForExistence(timeout: 5), "derived from the loaded messages")
        XCTAssertTrue(any("profile.link").exists)
        shot("profile-local")
        back()
        back()
        let coo = any("talk.row.coo")
        XCTAssertTrue(coo.waitForExistence(timeout: 5))
        expectLabel(coo, contains: "Muted")
        // Long-press the row: Unmute.
        coo.press(forDuration: 1.0)
        let menu = app.buttons["Notifications: muted"]
        XCTAssertTrue(menu.waitForExistence(timeout: 3))
        menu.tap()
        XCTAssertTrue(app.buttons["Unmute"].waitForExistence(timeout: 3))
        app.buttons["Unmute"].tap()
        expectLabel(coo, contains: "Muted", negate: true)
    }

    private func scrollTo(_ e: XCUIElement, up: Bool = false) {
        var n = 0
        while !(e.exists && e.isHittable) && n < 6 { if up { app.swipeDown() } else { app.swipeUp() }; n += 1 }
    }

    private func expectLabel(_ e: XCUIElement, contains text: String, negate: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        let p = NSPredicate(format: negate ? "NOT (label CONTAINS %@)" : "label CONTAINS %@", text)
        let x = expectation(for: p, evaluatedWith: e)
        let r = XCTWaiter().wait(for: [x], timeout: 6)
        XCTAssertEqual(r, .completed, "\(e.identifier) label \(negate ? "still has" : "lacks") '\(text)': \(e.exists ? e.label : "(gone)")", file: file, line: line)
    }
}
