import XCTest
import UserNotifications
@testable import IrisWorkplace

/// Notification taps (owner, 1 Nov: "tapping a chat notification does not open the chat").
///
/// iOS calls the delegate through Objective-C with a completion handler, and UIKit asserts that
/// handler runs on the main thread when the tap is what brings the app up (killed / background):
/// otherwise SIGABRT in -[UIApplication _performBlockAfterCATransactionCommitSynchronizes:]. These
/// tests call the delegate the same way, from a background queue, and check the thread.
@MainActor
final class PushTapRoutingTests: XCTestCase {

    // MARK: building what iOS hands the delegate (no public initialisers)

    private func chatContent(thread: String) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = thread == "coo" ? "Claude — COO" : "Asha"
        c.body = "Hello"
        c.categoryIdentifier = PushCategory.chat
        c.threadIdentifier = "chat:\(thread)"
        // The relay's data keys, at the top level of the payload (workplace-relay/push.py).
        c.userInfo = thread == "coo" ? ["link": "chat/coo", "threadId": "coo", "level": "info"]
                                     : ["link": "chat/\(thread)", "threadId": thread, "employeeId": thread, "level": "info"]
        return c
    }

    private func notification(_ content: UNNotificationContent) throws -> UNNotification {
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        let cls: AnyObject = try XCTUnwrap(NSClassFromString("UNNotification"))
        let sel = NSSelectorFromString("notificationWithRequest:date:")
        try XCTSkipUnless(cls.responds(to: sel), "UNNotification factory unavailable on this OS")
        return try XCTUnwrap(cls.perform(sel, with: request, with: Date())?.takeUnretainedValue() as? UNNotification)
    }

    private func response(_ content: UNNotificationContent, action: String = UNNotificationDefaultActionIdentifier) throws -> UNNotificationResponse {
        let n = try notification(content)
        let cls: AnyObject = try XCTUnwrap(NSClassFromString("UNNotificationResponse"))
        let sel = NSSelectorFromString("responseWithNotification:actionIdentifier:")
        try XCTSkipUnless(cls.responds(to: sel), "UNNotificationResponse factory unavailable on this OS")
        return try XCTUnwrap(cls.perform(sel, with: n, with: action)?.takeUnretainedValue() as? UNNotificationResponse)
    }

    // MARK: tests

    func testTapCompletionRunsOnMainAndRoutesToTheChat() throws {
        let push = PushManager()
        var opened: [AppLink] = []
        push.onOpen = { opened.append($0) }
        let r = try response(chatContent(thread: "asha"))
        let delegate: UNUserNotificationCenterDelegate = push
        let done = expectation(description: "completion")
        var onMain = false
        // iOS may call from any queue; the completion must come back on the main thread.
        DispatchQueue.global().async {
            delegate.userNotificationCenter?(UNUserNotificationCenter.current(), didReceive: r) {
                onMain = Thread.isMainThread
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
        XCTAssertTrue(onMain, "UIKit asserts the didReceive completion on the main thread")
        XCTAssertEqual(opened, [.chat("asha")])
    }

    func testCooTapRoutesToCooChat() throws {
        let push = PushManager()
        var opened: [AppLink] = []
        push.onOpen = { opened.append($0) }
        let r = try response(chatContent(thread: "coo"))
        let done = expectation(description: "completion")
        (push as UNUserNotificationCenterDelegate).userNotificationCenter?(UNUserNotificationCenter.current(), didReceive: r) { done.fulfill() }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(opened, [.chat("coo")])
    }

    func testWillPresentCompletionRunsOnMain() throws {
        let push = PushManager()
        push.visibleChats = { ["coo"] }
        let n = try notification(chatContent(thread: "asha"))
        let delegate: UNUserNotificationCenterDelegate = push
        let done = expectation(description: "completion")
        var onMain = false
        var options: UNNotificationPresentationOptions = []
        DispatchQueue.global().async {
            delegate.userNotificationCenter?(UNUserNotificationCenter.current(), willPresent: n) { o in
                onMain = Thread.isMainThread; options = o
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
        XCTAssertTrue(onMain)
        XCTAssertEqual(options, [.banner, .sound, .list], "another chat is on screen: a banner")
    }

    /// A Reply action finishes its send before iOS is told the action is done (and on the main thread).
    func testChatActionCompletesAfterTheWorkOnMain() throws {
        let push = PushManager()
        var order: [String] = []
        push.onChatAction = { _ in try? await Task.sleep(for: .milliseconds(50)); order.append("work") }
        let r = try response(chatContent(thread: "asha"), action: PushCategory.mute1h)
        let done = expectation(description: "completion")
        var onMain = false
        DispatchQueue.global().async {
            (push as UNUserNotificationCenterDelegate).userNotificationCenter?(UNUserNotificationCenter.current(), didReceive: r) {
                onMain = Thread.isMainThread; order.append("done"); done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
        XCTAssertTrue(onMain)
        XCTAssertEqual(order, ["work", "done"])
    }

    // MARK: routing state

    /// Cold launch: the tap arrives before the app wires `onOpen`; it is kept and applied once.
    func testTapBeforeOnOpenIsQueuedThenAppliedToTheRouter() {
        let push = PushManager()
        push.deliver(.chat("asha"))
        XCTAssertEqual(push.pendingLink, .chat("asha"))
        let model = AppModel(relayTokens: MemoryTokenStore(), lanTokens: MemoryTokenStore(), defaults: UserDefaults(suiteName: UUID().uuidString)!,
                             pathMonitor: nil)
        push.onOpen = { model.open($0) }
        XCTAssertNil(push.pendingLink)
        XCTAssertEqual(model.router.tab, .talk)
        XCTAssertEqual(model.router.talkEmployeeId, "asha")
    }

    /// A tap for a chat closes any sheet over the tabs and selects Talk with that chat, every time.
    func testChatLinkFromAnyStateSelectsThatChat() {
        let model = AppModel(relayTokens: MemoryTokenStore(), lanTokens: MemoryTokenStore(), defaults: UserDefaults(suiteName: UUID().uuidString)!,
                             pathMonitor: nil)
        model.router.tab = .plan
        model.router.showSettings = true
        model.router.showOffice = true
        model.open(.chat("coo"))
        XCTAssertEqual(model.router.tab, .talk)
        XCTAssertEqual(model.router.talkEmployeeId, "coo")
        XCTAssertFalse(model.router.showSettings)
        XCTAssertFalse(model.router.showOffice)
        // The same chat again (the view consumed the first): set again.
        model.router.talkEmployeeId = nil
        model.open(.chat("coo"))
        XCTAssertEqual(model.router.talkEmployeeId, "coo")
    }
}
