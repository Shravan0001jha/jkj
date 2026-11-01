import XCTest
@testable import IrisWorkplace

/// The profile's Media / Files / Links (CHAT-NOTIFY-CONTRACT §3, §6.7): from the server's route,
/// or derived from the messages the app already has when the route is not there yet.
final class ChatSharedTests: XCTestCase {
    private func att(_ id: String, _ name: String, _ mime: String, kind: TalkAttachmentKind? = nil, size: Int = 10) -> TalkAttachment {
        TalkAttachment(id: id, name: name, mediaType: mime, size: size,
                       kind: kind ?? (mime.hasPrefix("image/") ? .image : mime.hasPrefix("audio/") ? .voice : .file),
                       url: "/api/talk/attachments/\(id)")
    }

    private var sources: [SharedSource] {
        [
            SharedSource(messageId: "m1", at: "2026-10-01T09:00:00.000Z", text: "First: https://github.com/irisforu/jkj/pull/412 and the spec",
                         attachments: [att("a1", "shot.png", "image/png"), att("a2", "spec.pdf", "application/pdf")]),
            SharedSource(messageId: "m2", at: "2026-10-02T09:00:00.000Z", text: "See [the plan](https://work.irisforu.com/#/plan) or https://GitHub.com/irisforu/jkj/pull/412/",
                         attachments: [att("a3", "voice.m4a", "audio/mp4"), att("a4", "clip.mov", "video/quicktime", kind: .file)]),
            SharedSource(messageId: "m3", at: "2026-10-03T09:00:00.000Z", text: "Logs attached. Docs: https://docs.example.com/a?b=1#frag.",
                         attachments: [att("a5", "build.log", "text/plain"), att("a1", "shot.png", "image/png")]),
            SharedSource(messageId: "m4", at: "2026-10-04T09:00:00.000Z", text: "mailto:me@example.com ftp://old.example.com #/item/as_1 /api/talk/attachments/a9", attachments: []),
        ]
    }

    func testMediaAreImagesAndVideosNewestFirstWithoutDuplicates() {
        let media = SharedDerivation.items(from: sources, kind: .media)
        XCTAssertEqual(media.map(\.attachmentId), ["a1", "a4"], "newest first: the image re-shared in m3, then the video; the image once")
        XCTAssertEqual(media.first?.messageId, "m3", "a re-shared file sits at its newest message")
        XCTAssertEqual(media.first?.url, "/api/talk/attachments/a1")
        XCTAssertEqual(media.first?.mime, "image/png")
        XCTAssertEqual(media.last?.messageId, "m2")
        XCTAssertEqual(media.last?.mime, "video/quicktime")
    }

    func testFilesAreDocumentsAndNeverVoice() {
        let files = SharedDerivation.items(from: sources, kind: .files)
        XCTAssertEqual(files.map(\.attachmentId), ["a5", "a2"])
        XCTAssertEqual(files.map(\.name), ["build.log", "spec.pdf"])
        XCTAssertEqual(files.first?.size, 10)
    }

    func testClassification() {
        XCTAssertEqual(SharedDerivation.classify(att("x", "a.jpg", "image/jpeg")), .media)
        XCTAssertEqual(SharedDerivation.classify(att("x", "a.bin", "application/octet-stream", kind: .image)), .media, "the server's kind wins")
        XCTAssertEqual(SharedDerivation.classify(att("x", "a.mp4", "video/mp4", kind: .file)), .media)
        XCTAssertEqual(SharedDerivation.classify(att("x", "a.pdf", "application/pdf")), .files)
        XCTAssertNil(SharedDerivation.classify(att("x", "v.m4a", "audio/mp4")), "voice notes are not files")
        XCTAssertNil(SharedDerivation.classify(att("x", "v.m4a", "application/octet-stream", kind: .voice)))
    }

    func testLinksWithTitlesHostsDeDupeAndOrder() {
        let links = SharedDerivation.items(from: sources, kind: .links)
        XCTAssertEqual(links.map(\.url), [
            "https://docs.example.com/a?b=1#frag",
            "https://work.irisforu.com/#/plan",
            "https://GitHub.com/irisforu/jkj/pull/412/",
        ], "newest first; the same PR (case, trailing slash) once, at its newest message; only http(s)")
        XCTAssertEqual(links[1].name, "the plan", "a Markdown link keeps its title")
        XCTAssertEqual(links[0].name, "docs.example.com", "otherwise the host")
        XCTAssertEqual(links[2].name, "github.com")
        XCTAssertEqual(links.map(\.messageId), ["m3", "m2", "m2"])
    }

    func testLinksKeepReadingOrderInsideAMessage() {
        let one = [SharedSource(messageId: "m", at: "2026-10-01T00:00:00.000Z", text: "a https://a.example.com then https://b.example.com", attachments: [])]
        XCTAssertEqual(SharedDerivation.items(from: one, kind: .links).map(\.url), ["https://a.example.com", "https://b.example.com"])
    }

    func testNormalisation() {
        XCTAssertEqual(SharedDerivation.normalized("HTTPS://Example.COM/Path/"), "https://example.com/Path")
        XCTAssertNotEqual(SharedDerivation.normalized("https://work.irisforu.com/#/plan"), SharedDerivation.normalized("https://work.irisforu.com/#/inbox"),
                          "hash routes are different pages")
    }

