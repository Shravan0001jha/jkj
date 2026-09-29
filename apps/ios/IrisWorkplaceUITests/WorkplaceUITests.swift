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
            "WORKPLACE_NO_DEVICE_AUTH": "1",
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

    /// Swipe until the element is hittable (the item's options sit below who/what/links).
    /// Lazy lists do not instantiate rows below the fold: swipe until the element exists and is hittable.
    @discardableResult
    private func reveal(_ e: XCUIElement, swipes: Int = 8) -> Bool {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(); n += 1; _ = e.waitForExistence(timeout: 0.5) }
        return e.exists && e.isHittable
    }

    func testDangerOptionAsksForConfirmationThenAnswers() {
        launch(["WORKPLACE_INBOX_ITEM": "ib-1"])
        XCTAssertTrue(app.staticTexts["If you approve"].waitForExistence(timeout: 8), "the item loaded")
        let release = app.buttons["Release 0.2.16"]
        XCTAssertTrue(reveal(release), "the danger option is a button on the item")
        let releaseY = release.frame.midY / app.frame.height   // before the dialog adds a second button with this label
        release.tap()
        let confirm = app.sheets.buttons["Release 0.2.16"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 4), "a danger option confirms before it acts")
        shot("danger-confirm")
        // Cancel: the Cancel button where the OS shows one, otherwise a tap outside the dialog.
        if app.buttons["Cancel"].exists {
            app.buttons["Cancel"].firstMatch.tap()
        } else {
            // The popover sits beside its button: tap on the far side of the screen from it.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: releaseY > 0.5 ? 0.22 : 0.85)).tap()
        }
        XCTAssertFalse(confirm.waitForExistence(timeout: 2), "the dialog is gone")
        XCTAssertTrue(release.firstMatch.waitForExistence(timeout: 2), "cancel leaves the item open")
        reveal(release.firstMatch)
        release.firstMatch.tap()
        app.sheets.buttons["Release 0.2.16"].firstMatch.tap()
        let done = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Release 0.2.16 ·'")).firstMatch
        XCTAssertTrue(reveal(done) || done.waitForExistence(timeout: 8), "the item shows the recorded answer after the server confirmed")
        XCTAssertTrue(done.label.contains(" via "), done.label)   // web for a loopback client, phone off-loopback
        shot("danger-answered")
    }

    func testNeedsNoteOptionAsksForANote() {
        launch(["WORKPLACE_INBOX_ITEM": "ib-3"])
        XCTAssertTrue(app.staticTexts["If you approve"].waitForExistence(timeout: 8), "the item loaded")
        let raise = app.buttons["Raise for today"]
        XCTAssertTrue(reveal(raise))
        raise.tap()
        let field = app.alerts.textFields.firstMatch
        if !field.waitForExistence(timeout: 3) { raise.tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 4), "a needsNote option asks for the note")
        XCTAssertFalse(app.alerts.buttons["Send"].isEnabled, "no empty notes")
        field.tap()
        field.typeText("250")
        shot("note-prompt")
        app.alerts.buttons["Send"].tap()
        let done = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Raise for today ·'")).firstMatch
        XCTAssertTrue(reveal(done) || done.waitForExistence(timeout: 8))
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
        let asha = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Asha' AND label CONTAINS 'Chief of Staff'")).firstMatch
        XCTAssertTrue(asha.waitForExistence(timeout: 8))
        asha.tap()
        XCTAssertTrue(app.tabBars.buttons["Talk"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.navigationBars["Asha"].waitForExistence(timeout: 6), "a card opens Talk with that employee (tab selected: \(app.tabBars.buttons["Talk"].isSelected))")
        app.navigationBars["Asha"].buttons["More"].tap()
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
        launch(["WORKPLACE_TAB": "features"])
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
        app.swipeDown()   // the keyboard covers the tab bar until dismissed
        app.tabBars.buttons["Office"].tap()
        XCTAssertTrue(app.staticTexts["Spend today"].waitForExistence(timeout: 10))
        shot("real-office-after-talk")
    }

    func testPairingScreenRefusesABadCode() {
        app.launchEnvironment = ["WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_FORGET": "1", "WORKPLACE_RELAY_URL": "127.0.0.1:4399"]
        app.launch()
        XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 8), "a fresh install starts at the relay sign-in")
        app.buttons["Developer options"].tap()
        let toggle = app.switches["Use a LAN Workplace (pairing)"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 6), "LAN pairing is behind the developer toggle")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        let url = app.textFields["192.168.1.5:4317"]
        XCTAssertTrue(url.waitForExistence(timeout: 8), "turning it on opens the pairing sheet")
        url.tap(); url.typeText("127.0.0.1:4399")
        let code = app.textFields["Pairing code"]
        code.tap(); code.typeText("000000")
        app.buttons["Pair this phone"].tap()
        XCTAssertTrue(app.staticTexts["Unknown or expired code"].waitForExistence(timeout: 8), "the server's refusal is shown verbatim")
        shot("pairing-refused")
    }
}

