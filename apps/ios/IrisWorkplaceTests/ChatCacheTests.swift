import XCTest
@testable import IrisWorkplace

/// Chats open on what the phone already has (owner, 1 Nov: "like Telegram"), then refresh: each
/// chat's newest messages and the thread list live in the DiskCache under the same rules as the
/// lists (file protection, one folder per Workplace, wiped at sign-out).
@MainActor
final class ChatCacheTests: XCTestCase {
    private var dir: URL!
    private var cache: DiskCache!
    private var rest: RestClient!
    /// Lets a test hold the messages request open to look at the screen state meanwhile.
    nonisolated(unsafe) static var gate: DispatchSemaphore?

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ChatCacheTests-\(UUID().uuidString)")
        cache = DiskCache(root: dir)
        cache.setScope(ServerConfig.relay)
        StubURLProtocol.reset()
        Self.gate = nil
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/talk/threads": return (200, try! Fixtures.data("talk-threads"))
            case "/api/talk/threads/asha/messages":
                Self.gate?.wait()
                return (200, try! Fixtures.data("talk-messages-asha"))
            case "/api/coo/log": return (200, try! Fixtures.data("coo-log"))
            default: return (404, Data(#"{"error":"Not found"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    override func tearDown() {
        Self.gate = nil
        try? FileManager.default.removeItem(at: dir)
    }

    private func msg(_ id: String, _ at: String, _ text: String = "hi", thread: String = "asha") -> TalkMessage {
        TalkMessage(id: id, threadId: thread, at: at, from: thread, fromName: "Asha", direction: .out, text: text)
    }

    private func fixtureMessages() throws -> [TalkMessage] {
        try JSONDecoder().decode([TalkMessage].self, from: Fixtures.data("talk-messages-asha"))
    }

    // MARK: the cache itself

    func testMessagesRoundTripPerThreadAndKeepTheNewest200() throws {
        let many = (0..<250).map { msg(String(format: "m%03d", $0), String(format: "2026-11-01T10:%02d:%02d.000Z", $0 / 60, $0 % 60)) }
        cache.saveChat(many, threadId: "asha")
        cache.saveChat([msg("c1", "2026-11-01T09:00:00.000Z", thread: "coo")], threadId: "coo")
        let back = try XCTUnwrap(cache.loadChat(TalkMessage.self, threadId: "asha"))
        XCTAssertEqual(back.count, DiskCache.chatKeep)
        XCTAssertEqual(back.first?.id, "m050", "the oldest 50 are dropped")
        XCTAssertEqual(back.last, many.last)
        XCTAssertEqual(cache.loadChat(TalkMessage.self, threadId: "coo")?.map(\.id), ["c1"], "one file per chat")
        XCTAssertNil(cache.loadChat(TalkMessage.self, threadId: "dev"))
    }

    func testOddThreadIdsAreHashedIntoTheChatsFolder() throws {
        let id = "../../etc/passwd?x=1 " + String(repeating: "y", count: 80)
        cache.saveChat([msg("a", "2026-11-01T09:00:00.000Z", thread: id)], threadId: id)
        XCTAssertEqual(cache.loadChat(TalkMessage.self, threadId: id)?.map(\.id), ["a"])
        let chats = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent(scopeFolder()).appendingPathComponent("chats").path)
        XCTAssertEqual(chats.count, 1)
        XCTAssertTrue(chats[0].hasPrefix("h-") && !chats[0].contains("/"), chats[0])
    }

    func testAMonthOldChatIsDiscarded() {
        let saved = Date()
        cache.now = { saved }
        cache.saveChat([msg("a", "2026-10-01T09:00:00.000Z")], threadId: "asha")
        cache.now = { saved.addingTimeInterval(DiskCache.maxAge * 3) }
        XCTAssertNotNil(cache.loadChat(TalkMessage.self, threadId: "asha"), "chats outlive the lists' one day")
        cache.now = { saved.addingTimeInterval(DiskCache.chatMaxAge + 60) }
        XCTAssertNil(cache.loadChat(TalkMessage.self, threadId: "asha"))
    }

