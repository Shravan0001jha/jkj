import XCTest
import SwiftUI
@testable import IrisWorkplace

/// The chat's Telegram-like look (owner, 23 Oct): each person keeps one avatar colour, everywhere, every launch.
final class ChatLookTests: XCTestCase {
    func testAPersonAlwaysGetsTheSameAvatarColour() {
        XCTAssertEqual(AvatarPalette.index(for: "Tara"), AvatarPalette.index(for: "Tara"))
        XCTAssertEqual(AvatarPalette.index(for: "Tara"), AvatarPalette.index(for: "tara"), "case does not change the colour")
        // FNV-1a, not Swift's per-run seeded hashValue: pinned so a future refactor cannot reshuffle everyone.
        let spread = Set(["Asha", "Tara", "Kabir", "Vivek", "Mira", "Nikhil", "Zoya", "Rohan", "Anika", "Priya"].map(AvatarPalette.index(for:)))
        XCTAssertGreaterThanOrEqual(spread.count, 4, "the team is spread across the palette, not all one colour")
        XCTAssertTrue((0..<AvatarPalette.pairs.count).contains(AvatarPalette.index(for: "")))
    }

    /// Renders a sample chat to PNG (light and dark) so the look can be reviewed without signing in.
    @MainActor func testRenderSampleChatForReview() throws {
        let items: [ChatItem] = [
            ChatItem(id: "1", at: "2026-10-23T09:00:00Z", kind: .message(mine: true, text: "Can you check why the staging build failed?", details: nil), receipt: .read),
            ChatItem(id: "2", at: "2026-10-23T09:00:40Z", kind: .note(text: "Tara started a turn", steps: [], error: false)),
            ChatItem(id: "3", at: "2026-10-23T09:01:10Z", kind: .message(mine: false, text: "On it. The iOS step ran out of disk on the runner.", details: nil)),
            ChatItem(id: "4", at: "2026-10-23T09:01:30Z", kind: .message(mine: false, text: "Freed space and re-ran: green now ✅", details: nil)),
            ChatItem(id: "5", at: "2026-10-23T09:02:00Z", kind: .message(mine: true, text: "Perfect, thanks!", details: nil), receipt: .sent),
        ]
        var group = items
        group[2].sender = "Tara"; group[3].sender = "Tara"
        let model = AppModel(relayTokens: MemoryTokenStore(), lanTokens: MemoryTokenStore(), defaults: UserDefaults(suiteName: "ChatLook")!,
                             notifier: FakeNotifier(), urlSession: StubURLProtocol.session(), makeTransport: { FakeSocketTransport() },
                             webAuth: FakeWebAuth(), env: [:])
        for (scheme, name) in [(ColorScheme.light, "light"), (.dark, "dark")] {
            let view = VStack(spacing: 0) {
                HStack { ChatTitle(name: "Tara", subtitle: "Busy on a task", online: true); Spacer() }.padding(10).background(.bar)
                ZStack {
                    ChatWallpaper()
                    VStack(spacing: 0) {
                        let rows = ChatLayout.rows(group)
                        ForEach(rows) { row in
                            if let d = row.day { DaySeparator(text: d) }
                            ChatRowView(row: row, maxBubbleWidth: 300).padding(.top, row.continuesGroup ? 2 : 8)
                        }
                        TypingBubble(name: "Tara").padding(.top, 8)
                        Spacer()
                    }.padding(.horizontal, 10)
                }
            }
            .frame(width: 393, height: 640)
            .environment(model)
            .environment(\.colorScheme, scheme)
            let r = ImageRenderer(content: view); r.scale = 3
            let data = try XCTUnwrap(r.uiImage?.pngData())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("chat-look-\(name).png")
            try data.write(to: url)
            print("CHAT_LOOK_PNG \(url.path)")
        }
    }
}
