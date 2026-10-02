import XCTest

/// The relay sign-in flow against the mock relay (`make mock`, port 4399): real
/// ASWebAuthenticationSession, the mock's login page, the callback, the Office; the Mac-offline
/// state and its recovery; the expired-session screen; the developer toggle.
final class RelayUITests: XCTestCase {
    private var app: XCUIApplication!
    private let mock = URL(string: "http://127.0.0.1:4399")!

    override func setUp() async throws {
        continueAfterFailure = false
        var req = URLRequest(url: mock.appending(path: "/api/_reset"))
        req.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: req)
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_RELAY_URL": "127.0.0.1:4399", "WORKPLACE_NO_NOTIF_PROMPT": "1"]
    }

    private func setOffline(_ offline: Bool) async {
        var req = URLRequest(url: mock.appending(path: "/api/_offline"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{\"offline\":\(offline)}".utf8)
        _ = try? await URLSession.shared.data(for: req)
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    func testSignInThroughTheWebPageLandsOnTheOffice() {
        app.launchEnvironment["WORKPLACE_FORGET"] = "1"
        app.launch()
        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 8), "a fresh install in relay mode starts at Sign in")
        XCTAssertTrue(app.buttons["First time here? Set up a passkey"].exists)
        shot("relay-signin")
        signIn.tap()

        // iOS asks once whether the app may use the site to sign in.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let consent = springboard.buttons["Continue"]
        if consent.waitForExistence(timeout: 8) { consent.tap() }

        // The mock's page in the auth session: its button redirects to irisworkplace://auth#token=…
        let pageButton = app.webViews.buttons["Sign in with passkey (mock)"].firstMatch
        let pageButtonLoose = app.buttons["Sign in with passkey (mock)"].firstMatch
        let ok = pageButton.waitForExistence(timeout: 15) || pageButtonLoose.waitForExistence(timeout: 5)
        XCTAssertTrue(ok, "the relay's sign-in page is shown in the auth session")
        sleep(1)
        shot("relay-web-page")
        (pageButton.exists ? pageButton : pageButtonLoose).tap()

        XCTAssertTrue(app.navigationBars["Plan"].waitForExistence(timeout: 20), "the callback's token signs the app in")
        XCTAssertTrue(app.staticTexts["Assigned to you"].waitForExistence(timeout: 10))
        shot("relay-plan")

        app.buttons["More"].firstMatch.tap()
        app.buttons["Settings"].firstMatch.tap()
        let reached = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Relay'")).firstMatch
        XCTAssertTrue(reached.waitForExistence(timeout: 6))
        let online = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Online'")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 8), "the socket is open with the session token")
        shot("relay-settings")
        var s = 0
        while !app.buttons["Sign out"].exists && s < 5 { app.swipeUp(); s += 1 }
        XCTAssertTrue(app.buttons["Sign out"].exists)
        var n = 0
        while !app.buttons["Developer options"].isHittable && n < 5 { app.swipeUp(); n += 1 }
        app.buttons["Developer options"].tap()
        XCTAssertTrue(app.switches["Use a LAN Workplace (pairing)"].waitForExistence(timeout: 6), "LAN pairing is behind a toggle")
        shot("relay-developer-options")
    }

    func testMacOfflineIsShownAndRecovers() async {
        await setOffline(true)
        app.launchEnvironment["WORKPLACE_TOKEN"] = "mock-session-ui"
        app.launch()
        let offline = app.staticTexts["Your Mac is offline"]
        XCTAssertTrue(offline.waitForExistence(timeout: 10), "a relay answering 503 is the Mac-offline state, not a network error")
        XCTAssertTrue(app.buttons["Check now"].exists)
        shot("relay-mac-offline")
        await setOffline(false)
        XCTAssertTrue(app.navigationBars["Plan"].waitForExistence(timeout: 30), "the app re-probes and connects when the Mac is back")
        shot("relay-recovered")
    }

    func testExpiredSessionAsksToSignInAgain() throws {
        // Off loopback the mock enforces the token, so a bad session is a 401. TEST_RUNNER_LAN_IP = this Mac's address.
        guard let ip = ProcessInfo.processInfo.environment["LAN_IP"], !ip.isEmpty else { throw XCTSkip("LAN_IP not set") }
        app.launchEnvironment["WORKPLACE_RELAY_URL"] = "\(ip):4399"
        app.launchEnvironment["WORKPLACE_TOKEN"] = "not-a-session"
        app.launch()
        XCTAssertTrue(app.staticTexts["Your session has ended"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons["Sign in again"].exists)
        shot("relay-session-ended")
    }
}

/// The live relay's sign-in and enrolment pages inside the real ASWebAuthenticationSession sheet.
/// Looks only: cancels without signing in. Runs with TEST_RUNNER_LIVE_RELAY=1.
final class LiveRelayPagesUITests: XCTestCase {
    func testLoginAndEnrolPagesRenderInTheSheet() throws {
        guard ProcessInfo.processInfo.environment["LIVE_RELAY"] == "1" else { throw XCTSkip("LIVE_RELAY not set") }
        let app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_FORGET": "1"]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for (button, name) in [("Sign in", "live-login-page"), ("First time here? Set up a passkey", "live-enrol-page")] {
            XCTAssertTrue(app.buttons[button].waitForExistence(timeout: 8))
            app.buttons[button].tap()
            let consent = springboard.buttons["Continue"]
            if consent.waitForExistence(timeout: 6) { consent.tap() }
            let page = app.webViews.firstMatch
            XCTAssertTrue(page.waitForExistence(timeout: 20), "the sheet opened for \(button)")
            let heading = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Iris Workplace' OR label CONTAINS[c] 'passkey' OR label CONTAINS[c] 'sign in'")).firstMatch
            XCTAssertTrue(heading.waitForExistence(timeout: 20), "the live page rendered text in the sheet (\(button))")
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
            let cancel = app.buttons["Cancel"].firstMatch
            if cancel.waitForExistence(timeout: 3) { cancel.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.1)).tap() }
            XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 8), "back at the sign-in screen, nothing signed in")
        }
    }
}