    func testChatFilesAreWrittenWithCompleteProtection() throws {
        cache.saveChat([msg("a", "2026-11-01T09:00:00.000Z")], threadId: "asha")
        let url = dir.appendingPathComponent(scopeFolder()).appendingPathComponent("chats/asha.json")
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        // The simulator reports the class it was asked for; a device enforces it.
        if let p = attrs[.protectionKey] as? FileProtectionType { XCTAssertEqual(p, .complete) }
    }

    // MARK: the store

    func testMergeDedupesByIdFreshWinsOldestFirst() {
        let cached = [msg("b", "2026-11-01T09:01:00.000Z", "old b"), msg("a", "2026-11-01T09:00:00.000Z"), msg("c", "2026-11-01T09:02:00.000Z")]
        let fresh = [msg("c", "2026-11-01T09:02:00.000Z"), msg("b", "2026-11-01T09:01:00.000Z", "new b"), msg("d", "2026-11-01T09:03:00.000Z"),
                     msg("d0", "2026-11-01T09:03:00.000Z")]
        let m = TalkThreadsStore.merge(cached, fresh)
        XCTAssertEqual(m.map(\.id), ["a", "b", "c", "d", "d0"], "one per id; by time, ties by id")
        XCTAssertEqual(m.first { $0.id == "b" }?.text, "new b", "the server's copy wins")
    }

    func testOpenWithCacheShowsMessagesWithNoSpinnerThenMergesFresh() async throws {
        let all = try fixtureMessages()
        // The phone had the first four (and one the server no longer pages back).
        let older = msg("tm_asha_0", "2026-10-04T08:00:00.000Z", "from last week")
        cache.saveChat([older] + all.prefix(4), threadId: "asha")
        cache.save(TalkThreadsStore.ListCache(threads: try JSONDecoder().decode([TalkThread].self, from: Fixtures.data("talk-threads"))), as: .talkThreads)

        let s = TalkThreadsStore()
        s.cache = cache
        s.hydrate()
        XCTAssertEqual(s.supported, true, "the cached list says this server has threads: the thread chat shows at once")
        XCTAssertTrue(s.listFromCache)
        s.hydrateMessages("asha")
        XCTAssertEqual(s.shown("asha").map(\.id), ["tm_asha_0"] + all.prefix(4).map(\.id))
        XCTAssertFalse(s.showsSpinner("asha"))

        // The fresh page is slow: still no spinner, "Updating…" instead.
        let gate = DispatchSemaphore(value: 0)
        Self.gate = gate
        let load = Task { await s.loadMessages(rest, threadId: "asha") }
        for _ in 0..<50 where !s.loadingThread.contains("asha") { await Task.yield() }
        XCTAssertTrue(s.loadingThread.contains("asha"))
        XCTAssertFalse(s.showsSpinner("asha"), "no spinner when the phone has the chat")
        XCTAssertTrue(s.isUpdating("asha"))
        XCTAssertEqual(s.shown("asha").count, 5)
        gate.signal()
        await load.value

        XCTAssertFalse(s.isUpdating("asha"))
        XCTAssertEqual(s.shown("asha").map(\.id), ["tm_asha_0"] + all.map(\.id), "fresh merged after the cached, nothing doubled")
        XCTAssertEqual(cache.loadChat(TalkMessage.self, threadId: "asha")?.map(\.id), ["tm_asha_0"] + all.map(\.id), "and written back")
    }

    func testWithoutCacheTheFirstLoadSpins() async {
        let s = TalkThreadsStore()
        s.cache = cache
        s.hydrateMessages("asha")
        XCTAssertNil(s.messages["asha"])
        let gate = DispatchSemaphore(value: 0)
        Self.gate = gate
        let load = Task { await s.loadMessages(rest, threadId: "asha") }
        for _ in 0..<50 where !s.loadingThread.contains("asha") { await Task.yield() }
        XCTAssertTrue(s.showsSpinner("asha"))
        XCTAssertFalse(s.isUpdating("asha"))
        gate.signal()
        await load.value
        XCTAssertEqual(s.messages["asha"]?.count, 6)
    }

