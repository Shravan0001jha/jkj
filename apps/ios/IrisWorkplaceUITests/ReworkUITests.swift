import XCTest

/// The October 2026 rework (docs/LLD-rework-2026-10.md W5) against the mock (`make mock`): the
/// story's chain and audit, a reason on every status change, Parked with its resume-when, the
/// Plan's "Done (N)", the COO note on an Inbox item, super focus and the Mac queue.
final class ReworkUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        var req = URLRequest(url: URL(string: "http://127.0.0.1:4399/api/_reset")!)
        req.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: req)
        app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": "127.0.0.1:4399", "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1"]
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func label(_ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
    private func reveal(_ e: XCUIElement, up: Bool = true, swipes: Int = 10) -> Bool {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { if up { app.swipeUp() } else { app.swipeDown() }; n += 1; _ = e.waitForExistence(timeout: 0.5) }
        // Clear of the bottom bars (the comment composer, the tab bar) so a tap lands on it.
        n = 0
        while e.exists && e.frame.midY > app.frame.height * 0.65 && n < 4 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)))
            n += 1
        }
        return e.exists && e.isHittable
    }

    func testStoryShowsChainAndAuditAndParkingNeedsReasonAndResumeWhen() {
        app.launchEnvironment["WORKPLACE_ITEM"] = "as_mock_waiting"
        app.launch()
        XCTAssertTrue(label("Waiting on").waitForExistence(timeout: 10), "the waiting box names who")
        XCTAssertTrue(any("item.doc").exists, "the doc link")
        shot("story-waiting")

        // Parked: the sheet refuses to save until it has a reason and a resume-when.
        any("item.state").tap()
        app.buttons["Parked…"].tap()
        let save = app.buttons["status.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 3))
        XCTAssertFalse(save.isEnabled, "no reason yet")
        let reason = any("status.reason")
        reason.tap(); reason.typeText("Not before the release")
        XCTAssertFalse(save.isEnabled, "still no resume-when")
        let resume = any("status.resumeWhen")
        resume.tap(); resume.typeText("after 0.2.22 ships")
        XCTAssertTrue(save.isEnabled)
        shot("parked-sheet")
        save.tap()
        XCTAssertTrue(label("Resume when: after 0.2.22 ships").waitForExistence(timeout: 6), "the parked box with its resume-when")

        // The audit has the change with its reason; the chain lists everyone.
        XCTAssertTrue(reveal(app.staticTexts["Not before the release"]), "the reason is on the audit")
        XCTAssertTrue(reveal(label("not recorded")), "the creation row has no reason")
        shot("audit")
        XCTAssertTrue(reveal(any("item.chain.Developer"), up: false) || any("item.chain.Developer").exists)
        XCTAssertTrue(any("item.chain.QA").exists)
        shot("chain")
    }

    func testAChainPersonOpensTheirTalkThread() {
        app.launchEnvironment["WORKPLACE_ITEM"] = "as_mock_waiting"
        app.launch()
        let qa = any("item.chain.QA")
        XCTAssertTrue(qa.waitForExistence(timeout: 10) || reveal(qa))
        XCTAssertTrue(reveal(qa))
        qa.tap()
        XCTAssertTrue(app.tabBars.buttons["Talk"].waitForExistence(timeout: 3))
        let selected = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: app.tabBars.buttons["Talk"])
        wait(for: [selected], timeout: 5)
        shot("chain-talk")
    }

    func testReassignAsksForAReason() {
        app.launchEnvironment["WORKPLACE_ITEM"] = "as_mock_waiting"
        app.launch()
        let assignee = any("item.assignee")
        XCTAssertTrue(assignee.waitForExistence(timeout: 10))
        assignee.tap()
        app.buttons["Me"].tap()
        let field = any("reason.text")
        XCTAssertTrue(field.waitForExistence(timeout: 3), "a reassign opens the reason sheet")
        XCTAssertFalse(app.buttons["Reassign"].isEnabled)
        field.tap(); field.typeText("I will test it myself")
        app.buttons["Reassign"].tap()
        XCTAssertTrue(label("You").waitForExistence(timeout: 6))
    }

    func testFinishedEpicsCollectInACollapsedDoneSection() {
        app.launch()
        let done = any("plan.done")
        XCTAssertTrue(done.waitForExistence(timeout: 10) || reveal(done))
        XCTAssertTrue(reveal(done))
        XCTAssertFalse(app.staticTexts["Push notifications that need you"].exists, "collapsed by default")
        done.tap()
        XCTAssertTrue(app.staticTexts["Push notifications that need you"].waitForExistence(timeout: 3) || reveal(app.staticTexts["Push notifications that need you"]))
        shot("plan-done")
    }

    func testInboxItemShowsTheCooNoteOnTop() {
        app.launchEnvironment["WORKPLACE_INBOX_ITEM"] = "in_muqel76q1h1i1"
        app.launch()
        let note = any("inbox.cooNote")
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertTrue(reveal(note, up: false))
        XCTAssertTrue(label("needs you because").exists)
        shot("inbox-coo-note")
    }

    func testSuperFocusAndGrantingTheMac() {
        app.launchEnvironment["WORKPLACE_SETTINGS"] = "1"
        app.launch()
        let toggle = app.switches["settings.superFocus"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10) || reveal(toggle))
        XCTAssertTrue(reveal(toggle))
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        XCTAssertTrue(app.buttons["4 hours"].waitForExistence(timeout: 3))
        app.buttons["4 hours"].tap()
        XCTAssertTrue(any("settings.superFocus.until").waitForExistence(timeout: 5), "on until a time")
        shot("super-focus-on")

        let grant = any("settings.macQueue.grant")
        XCTAssertTrue(reveal(grant))
        shot("mac-queue")
        grant.tap()
        let devHas = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Dev' AND label CONTAINS 'Has the Mac'")).firstMatch
        XCTAssertTrue(devHas.waitForExistence(timeout: 6), "the head of the queue now has the Mac")
        shot("mac-queue-granted")
    }
}