    func testSourcesFromEveryKindOfChat() throws {
        let talk = try Fixtures.decode("talk-messages-coo", as: [TalkMessage].self)
        let fromTalk = talk.map(SharedSource.init(talk:))
        XCTAssertEqual(SharedDerivation.items(from: fromTalk, kind: .links).first?.url, "https://github.com/irisforu/jkj/pull/412")
        let coo = CooMessage(id: "c1", at: "2026-10-01T00:00:00.000Z", from: .coo, text: "see https://x.example.com", attachments: [att("i", "p.png", "image/png")])
        let s = SharedSource(coo: coo)
        XCTAssertEqual(s.attachments.count, 1)
        XCTAssertEqual(SharedDerivation.items(from: [s], kind: .media).count, 1)
        let room = RoomMessage(id: "r1", threadId: "th_1", at: "2026-10-01T00:00:00.000Z", by: "dev", owner: false, text: "PR: https://github.com/x/y/pull/1", mentions: [])
        XCTAssertEqual(SharedDerivation.items(from: [SharedSource(room: room)], kind: .links).count, 1)
    }

    func testTheRoutesPageDecodes() throws {
        let json = #"{"items":[{"kind":"media","messageId":"m1","at":"2026-10-01T00:00:00.000Z","attachmentId":"a1","name":"p.png","mime":"image/png","size":5},{"kind":"links","messageId":"m2","at":"2026-10-01T00:00:00.000Z","url":"https://x.example.com","name":"X"},{"kind":"stickers","messageId":"m3","at":"2026-10-01T00:00:00.000Z"}],"next":"c2"}"#
        let page = try JSONDecoder().decode(SharedPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.next, "c2")
        XCTAssertEqual(page.items.map(\.kind), [.media, .links, .unknown], "an unknown kind never breaks the page")
        XCTAssertEqual(page.items[0].attachmentPath, "/api/talk/attachments/a1", "the attachment is served by the existing route")
        XCTAssertEqual(page.items[1].attachmentPath, nil)
        XCTAssertNotEqual(page.items[0].id, page.items[1].id)
    }

    func testPaths() {
        XCTAssertEqual(API.chatPrefs, "/api/chats/prefs")
        XCTAssertEqual(API.chatPref("th x"), "/api/chats/th%20x/prefs")
        XCTAssertEqual(API.chatShared("coo", kind: .media), "/api/chats/coo/shared?kind=media")
        XCTAssertEqual(API.chatShared("coo", kind: .links, before: "c 2"), "/api/chats/coo/shared?kind=links&before=c%202")
    }
}

/// The shared tabs' store: the route with paging, or the derived "Showing recent" list on a 404.
@MainActor
final class ChatSharedStoreTests: XCTestCase {
    private var rest: RestClient!

    override func setUp() {
        StubURLProtocol.reset()
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    func testTheRouteWithPaging() async {
        StubURLProtocol.handler = { req in
            let q = req.url!.query ?? ""
            if q.contains("before=c2") {
                return (200, Data(#"{"items":[{"kind":"files","messageId":"m0","at":"2026-09-01T00:00:00.000Z","attachmentId":"a0","name":"old.pdf"}],"next":null}"#.utf8))
            }
            return (200, Data(#"{"items":[{"kind":"files","messageId":"m1","at":"2026-10-01T00:00:00.000Z","attachmentId":"a1","name":"new.pdf"}],"next":"c2"}"#.utf8))
        }
        let s = ChatSharedStore(threadId: "asha")
        await s.load(rest, kind: .files, sources: { [] })
        XCTAssertEqual(s.state(.files).items.map(\.name), ["new.pdf"])
        XCTAssertTrue(s.state(.files).hasMore)
        XCTAssertFalse(s.state(.files).derived)
        await s.loadMore(rest, kind: .files)
        XCTAssertEqual(s.state(.files).items.map(\.name), ["new.pdf", "old.pdf"])
        XCTAssertFalse(s.state(.files).hasMore)
    }

    func testA404DerivesFromLoadedMessages() async {
        StubURLProtocol.handler = { _ in (404, Data(#"{"error":"no route"}"#.utf8)) }
        let s = ChatSharedStore(threadId: "coo")
        let src = [SharedSource(messageId: "m", at: "2026-10-01T00:00:00.000Z", text: "https://a.example.com", attachments: [])]
        await s.load(rest, kind: .links, sources: { src })
        XCTAssertTrue(s.state(.links).derived, "labelled Showing recent")
        XCTAssertEqual(s.state(.links).items.count, 1)
        XCTAssertFalse(s.state(.links).hasMore)
        XCTAssertNil(s.state(.links).error)
        await s.load(rest, kind: .media, sources: { src })
        XCTAssertTrue(s.state(.media).derived)
        XCTAssertEqual(StubURLProtocol.recorded.count, 1, "once the route is known missing, the other tabs do not ask again")
    }

    func testNoClientStillShowsTheDerivedList() async {
        let s = ChatSharedStore(threadId: "coo")
        await s.load(nil, kind: .links, sources: { [SharedSource(messageId: "m", at: "2026-10-01T00:00:00.000Z", text: "https://a.example.com", attachments: [])] })
        XCTAssertEqual(s.state(.links).items.count, 1)
        XCTAssertTrue(s.state(.links).derived)
    }

    func testAnOutageKeepsTheDerivedListAndSaysWhy() async {
        StubURLProtocol.handler = { _ in (500, Data(#"{"error":"boom"}"#.utf8)) }
        let s = ChatSharedStore(threadId: "coo")
        await s.load(rest, kind: .links, sources: { [SharedSource(messageId: "m", at: "2026-10-01T00:00:00.000Z", text: "https://a.example.com", attachments: [])] })
        XCTAssertEqual(s.state(.links).items.count, 1, "never blank")
        XCTAssertTrue(s.state(.links).derived)
        XCTAssertEqual(s.state(.links).error, "boom")
    }
}
