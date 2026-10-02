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
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'The expert is in'")).firstMatch.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["Assignment a-1: Errand receiver on the Mac. Reply with ## Plan first."].exists, "the Workplace's prompt is not shown as the owner's message")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'worked'")).firstMatch.exists, "it is folded into a quiet activity line")
        shot("talk-chat")
    }
}

/// The unified Talk chat, measured: one left edge for the other side's bubbles, one right edge for
/// the owner's, no bubble wider than 80% of the screen, the send button centred on the field.
final class ChatAlignmentUITests: XCTestCase {
    private func measure(_ talk: String, file: StaticString = #filePath, line: UInt = #line) {
        let app = XCUIApplication()
        app.launchEnvironment = ["WORKPLACE_URL": "127.0.0.1:4399", "WORKPLACE_TOKEN": "mock-token-0123456789abcdef",
                                 "WORKPLACE_NO_NOTIF_PROMPT": "1", "WORKPLACE_NO_DEVICE_AUTH": "1", "WORKPLACE_TALK": talk]
        app.launch()
        let field = app.textFields["chat.composer"]
        XCTAssertTrue(field.waitForExistence(timeout: 8), file: file, line: line)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat.theirs").firstMatch.waitForExistence(timeout: 8), file: file, line: line)
        sleep(1)
        let width = app.windows.firstMatch.frame.width
        let theirs = app.descendants(matching: .any).matching(identifier: "chat.theirs").allElementsBoundByIndex.map(\.frame).filter { $0.width > 0 }
        let mine = app.descendants(matching: .any).matching(identifier: "chat.mine").allElementsBoundByIndex.map(\.frame).filter { $0.width > 0 }
        XCTAssertFalse(theirs.isEmpty, "bubbles found", file: file, line: line)
        let lefts = Set(theirs.map { Int($0.minX.rounded()) })
        XCTAssertEqual(lefts.count, 1, "one left edge: \(lefts)", file: file, line: line)
        if !mine.isEmpty {
            let rights = Set(mine.map { Int($0.maxX.rounded()) })
            XCTAssertEqual(rights.count, 1, "one right edge: \(rights)", file: file, line: line)
            XCTAssertEqual(Double(lefts.first!), Double(width) - Double(rights.first!), accuracy: 1, "symmetric gutters", file: file, line: line)
        }
        // Accessibility frames of a combined element are outset ~4 pt on each side of the drawn
        // bubble (the drawn left edge is the 10 pt gutter; the frame reads 6): allow for it.
        for f in theirs + mine { XCTAssertLessThanOrEqual(f.width, width * 0.8 + 8, "≤ 80% wide: \(f.width) of \(width)", file: file, line: line) }
        let send = app.buttons["chat.send"]
        XCTAssertEqual(send.frame.midY, field.frame.midY, accuracy: 1, "send is centred on the field", file: file, line: line)
        let tab = app.tabBars.firstMatch
        if tab.exists { XCTAssertLessThanOrEqual(field.frame.maxY, tab.frame.minY, "the composer sits above the tab bar", file: file, line: line) }
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = "chat-\(talk)"; a.lifetime = .keepAlways; add(a)
        print("ALIGN \(talk): width=\(width) theirsLeft=\(lefts) mineRight=\(Set(mine.map { Int($0.maxX.rounded()) })) maxBubble=\((theirs + mine).map(\.width).max() ?? 0) sendMidY=\(send.frame.midY) fieldMidY=\(field.frame.midY)")
    }

    func testCooChatAlignment() { measure("coo") }
    func testEmployeeChatAlignment() { measure("mira") }
}
