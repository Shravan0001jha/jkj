import XCTest

/// The v2 screens against the mock (`make mock`), which serves the plan captured from the live
/// Workplace plus mock additions (mock/v2.mjs). Each test starts from the mock's seed state.
final class V2UITests: XCTestCase {
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

    private func reveal(_ e: XCUIElement, swipes: Int = 8) -> Bool {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(); n += 1; _ = e.waitForExistence(timeout: 0.5) }
        return e.exists && e.isHittable
    }

    func testPlanIsHomeWithMineOnTopAreasFocusAndBoard() {
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Plan"].isSelected || app.tabBars.buttons["Plan"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["Assigned to you"].waitForExistence(timeout: 8), "assigned to the owner, on top")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Test the music fix on your Mac'")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Voice & audio"].exists, "areas with their epics")
        let p0 = app.buttons.matching(NSPredicate(format: "label CONTAINS 'P0 bug bundle' AND label CONTAINS 'pts'")).firstMatch
        XCTAssertTrue(p0.exists, "the P0 epic card")
        XCTAssertTrue(p0.label.contains("Focus"), "the focus epic is marked: \(p0.label)")
        XCTAssertTrue(p0.label.contains("Blocked · waiting on"), "the blocked flag with who it waits on: \(p0.label)")
        XCTAssertTrue(p0.label.contains("pts"), "points done / total: \(p0.label)")
        shot("plan")
        app.buttons["Board"].tap()
        XCTAssertTrue(app.staticTexts["Backlog"].waitForExistence(timeout: 8), "the board groups by state")
        shot("plan-board")
    }

    func testEpicPageAssignStoryToMeAndCommentWithMention() {
        app.launchEnvironment["WORKPLACE_ITEM"] = "ft_mummakwyuew19"
        app.launch()
        XCTAssertTrue(app.staticTexts["item.title"].waitForExistence(timeout: 8))
        let story = app.buttons.matching(NSPredicate(format: "label CONTAINS 'QA and Release'")).firstMatch
        XCTAssertTrue(reveal(story), "child stories are listed")
        story.tap()
        let assignee = app.buttons["item.assignee"]
        XCTAssertTrue(assignee.waitForExistence(timeout: 8))
        assignee.tap()
        app.buttons["Me"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Assignee' AND label CONTAINS 'You'")).firstMatch.waitForExistence(timeout: 6), "reassigned to the owner once the server said so")
        shot("story-assigned-to-me")
        // Into review without a reviewer: the server refuses, in its own words.
        app.buttons["item.state"].tap()
        app.buttons["In review"].tap()
        XCTAssertTrue(app.alerts.staticTexts["A reviewer is required before an item can enter review."].waitForExistence(timeout: 6))
        app.alerts.buttons["OK"].tap()
        let field = app.textFields["item.comment"]
        XCTAssertTrue(field.waitForExistence(timeout: 4))
        field.tap(); field.typeText("@nikhil can you review this?")
        app.buttons["Post comment"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '@nikhil can you review'")).firstMatch.waitForExistence(timeout: 8), "the comment shows once posted")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'On it'")).firstMatch.waitForExistence(timeout: 8), "the mentioned employee answers in the thread")
        shot("story-comment")
    }

    func testInboxThreadRecommendedOptionAndFreeTextReply() {
        app.launchEnvironment["WORKPLACE_INBOX_ITEM"] = "in_muqel76q1h1i1"
        app.launch()
        XCTAssertTrue(app.staticTexts["inbox.question"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["High"].exists, "urgency by colour and label")
        XCTAssertTrue(app.buttons["Approve the 2-entry manual map edit now, recommended"].exists, "the recommended option is marked")
        XCTAssertTrue(app.staticTexts["Why not add the remap kind now?"].exists, "the conversation as bubbles")
        let reply = app.textFields["inbox.reply"]
        reply.tap(); reply.typeText("Fine, but file the remap kind as a story.")
        XCTAssertEqual(reply.value as? String, "Fine, but file the remap kind as a story.", "typed")
        app.buttons["Send reply"].tap()
        sleep(2)   // the asker's answer lands over the socket ~1 s later
        let answer = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Understood'")).firstMatch
        XCTAssertTrue(reveal(answer), "the asker answers in the thread")
        XCTAssertTrue(app.staticTexts["Fine, but file the remap kind as a story."].exists, "the owner's reply is in the thread")
        XCTAssertTrue(app.buttons["Hold for now"].exists || app.buttons["Hold for now"].waitForExistence(timeout: 1), "text alone leaves the decision open")
        shot("inbox-thread")
    }

    func testUpdateOpensItsItemAndReleaseChangeOpensItsStory() {
        app.launchEnvironment["WORKPLACE_TAB"] = "updates"
        app.launch()
        let blocked = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Blocked: P0 bug bundle'")).firstMatch
        XCTAssertTrue(blocked.waitForExistence(timeout: 8), "newest-first one-line events")
        shot("updates")
        blocked.tap()
        XCTAssertTrue(app.staticTexts["item.title"].waitForExistence(timeout: 8), "tapping an update opens its item")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Blocked · waiting on'")).firstMatch.exists)

        app.tabBars.buttons["Room"].tap()
        let releases = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Releases'")).firstMatch
        XCTAssertTrue(reveal(releases), "Releases is a room")
        releases.tap()
        let post = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Iris 0.2.15'")).firstMatch
        XCTAssertTrue(post.waitForExistence(timeout: 8))
        post.tap()
        XCTAssertTrue(app.staticTexts["Voice & audio"].waitForExistence(timeout: 6), "changes grouped by area")
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Music controls act on the player'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["item.title"].waitForExistence(timeout: 8), "a change opens its story")
        shot("release-change-story")
    }

    func testTalkShowsOnlyWrittenMessages() {
        app.launchEnvironment["WORKPLACE_TALK"] = "mira"
        app.launch()
        XCTAssertTrue(app.navigationBars["Mira"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Expert added'")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["Assignment a-1: Errand receiver on the Mac. Reply with ## Plan first."].exists, "the Workplace's prompt is not shown as the owner's message")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'worked'")).firstMatch.exists, "it is folded into a quiet activity line")
        shot("talk-chat")
    }
}
