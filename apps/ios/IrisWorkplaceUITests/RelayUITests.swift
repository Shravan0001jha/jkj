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

        XCTAssertTrue(app.navigationBars["Office"].waitForExistence(timeout: 20), "the callback's token signs the app in")
        XCTAssertTrue(app.staticTexts["Spend today"].waitForExistence(timeout: 10))
        shot("relay-office")

        app.buttons["Settings"].tap()
        let reached = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Relay'")).firstMatch
        XCTAssertTrue(reached.waitForExistence(timeout: 6))
        let online = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Online'")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 8), "the socket is open with the session token")
        XCTAssertTrue(app.buttons["Sign out"].exists)
        shot("relay-settings")
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
        XCTAssertTrue(app.navigationBars["Office"].waitForExistence(timeout: 30), "the app re-probes and connects when the Mac is back")
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
