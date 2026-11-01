import XCTest
import UserNotifications
@testable import IrisWorkplace

/// Chat notifications (docs/CHAT-NOTIFY-CONTRACT.md §5, §6.2–§6.4): every chat link opens that
/// exact chat, and a foreground push is shown, felt or dropped depending on what is on screen.
final class ChatLinkTests: XCTestCase {
    func testChatLinkForms() {
        let cases: [(String, AppLink)] = [
            ("chat/asha", .chat("asha")),
            ("chat/coo", .chat("coo")),
            ("#/chat/dev", .chat("dev")),
            ("/chat/dev/", .chat("dev")),
            ("Chat/coo", .chat("coo")),
            ("chat/th%20x", .chat("th x")),
            ("irisworkplace://chat/coo", .chat("coo")),
            ("chat", .talkList),
            ("#/chat", .talkList),
            // Rooms keep their own form (server: `room/<roomThreadId>`).
            ("room/th_1", .room("th_1")),
        ]
        for (raw, want) in cases { XCTAssertEqual(AppLink.parse(raw), want, raw) }
    }

    func testAChatPushAlwaysOpensItsChat() {
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "chat/asha", "threadId": "asha", "employeeId": "asha"], category: "WP_CHAT"), .chat("asha"))
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "chat/coo", "threadId": "coo"], category: "WP_CHAT"), .chat("coo"))
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "room/th_9", "threadId": "th_9"], category: "WP_CHAT"), .room("th_9"), "a room message opens the room thread")
        XCTAssertEqual(AppLink.resolve(userInfo: ["threadId": "dev"], category: "WP_CHAT"), .chat("dev"), "no link: the thread id is a chat, not a room")
        XCTAssertEqual(AppLink.resolve(userInfo: ["link": "chat"], category: "WP_CHAT"), .talkList)
        XCTAssertEqual(AppLink.resolve(userInfo: [:], category: "WP_CHAT"), .talkList, "a bare chat push: the Talk list")
        XCTAssertEqual(AppLink.resolve(userInfo: ["threadId": "th_1"], category: "WP_ROOM"), .room("th_1"), "other categories keep the room fallback")
    }

    @MainActor
    func testOpeningAChatRoutesToTalk() {
        let m = AppModel(relayTokens: MemoryTokenStore(token: "s"), lanTokens: MemoryTokenStore(),
                         defaults: UserDefaults(suiteName: "ChatLinkTests")!, notifier: FakeNotifier(),
                         urlSession: StubURLProtocol.session(), makeTransport: { FakeSocketTransport() },
                         webAuth: FakeWebAuth(), env: [:], pathMonitor: nil, deviceAuth: FakeDeviceAuth())
        m.router.showSettings = true
        m.open(.chat("coo"))
        XCTAssertEqual(m.router.tab, .talk)
        XCTAssertEqual(m.router.talkEmployeeId, "coo")
        XCTAssertFalse(m.router.showSettings, "a sheet closes first")
        m.open(.chat("asha"))
        XCTAssertEqual(m.router.talkEmployeeId, "asha")
        m.router.talkEmployeeId = nil
        m.open(.talkList)
        XCTAssertEqual(m.router.tab, .talk)
        XCTAssertTrue(m.router.talkList)
        m.open(.room("th_1"))
        XCTAssertEqual(m.router.tab, .room)
        XCTAssertEqual(m.router.roomThreadId, "th_1")
    }

    /// A cold launch from a chat push: the tap waits for the router, then opens the chat.
    @MainActor
    func testAChatTapBeforeLaunchFinishesIsKept() {
        let push = PushManager()
        var opened: [AppLink] = []
        push.deliver(AppLink.resolve(userInfo: ["link": "chat/coo", "threadId": "coo"], category: "WP_CHAT"))
        push.onOpen = { opened.append($0) }
        XCTAssertEqual(opened, [.chat("coo")])
    }

    func testChatCategoryAndActions() {
        let chat = PushCategory.all.first { $0.identifier == "WP_CHAT" }
        XCTAssertNotNil(chat)
        XCTAssertEqual(chat?.actions.map(\.identifier), ["REPLY", "MUTE_1H"])
        XCTAssertTrue(chat?.actions.first is UNTextInputNotificationAction, "Reply takes text")
        for a in chat?.actions ?? [] {
            XCTAssertTrue(a.options.contains(.authenticationRequired), "\(a.identifier) never runs from a locked phone")
            XCTAssertFalse(a.options.contains(.destructive))
        }
    }
}

