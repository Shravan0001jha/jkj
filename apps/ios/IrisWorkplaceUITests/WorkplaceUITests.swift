import XCTest

/// Drives the one-tap flows against the mock server (`make mock`, port 4399).
/// Each test launches the app already paired (debug launch environment) and taps like the owner would.
final class WorkplaceUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        // Every test starts from the mock's seed state.
        var req = URLRequest(url: URL(string: "http://127.0.0.1:4399/api/_reset")!)
        req.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: req)
        app = XCUIApplication()
        app.launchEnvironment = [
            "WORKPLACE_URL": "127.0.0.1:4399",
            "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
            "WORKPLACE_NO_NOTIF_PROMPT": "1",
        ]
    }

    private func launch(_ extra: [String: String] = [:]) {
        for (k, v) in extra { app.launchEnvironment[k] = v }
        app.launch()
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    func testDangerOptionAsksForConfirmationThenAnswers() {
        launch(["WORKPLACE_INBOX_ITEM": "ib-1"])
        let release = app.buttons["Release 0.2.16"]
        XCTAssertTrue(release.waitForExistence(timeout: 8), "the danger option is a button on the item")
        release.tap()
        let confirm = app.sheets.buttons["Release 0.2.16"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 4), "a danger option confirms before it acts")
        shot("danger-confirm")
        // Cancel: the Cancel button where the OS shows one, otherwise a tap outside the dialog.
        if app.buttons["Cancel"].exists {
            app.buttons["Cancel"].firstMatch.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)).tap()
        }
        XCTAssertFalse(confirm.waitForExistence(timeout: 2), "the dialog is gone")
        XCTAssertTrue(release.waitForExistence(timeout: 2), "cancel leaves the item open")
        release.tap()
        app.sheets.buttons["Release 0.2.16"].firstMatch.tap()
        let done = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Release 0.2.16 ·'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 8), "the item shows the recorded answer after the server confirmed")
        XCTAssertTrue(done.label.contains(" via "), done.label)   // web for a loopback client, phone off-loopback
        shot("danger-answered")
    }

    func testNeedsNoteOptionAsksForANote() {
        launch(["WORKPLACE_INBOX_ITEM": "ib-3"])
        let raise = app.buttons["Raise for today"]
        XCTAssertTrue(raise.waitForExistence(timeout: 8))
        raise.tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 4), "a needsNote option asks for the note")
        XCTAssertFalse(app.alerts.buttons["Send"].isEnabled, "no empty notes")
        field.tap()
        field.typeText("250")
        shot("note-prompt")
        app.alerts.buttons["Send"].tap()
        let done = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Raise for today ·'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["250"].exists, "the note is shown with the answer")
    }

    func testTalkApprovalAndStreamedReply() {
        launch(["WORKPLACE_TALK": "mira"])
        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 8), "the pending tool approval is inline")
        allow.tap()
        let approved = app.staticTexts["Bash approved (once)."]
        XCTAssertTrue(approved.waitForExistence(timeout: 6), "the approval is acknowledged in the log over the socket")
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '48 passed, 0 failed'")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 8), "the employee's next line streams in")
        shot("talk-after-approval")

        let composer = app.textFields.matching(NSPredicate(format: "placeholderValue == 'Message Mira'")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 4))
        composer.tap()
        composer.typeText("status?")
        app.buttons["Send"].tap()
        let echo = app.staticTexts["status?"]
        XCTAssertTrue(echo.waitForExistence(timeout: 6), "the sent line appears from the socket, not optimistically")
        let ack = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'On it.'")).firstMatch
        XCTAssertTrue(ack.waitForExistence(timeout: 8))
    }

    func testOfficeCardOpensTalkAndProfileShowsCharter() {
        launch()
        let asha = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Asha'")).firstMatch
        XCTAssertTrue(asha.waitForExistence(timeout: 8))
        asha.tap()
        XCTAssertTrue(app.navigationBars["Asha"].waitForExistence(timeout: 6), "a card opens Talk with that employee")
        app.buttons["More"].tap()
        app.buttons["Charter and status"].tap()
        XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["Status"].exists)
        XCTAssertTrue(app.staticTexts["Handoff"].exists)
        shot("profile")
        let charter = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Chief of Staff'")).firstMatch
        var swipes = 0
        while !charter.isHittable && swipes < 4 { app.swipeUp(); swipes += 1 }
        XCTAssertTrue(charter.waitForExistence(timeout: 4), "the Charters section lists the held charters")
        charter.tap()
        XCTAssertTrue(app.navigationBars["Chief of Staff"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.staticTexts["Mission"].waitForExistence(timeout: 6), "the full charter loads")
        shot("charter")
    }

    func testAlertBannerOpensTheInboxItem() {
        launch(["WORKPLACE_TAB": "alerts"])
        // The mock's first scripted alert arrives ~25 s after connect.
        let banner = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Needs you: Mira needs an approval'")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 40), "the socket alert becomes a banner")
        shot("alert-banner")
        banner.tap()
        XCTAssertTrue(app.staticTexts["Kabir: which socket contract for Mac errands?"].waitForExistence(timeout: 6), "tapping the banner opens its Inbox item")
    }

    /// Pairs with the real server when `TEST_RUNNER_REAL_URL` and `TEST_RUNNER_REAL_PAIR_CODE` are set.
    func testPairWithTheRealServer() throws {
        let env = ProcessInfo.processInfo.environment
        guard let realURL = env["REAL_URL"], let code = env["REAL_PAIR_CODE"] else { throw XCTSkip("REAL_URL / REAL_PAIR_CODE not set") }
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1"]
        app.launch()
        let url = app.textFields["192.168.1.5:4317"]
        XCTAssertTrue(url.waitForExistence(timeout: 8))
        url.tap(); url.typeText(realURL)
        let codeField = app.textFields["Pairing code"]
        codeField.tap(); codeField.typeText(code)
        shot("real-pairing-filled")
        app.buttons["Pair this phone"].tap()
        XCTAssertTrue(app.navigationBars["Office"].waitForExistence(timeout: 15), "a good code lands on the Office")
        XCTAssertTrue(app.staticTexts["Spend today"].waitForExistence(timeout: 10))
        shot("real-office")
        app.tabBars.buttons["Inbox"].tap()
        XCTAssertTrue(app.staticTexts["Needs you"].waitForExistence(timeout: 10))
        shot("real-inbox")
        // Open a real decision, look, and cancel: the owner's items are never answered from a test.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Decision,'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your answer"].waitForExistence(timeout: 8))
        shot("real-inbox-item")
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.exists)
        app.navigationBars.buttons.firstMatch.tap()
        app.tabBars.buttons["Talk"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Asha'")).firstMatch.waitForExistence(timeout: 8))
        shot("real-talk-picker")
        app.tabBars.buttons["Features"].tap()
        XCTAssertTrue(app.staticTexts["No features yet"].waitForExistence(timeout: 8) || app.cells.firstMatch.waitForExistence(timeout: 2))
        shot("real-features")
        app.tabBars.buttons["Office"].tap()
        app.buttons["Settings"].tap()
        let online = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Online'")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 8), "socket open against the real server with the token")
        shot("real-settings")
    }

    /// Approves one pending tool on a real session, only if it is a read-only Travsr lookup.
    /// Runs only with `TEST_RUNNER_REAL_APPROVE=<employeeId>` on a simulator already paired with the real server.
    func testRealApproveReadOnlyTool() throws {
        guard let employee = ProcessInfo.processInfo.environment["REAL_APPROVE"] else { throw XCTSkip("REAL_APPROVE not set") }
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_TALK": employee]
        app.launch()
        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20), "the real session's pending approval is inline")
        let header = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Approve '")).firstMatch
        XCTAssertTrue(header.exists)
        let tool = header.label
        shot("real-approval-card")
        guard tool.contains("travsr") && tool.contains("get_context") else {
            XCTFail("refusing to approve a tool that is not a read-only Travsr lookup: \(tool)")
            return
        }
        allow.tap()
        let cleared = NSPredicate { _, _ in !self.app.buttons["Allow once"].exists }
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: cleared, object: nil)], timeout: 30), .completed,
                       "agent.updated clears the approval after the server took the decision")
        shot("real-approval-cleared")
    }

    /// Talk turn 2 of 3, approved by the lead: a slow prompt to an idle employee, interrupted mid-stream.
    /// Runs only with `TEST_RUNNER_REAL_TALK=<employeeId>` on a simulator already paired with the real server.
    func testRealTalkStreamsAndInterrupts() throws {
        guard let employee = ProcessInfo.processInfo.environment["REAL_TALK"] else { throw XCTSkip("REAL_TALK not set") }
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_TALK": employee]
        app.launch()
        let composer = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Message '")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("Count slowly from 1 to 50, one number per line, no tools.")
        app.buttons["Send"].tap()
        let interrupt = app.buttons["Interrupt"]
        XCTAssertTrue(interrupt.waitForExistence(timeout: 30), "the session is running, so Interrupt is offered")
        let sent = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Count slowly'")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 20), "the sent line comes back from the session log")
        shot("real-talk-running")
        interrupt.tap()
        let stopped = NSPredicate { _, _ in !self.app.buttons["Interrupt"].exists }
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: stopped, object: nil)], timeout: 60), .completed, "interrupt ends the running state")
        sleep(3)
        shot("real-talk-interrupted")
        XCTAssertFalse(app.buttons["Allow once"].exists, "no tool approval was requested by a no-tools prompt")
        app.tabBars.buttons["Office"].tap()
        XCTAssertTrue(app.staticTexts["Spend today"].waitForExistence(timeout: 10))
        shot("real-office-after-talk")
    }

    func testPairingScreenRefusesABadCode() {
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1"]
        app.launchArguments = ["-workplace.serverURL", ""]
        app.launch()
        let url = app.textFields["192.168.1.5:4317"]
        XCTAssertTrue(url.waitForExistence(timeout: 8), "no saved server URL means the pairing screen")
        url.tap(); url.typeText("127.0.0.1:4399")
        let code = app.textFields["Pairing code"]
        code.tap(); code.typeText("000000")
        app.buttons["Pair this phone"].tap()
        XCTAssertTrue(app.staticTexts["Unknown or expired code"].waitForExistence(timeout: 8), "the server's refusal is shown verbatim")
        shot("pairing-refused")
    }
}
