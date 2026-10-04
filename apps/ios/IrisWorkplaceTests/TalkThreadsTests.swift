import XCTest
@testable import IrisWorkplace

/// Talk threads (LLD-app-fixes): the real sender, receipts, typing only from `talk.typing`,
/// replies, files and voice, and a 404 that keeps today's chat.
@MainActor
final class TalkThreadsTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/talk/threads": return (200, try! Fixtures.data("talk-threads"))
            case "/api/talk/threads/asha/messages":
                if req.httpMethod == "POST" {
                    let m = try! JSONSerialization.jsonObject(with: Fixtures.data("talk-messages-asha")) as! [[String: Any]]
                    var echo = m[0]; echo["id"] = "tm_new"; echo["receipt"] = "delivered"
                    return (201, try! JSONSerialization.data(withJSONObject: ["message": echo]))
                }
                return (200, try! Fixtures.data("talk-messages-asha"))
            case "/api/talk/threads/asha/attachments": return (201, Data(#"{"id":"att_up1","name":"a.pdf","mediaType":"application/pdf","size":3,"kind":"file","url":"/api/talk/attachments/att_up1"}"#.utf8))
            case "/api/talk/threads/asha/read": return (200, try! JSONSerialization.data(withJSONObject: (try! JSONSerialization.jsonObject(with: Fixtures.data("talk-threads")) as! [[String: Any]])[1].merging(["unreadCount": 0]) { $1 }))
            case "/api/mentionable": return (200, try! Fixtures.data("mentionable"))
            default: return (404, Data(#"{"error":"Not found"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    func testThreadsLoadWithUnreadPinsTypingAndMentionable() async {
        let s = TalkThreadsStore()
        await s.load(rest)
        XCTAssertEqual(s.supported, true)
        XCTAssertEqual(s.threads["asha"]?.unreadCount, 2)
        XCTAssertEqual(s.typing, ["asha"], "typing comes from the thread's own state")
        XCTAssertEqual(s.mentionable?.map(\.id), ["asha", "coo", "dev"])
        XCTAssertEqual(s.ordered(["dev", "asha", "coo"]), ["coo", "asha", "dev"], "pinned, then unread, then recent")
    }

    func testAnOlderServerWithoutThreadsKeepsTheOldChat() async {
        StubURLProtocol.handler = { _ in (404, Data(#"{"error":"no route"}"#.utf8)) }
        let s = TalkThreadsStore()
        await s.load(rest)
        XCTAssertEqual(s.supported, false)
        XCTAssertNil(s.error, "a missing route is not an error on screen")
    }

    func testTheRealSenderOnEveryBubble() async throws {
        let msgs = try Fixtures.decode("talk-messages-asha", as: [TalkMessage].self)
        let items = ChatItem.from(talk: msgs, threadId: "asha")
        XCTAssertEqual(items[0].mine, true, "the owner's own")
        XCTAssertEqual(items[0].receipt, .read)
        XCTAssertEqual(items[1].mine, false, "the COO's message is never the owner's")
        XCTAssertEqual(items[1].sender, "Claude — COO")
        XCTAssertNil(items[2].sender, "the counterpart of a 1:1 is not named")
        XCTAssertEqual(items[2].replyTo?.sender, "You")
        let voice = items[4]
        XCTAssertEqual(voice.text, "", "the transcript shows under the player, not twice")
        XCTAssertEqual(voice.attachments.first?.kind, .voice)
        XCTAssertEqual(voice.attachments.first?.transcript, "Send me the evidence pack when it is ready, please.")
        XCTAssertEqual(voice.receipt, .sent, "delivered reads as sent")
        XCTAssertEqual(items[5].attachments.map(\.kind), [.image, .file])
    }

    func testAnOldLogEntryFromTheCooIsNotTheOwners() {
        var e = LogEntry(id: "l1", agentId: "a", at: "2026-10-04T09:00:00.000Z", kind: .user, label: "", text: "Do this", from: .unknown)
        e.fromName = "Claude — COO"
        let item = ChatItem.from(log: [e])[0]
        XCTAssertEqual(item.mine, false)
        XCTAssertEqual(item.sender, "Claude — COO")
        let owner = LogEntry(id: "l2", agentId: "a", at: "2026-10-04T09:00:00.000Z", kind: .user, label: "", text: "Mine")
        XCTAssertEqual(ChatItem.from(log: [owner])[0].mine, true, "no sender recorded: an old entry, the owner's")
    }

    func testCooMessagesCarryTheirFiles() throws {
        let json = #"[{"id":"c1","at":"2026-10-04T10:00:00.000Z","from":"coo","text":"Report attached","attachments":[{"id":"att_r","name":"report.pdf","mediaType":"application/pdf","size":10,"kind":"file","url":"/api/talk/attachments/att_r"}]}]"#
        let log = try JSONDecoder().decode([CooMessage].self, from: Data(json.utf8))
        let item = ChatItem.from(coo: log)[0]
        XCTAssertEqual(item.attachments.map(\.name), ["report.pdf"])
        XCTAssertEqual(item.attachments.first?.path, "/api/talk/attachments/att_r")
    }

    func testTypingOnlyFromTalkTyping() async {
        let s = TalkThreadsStore()
        await s.load(rest)
        s.handle(.talkTyping(threadId: "asha", employeeId: "asha", typing: false))
        XCTAssertFalse(s.typing.contains("asha"))
        s.handle(.talkTyping(threadId: "dev", employeeId: "dev", typing: true))
        XCTAssertTrue(s.typing.contains("dev"))
    }

    func testAReceiptChangeUpdatesTheSameMessage() async throws {
        let s = TalkThreadsStore()
        await s.loadMessages(rest, threadId: "asha")
        var m = s.messages["asha"]![4]
        XCTAssertEqual(m.receipt, .delivered)
        m.receipt = .read
        let t = try Fixtures.decode("talk-threads", as: [TalkThread].self)[1]
        s.handle(.talkMessage(m, thread: t))
        XCTAssertEqual(s.messages["asha"]!.count, 6, "upserted, not appended")
        XCTAssertEqual(s.messages["asha"]![4].receipt, .read)
    }

    func testSendUploadsFilesThenReferencesThemWithTheReplyAndMentions() async throws {
        let s = TalkThreadsStore()
        await s.loadMessages(rest, threadId: "asha")
        let reply = s.messages["asha"]![2]
        _ = try await s.send(rest, threadId: "asha", text: "Thanks @dev", replyTo: reply, mentions: ["dev"],
                             files: [OutgoingAttachment(name: "a.pdf", mediaType: "application/pdf", data: Data("pdf".utf8))])
        let upload = StubURLProtocol.recorded.first { $0.request.url!.path.hasSuffix("/attachments") }!
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "content-type"), "application/pdf")
        XCTAssertEqual(upload.request.url!.query, "name=a.pdf")
        let post = StubURLProtocol.recorded.last { $0.request.url!.path.hasSuffix("/messages") && $0.request.httpMethod == "POST" }!
        let body = try JSONSerialization.jsonObject(with: post.body!) as! [String: Any]
        XCTAssertEqual(body["replyTo"] as? String, reply.id)
        XCTAssertEqual(body["mentions"] as? [String], ["dev"])
        XCTAssertEqual(body["attachmentIds"] as? [String], ["att_up1"])
        XCTAssertTrue(s.messages["asha"]!.contains { $0.id == "tm_new" })
        XCTAssertTrue(s.outgoing["asha"]?.isEmpty ?? true, "the local copy goes once the server's lands")
    }
}

/// Long messages fold with a clear control; links are found; mentions add up.
final class MessageTextTests: XCTestCase {
    func testLongMessagesFoldAndDetailsThatRepeatTheTextReplaceIt() {
        XCTAssertFalse(MessageBody(text: "Short", details: nil).isLong)
        XCTAssertTrue(MessageBody(text: String(repeating: "word ", count: 200), details: nil).isLong)
        XCTAssertTrue(MessageBody(text: (1...12).map(String.init).joined(separator: "\n"), details: nil).isLong)
        let cut = MessageBody(text: "The build failed on…", details: "The build failed on the relay step because the cert expired.")
        XCTAssertEqual(cut.full, "The build failed on the relay step because the cert expired.", "a summary's full text replaces it")
        let extra = MessageBody(text: "Done.", details: "Ran 40 tests.")
        XCTAssertEqual(extra.full, "Done.\n\nRan 40 tests.", "extra context follows")
        XCTAssertEqual(MessageBody(text: "Cut", details: "Something else entirely", detailsIsFull: true).full, "Something else entirely")
    }

    func testLinksMarkdownAndBare() {
        let urls = MessageLinks.webURLs(in: "See [the PR](https://github.com/a/b/pull/1) and https://work.irisforu.com/#/plan.")
        XCTAssertEqual(urls.map(\.absoluteString), ["https://github.com/a/b/pull/1", "https://work.irisforu.com/#/plan"])
        let a = MessageLinks.detect(AttributedString("open https://example.com now"))
        XCTAssertTrue(a.runs.contains { $0.link?.absoluteString == "https://example.com" })
        XCTAssertEqual(MessageMenu.plain("See [the PR](https://x.y/1) **now**"), "See the PR (https://x.y/1) now")
    }

    func testSeveralMentions() {
        var d = Mentions.pick("asha", into: "Hi @as")
        XCTAssertEqual(d, "Hi @asha ")
        d = Mentions.add(["dev", "coo", "asha"], to: d)
        XCTAssertEqual(RoomStore.mentions(in: d, known: ["asha", "dev", "coo"]), ["asha", "dev", "coo"])
        d = Mentions.remove(["dev"], from: d)
        XCTAssertEqual(RoomStore.mentions(in: d, known: ["asha", "dev", "coo"]), ["asha", "coo"])
        XCTAssertNil(Mentions.query(in: "mail me at a@b"), "an email is not a mention")
        XCTAssertEqual(Mentions.candidates("c", known: ["coo", "asha"]) { $0 == "coo" ? "Claude — COO" : "Asha" }, ["coo"])
    }
}