final class ChatPushPolicyTests: XCTestCase {
    private func decide(_ info: [AnyHashable: Any], category: String = "WP_CHAT", onScreen: Set<String> = [],
                        muted: Set<String> = []) -> ChatPresentation {
        ChatPushPolicy.decide(userInfo: info, category: category, onScreen: onScreen) { id, _ in muted.contains(id) }
    }

    func testTheChatOnScreenOnlyTaps() {
        XCTAssertEqual(decide(["link": "chat/asha", "threadId": "asha"], onScreen: ["asha"]), .haptic)
        XCTAssertEqual(decide(["link": "chat/coo", "threadId": "coo"], onScreen: ["coo"]), .haptic)
        XCTAssertEqual(decide(["link": "room/th_1", "threadId": "th_1"], onScreen: ["th_1"]), .haptic)
    }

    func testAnotherChatOrScreenShowsABanner() {
        XCTAssertEqual(decide(["link": "chat/asha", "threadId": "asha"], onScreen: ["coo"]), .show)
        XCTAssertEqual(decide(["link": "chat/asha", "threadId": "asha"]), .show)
        XCTAssertEqual(ChatPushPolicy.options(for: .show), [.banner, .sound, .list])
        XCTAssertEqual(ChatPushPolicy.options(for: .haptic), [])
        XCTAssertEqual(ChatPushPolicy.options(for: .drop), [])
    }

    func testAMutedChatIsDropped() {
        XCTAssertEqual(decide(["link": "chat/dev", "threadId": "dev"], muted: ["dev"]), .drop)
        XCTAssertEqual(decide(["link": "chat/dev", "threadId": "dev"], onScreen: ["dev"], muted: ["dev"]), .drop, "muted wins: no haptic either")
        XCTAssertEqual(decide(["link": "chat/asha", "threadId": "asha"], muted: ["dev"]), .show)
    }

    func testTheThreadComesFromTheLinkWhenTheDataHasNone() {
        XCTAssertEqual(decide(["link": "chat/asha"], onScreen: ["asha"]), .haptic)
        XCTAssertEqual(ChatPushPolicy.thread(userInfo: ["link": "room/th_2"], category: "WP_CHAT")?.isRoom, true)
        XCTAssertEqual(ChatPushPolicy.thread(userInfo: ["link": "chat/coo"], category: "WP_CHAT")?.isRoom, false)
        XCTAssertEqual(ChatPushPolicy.thread(userInfo: ["link": "chat/coo"], category: "")?.id, "coo", "a chat link is a chat push whatever its category")
    }

    func testTheRoomFlagReachesTheMuteCheck() {
        var asked: [(String, Bool)] = []
        _ = ChatPushPolicy.decide(userInfo: ["link": "room/th_1", "threadId": "th_1"], category: "WP_CHAT", onScreen: []) { id, room in asked.append((id, room)); return false }
        XCTAssertEqual(asked.first?.0, "th_1")
        XCTAssertEqual(asked.first?.1, true)
    }

    func testOtherPushesKeepTheirPath() {
        XCTAssertEqual(decide(["link": "inbox/in_1", "inboxId": "in_1"], category: "WP_INBOX"), .notChat)
        XCTAssertEqual(decide(["link": "room/th_1", "threadId": "th_1"], category: "WP_ROOM", muted: ["th_1"]), .notChat, "a room escalation is not a chat message")
        XCTAssertEqual(decide([:], category: "WP_CHAT"), .show, "a chat push with no thread still shows")
    }
}
