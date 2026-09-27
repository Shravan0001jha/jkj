import XCTest

/// Drives the one-tap flows against the mock server (`make mock`, port 4399).
/// Each test launches the app already paired (debug launch environment) and taps like the owner would.
final class WorkplaceUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
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
        app.sheets.buttons["Cancel"].firstMatch.tap()
        XCTAssertTrue(release.waitForExistence(timeout: 2), "cancel leaves the item open")
        release.tap()
        app.sheets.buttons["Release 0.2.16"].firstMatch.tap()
        let done = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Release 0.2.16 ·'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 8), "the item shows the recorded answer after the server confirmed")
        XCTAssertTrue(done.label.contains("via phone"), done.label)
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
        let mira = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mira'")).firstMatch
        XCTAssertTrue(mira.waitForExistence(timeout: 8))
        mira.tap()
        XCTAssertTrue(app.navigationBars["Mira"].waitForExistence(timeout: 6), "a card opens Talk with that employee")
        app.buttons["More"].tap()
        app.buttons["Charter and status"].tap()
        XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["Status"].exists)
        XCTAssertTrue(app.staticTexts["Handoff"].exists)
        let experts = app.staticTexts["Experts"].firstMatch
        XCTAssertTrue(experts.waitForExistence(timeout: 4))
        experts.tap()
        XCTAssertTrue(app.navigationBars["Experts"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.staticTexts["Never fire-and-forget a send."].waitForExistence(timeout: 6), "the full charter loads")
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