/// The screens added for the 28 Sep contract: Room, Spend, Needs-you on the employee page.
final class NewContractUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        var req = URLRequest(url: URL(string: "http://127.0.0.1:4399/api/_reset")!)
        req.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: req)
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": "127.0.0.1:4399", "WORKPLACE_TOKEN": "mock-token-0123456789abcdef", "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1"]
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testRoomListThreadPostAndLiveReply() {
        app.launchEnvironment["WORKPLACE_ROOM"] = "list"
        app.launch()
        XCTAssertTrue(app.navigationBars["Team Room"].waitForExistence(timeout: 8))
        let thread = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mac socket contract'")).firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 6), "threads list with the headline")
        XCTAssertTrue(app.staticTexts["Blocked on the socket shape; escalated to you as ib-5."].exists, "the headline is the one-line status")
        shot("room-list")
        thread.tap()
        // The thread's own title is the nav title now, not a generic "Thread" (Room D2).
        XCTAssertTrue(app.navigationBars["Mac socket contract for errands"].waitForExistence(timeout: 6))
        let long = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Not published yet.'")).firstMatch
        XCTAssertTrue(long.waitForExistence(timeout: 8), "messages are one line")
        long.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'requestedAt ISO'")).firstMatch.waitForExistence(timeout: 4), "tap expands the details")
        shot("room-thread-expanded")
        let composer = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Post as you'")).firstMatch
        composer.tap(); composer.typeText("Reuse ask_mac for now. @kabir go ahead.")
        XCTAssertTrue(app.staticTexts["Kabir"].waitForExistence(timeout: 5), "the mention is recognised")
        app.buttons["Post"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Reuse ask_mac for now.'")).firstMatch.waitForExistence(timeout: 8), "the owner's post appears from the server")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Noted. I will answer'")).firstMatch.waitForExistence(timeout: 10), "the mentioned employee's live reply streams in")
        app.swipeDown()
        shot("room-thread-posted")
    }

    func testGeneralChannelIsPinnedAboveTopicsAndShowsTheWholeTeam() {
        app.launchEnvironment["WORKPLACE_ROOM"] = "list"
        app.launch()
        XCTAssertTrue(app.navigationBars["Team Room"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Channel"].waitForExistence(timeout: 6), "General sits in its own section, above the topic threads")
        let general = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'General'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 4))
        shot("room-list-general")
        general.tap()
        XCTAssertTrue(app.navigationBars["General"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Morning. Errand flow'")).firstMatch.waitForExistence(timeout: 6), "the seeded channel history is there")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'One thing: Kabir is blocked'")).firstMatch.waitForExistence(timeout: 6), "Claude posts in the channel like anyone else")
        shot("general-channel")
        let composer = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Post as you'")).firstMatch
        composer.tap(); composer.typeText("@")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Kabir'")).firstMatch.waitForExistence(timeout: 4), "the @ picker suggests everyone once the @ is typed")
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Kabir'")).firstMatch.tap()
        XCTAssertTrue(app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Post as you'")).firstMatch.value as? String != "@", "picking a name from the picker fills it in")
    }

    func testCooCardShowsPresenceAndOpensTalk() {
        app.launch()
        let coo = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Claude' AND label CONTAINS 'Chief Operating Officer' AND label CONTAINS 'online'")).firstMatch
        XCTAssertTrue(coo.waitForExistence(timeout: 8), "the COO card shows above the units with her presence")
        shot("office-coo-card")
        coo.tap()
        XCTAssertTrue(app.navigationBars["Claude"].waitForExistence(timeout: 6), "the card opens the same Talk chat UI as any employee")
        shot("talk-coo")
    }

    func testMentionedEmployeeShowsReplyingThenTheAnswerInAThread() {
        app.launchEnvironment["WORKPLACE_ROOM"] = "rt-socket"
        app.launch()
        let composer = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Post as you'")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("Reuse ask_mac. @kabir go ahead.")
        app.buttons["Post"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'is replying'")).firstMatch.waitForExistence(timeout: 3), "replying shows as soon as the post lands, before the answer")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Noted. I will answer'")).firstMatch.waitForExistence(timeout: 10), "then the real reply arrives")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'is replying'")).firstMatch.exists, "replying clears once the message lands")
    }

    func testSpendShowsRealMoneyAndFreeSubscriptionUsage() {
        app.launchEnvironment["WORKPLACE_SPEND"] = "1"
        app.launch()
        XCTAssertTrue(app.navigationBars["Spend"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Anthropic API"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.staticTexts["estimate"].exists, "estimates are labelled")
        shot("spend")
        var n = 0
        while !app.staticTexts["not billed"].exists && n < 6 { app.swipeUp(); n += 1 }
        XCTAssertTrue(app.staticTexts["Subscription usage (free)"].exists)
        XCTAssertTrue(app.staticTexts["not billed"].exists)
        n = 0
        while !app.staticTexts["7-day window"].exists && n < 6 { app.swipeUp(); n += 1 }
        XCTAssertTrue(app.staticTexts["7-day window"].exists)
        shot("spend-subscription")
    }

    func testEmployeePageNeedsYouAnswersInPlace() {
        app.launchEnvironment["WORKPLACE_TALK"] = "kabir"
        app.launch()
        XCTAssertTrue(app.navigationBars["Kabir"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Needs you · 1"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Kabir: which socket contract for Mac errands?"].exists)
        XCTAssertTrue(app.staticTexts["Kabir builds on the ask_mac shape today."].exists, "what approve does is shown")
        shot("employee-needs-you")
        app.buttons["Reuse ask_mac"].tap()
        let gone = NSPredicate { _, _ in !self.app.staticTexts["Needs you · 1"].exists }
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: gone, object: nil)], timeout: 8), .completed, "answered → gone from the page via inbox.updated")
        shot("employee-needs-you-answered")
    }

    func testOfficeCountsStalledAndStateReason() {
        app.launch()
        XCTAssertTrue(app.staticTexts["stalled"].waitForExistence(timeout: 8))
        let reason = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'waiting for your approval to run the errand tests'")).firstMatch
        var n = 0
        while !reason.exists && n < 5 { app.swipeUp(); n += 1; _ = reason.waitForExistence(timeout: 0.5) }
        XCTAssertTrue(reason.exists, "the state reason shows on the card")
        while app.buttons["Alerts"].exists == false && n < 10 { app.swipeDown(); n += 1 }
        app.buttons["Alerts"].tap()
        XCTAssertTrue(app.navigationBars["Alerts"].waitForExistence(timeout: 4), "alerts open as a sheet from the bell")
        app.buttons["Done"].tap()
        shot("office-counts")
    }

    func testInboxItemShowsWhoWhatAndRoomLink() {
        app.launchEnvironment["WORKPLACE_INBOX_ITEM"] = "ib-1"
        app.launch()
        XCTAssertTrue(app.staticTexts["If you approve"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["If you refuse"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Nikhil, Rohan, Asha'")).firstMatch.waitForExistence(timeout: 8), "affects, with names once the Office loaded")
        app.buttons["Details"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'kills the running Iris'")).firstMatch.waitForExistence(timeout: 4), "details expand")
        shot("inbox-item-who-what")
        app.swipeUp()
        app.buttons["Team Room: release readiness"].tap()
        XCTAssertTrue(app.navigationBars["Release readiness 0.2.16"].waitForExistence(timeout: 6), "the #/room link opens the thread in the Room tab")
    }
}