    func testMemoryWinsOverTheCacheAcrossNavigation() async throws {
        let s = TalkThreadsStore()
        s.cache = cache
        await s.loadMessages(rest, threadId: "asha")
        cache.saveChat([msg("stale", "2026-01-01T00:00:00.000Z")], threadId: "asha")
        s.hydrateMessages("asha")   // the chat is opened again
        XCTAssertFalse(s.messages["asha"]!.contains { $0.id == "stale" }, "in-memory messages are kept, never replaced by the disk copy")
        XCTAssertEqual(s.messages["asha"]?.count, 6)
    }

    func testALiveMessageIsCached() throws {
        let s = TalkThreadsStore()
        s.cache = cache
        let t = try JSONDecoder().decode([TalkThread].self, from: Fixtures.data("talk-threads")).first { $0.id == "asha" }!
        s.handle(.talkMessage(msg("live1", "2026-11-01T09:00:00.000Z"), thread: t))
        XCTAssertEqual(cache.loadChat(TalkMessage.self, threadId: "asha")?.map(\.id), ["live1"])
    }

    func testAServerWithoutThreadsDropsTheCachedList() async throws {
        cache.save(TalkThreadsStore.ListCache(threads: try JSONDecoder().decode([TalkThread].self, from: Fixtures.data("talk-threads"))), as: .talkThreads)
        StubURLProtocol.handler = { _ in (404, Data(#"{"error":"Not found"}"#.utf8)) }
        let s = TalkThreadsStore()
        s.cache = cache
        s.hydrate()
        await s.load(rest)
        XCTAssertEqual(s.supported, false)
        XCTAssertNil(cache.load(TalkThreadsStore.ListCache.self, key: .talkThreads))
    }

    func testCooLogRoundTripsThroughTheCache() async {
        let a = CooStore()
        a.cache = cache
        await a.load(rest)
        XCTAssertFalse(a.log.isEmpty)
        let b = CooStore()
        b.cache = cache
        b.hydrate()
        XCTAssertEqual(b.log, a.log)
    }

    // MARK: the app

    /// A push's chat link puts the cached messages in memory before the chat's screen exists.
    func testOpeningAChatLinkHydratesItsCachedMessages() throws {
        let m = model()
        m.hydrateFromCache()
        cache.saveChat(Array(try fixtureMessages().prefix(3)), threadId: "asha")
        m.open(.chat("asha"))
        XCTAssertEqual(m.talkThreads.messages["asha"]?.count, 3)
        XCTAssertEqual(m.router.talkEmployeeId, "asha")
        XCTAssertEqual(m.router.tab, .talk)
    }

    func testSignOutWipesTheChatCacheAndMemory() throws {
        let m = model()
        m.hydrateFromCache()
        cache.saveChat(Array(try fixtureMessages().prefix(3)), threadId: "asha")
        cache.save(TalkThreadsStore.ListCache(threads: []), as: .talkThreads)
        cache.save([CooMessage](), as: .cooLog)
        m.open(.chat("asha"))
        XCTAssertNotNil(m.talkThreads.messages["asha"])
        m.signOut()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path), "nothing from the session stays on the phone")
        XCTAssertNil(cache.loadChat(TalkMessage.self, threadId: "asha"))
        XCTAssertNil(cache.load(TalkThreadsStore.ListCache.self, key: .talkThreads))
        XCTAssertNil(m.talkThreads.messages["asha"], "nor in memory")
        XCTAssertNil(m.talkThreads.supported)
        XCTAssertTrue(m.coo.log.isEmpty)
    }

    private func model() -> AppModel {
        AppModel(relayTokens: MemoryTokenStore(token: "s"), lanTokens: MemoryTokenStore(),
                 defaults: UserDefaults(suiteName: "ChatCacheTests-\(UUID().uuidString)")!, notifier: FakeNotifier(),
                 urlSession: StubURLProtocol.session(), makeTransport: { FakeSocketTransport() },
                 webAuth: FakeWebAuth(), env: [:], offlineProbeInterval: 0.05, pathMonitor: nil,
                 deviceAuth: FakeDeviceAuth(), cache: cache)
    }

    private func scopeFolder() -> String {
        let c = ServerConfig.relay
        let raw = "\(c.mode)-\(c.baseURL.host ?? "")-\(c.baseURL.port.map(String.init) ?? "")"
        return raw.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" }.reduce(into: "") { $0.append($1) }
    }
}
