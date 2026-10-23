import XCTest
@testable import IrisWorkplace

/// The phone's copy of the main lists (owner, 23 Oct): shown at once, refreshed behind the scenes,
/// never shown when too old or from another layout, and gone after sign-out.
@MainActor
final class DiskCacheTests: XCTestCase {
    private var dir: URL!
    private var cache: DiskCache!
    private var rest: RestClient!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("DiskCacheTests-\(UUID().uuidString)")
        cache = DiskCache(root: dir)
        cache.setScope(ServerConfig.relay)
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/plan": return (200, try! Fixtures.data("live-plan"))
            case "/api/rooms": return (200, try! Fixtures.data("live-rooms"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            default: return (404, Data(#"{"error":"no route"}"#.utf8))
            }
        }
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
    }

    func testRoundTrip() throws {
        let rooms = try JSONDecoder().decode([Room].self, from: Fixtures.data("live-rooms"))
        cache.save(rooms, as: .rooms)
        XCTAssertEqual(cache.load([Room].self, key: .rooms), rooms)
    }

    func testTooOldIsDiscardedNotShown() throws {
        let rooms = try JSONDecoder().decode([Room].self, from: Fixtures.data("live-rooms"))
        let saved = Date()
        cache.now = { saved }
        cache.save(rooms, as: .rooms)
        cache.now = { saved.addingTimeInterval(DiskCache.maxAge + 60) }
        XCTAssertNil(cache.load([Room].self, key: .rooms), "a day-old list is not shown as if current")
        cache.now = { saved }
        XCTAssertNil(cache.load([Room].self, key: .rooms), "and it was deleted, not just skipped")
    }

    func testAnotherLayoutIsDiscarded() throws {
        // A file written by an older build: a different schema number in the envelope.
        let url = dir.appendingPathComponent(scopeFolder()).appendingPathComponent("rooms.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let rooms = try JSONSerialization.jsonObject(with: Fixtures.data("live-rooms"))
        let env: [String: Any] = ["schema": DiskCache.schema + 1, "savedAt": Date().timeIntervalSinceReferenceDate, "value": rooms]
        try JSONSerialization.data(withJSONObject: env).write(to: url)
        XCTAssertNil(cache.load([Room].self, key: .rooms))
    }

    func testEachWorkplaceHasItsOwnCopy() throws {
        let rooms = try JSONDecoder().decode([Room].self, from: Fixtures.data("live-rooms"))
        cache.save(rooms, as: .rooms)
        cache.setScope(ServerConfig(mode: .lan, baseURL: ServerConfig.parse("192.168.1.5:4317")!))
        XCTAssertNil(cache.load([Room].self, key: .rooms), "a LAN pairing never shows the relay's copy")
    }

    func testStoreShowsTheCachedCopyThenTheFreshOne() async throws {
        let all = try JSONDecoder().decode([Room].self, from: Fixtures.data("live-rooms"))
        cache.save(Array(all.prefix(1)), as: .rooms)        // an older, shorter list on the phone
        let s = RoomsStore()
        s.cache = cache
        s.hydrate()
        XCTAssertEqual(s.rooms.count, 1, "shown at once from the phone")
        XCTAssertTrue(s.fromCache)
        XCTAssertFalse(s.loaded, "not marked loaded: screens still fetch")
        await s.load(rest)
        XCTAssertEqual(s.rooms.count, all.count, "the fresh list replaces it")
        XCTAssertFalse(s.fromCache)
        XCTAssertEqual(cache.load([Room].self, key: .rooms)?.count, all.count, "and the fresh list is what is kept")
    }

    func testPlanAndInboxAndOfficeHydrateAndRefresh() async {
        let plan = PlanStore(), inbox = InboxStore(), office = OfficeStore()
        for s in [plan.cache, inbox.cache, office.cache] { XCTAssertNil(s) }
        plan.cache = cache; inbox.cache = cache; office.cache = cache
        await plan.load(rest); await inbox.load(rest); await office.load(rest)
        let p2 = PlanStore(), i2 = InboxStore(), o2 = OfficeStore()
        p2.cache = cache; i2.cache = cache; o2.cache = cache
        p2.hydrate(); i2.hydrate(); o2.hydrate()
        XCTAssertEqual(p2.plan, plan.plan)
        XCTAssertEqual(i2.items, inbox.items)
        XCTAssertEqual(o2.data, office.data)
        XCTAssertTrue(p2.fromCache && i2.fromCache && o2.fromCache)
        XCTAssertFalse(i2.loaded, "Inbox housekeeping never runs on a cached list")
    }

    func testHydrateNeverOverwritesFreshData() async throws {
        let all = try JSONDecoder().decode([Room].self, from: Fixtures.data("live-rooms"))
        let s = RoomsStore()
        s.cache = cache
        await s.load(rest)
        cache.save(Array(all.prefix(1)), as: .rooms)
        s.hydrate()
        XCTAssertEqual(s.rooms.count, all.count)
    }

    func testSignOutDeletesEverything() throws {
        let rooms = try JSONDecoder().decode([Room].self, from: Fixtures.data("live-rooms"))
        cache.save(rooms, as: .rooms)
        let m = AppModel(relayTokens: MemoryTokenStore(token: "s"), lanTokens: MemoryTokenStore(),
                         defaults: UserDefaults(suiteName: "DiskCacheTests")!, notifier: FakeNotifier(),
                         urlSession: StubURLProtocol.session(), makeTransport: { FakeSocketTransport() },
                         webAuth: FakeWebAuth(), env: [:], offlineProbeInterval: 0.05, pathMonitor: nil,
                         deviceAuth: FakeDeviceAuth(), cache: cache)
        XCTAssertTrue(m.rooms.cache === cache && m.plan.cache === cache, "the app wires one cache into the list stores")
        m.signOut()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path), "nothing from the session stays on the phone")
        XCTAssertNil(cache.load([Room].self, key: .rooms))
    }

    private func scopeFolder() -> String {
        // Same rule as DiskCache.setScope(ServerConfig.relay).
        let c = ServerConfig.relay
        let raw = "\(c.mode)-\(c.baseURL.host ?? "")-\(c.baseURL.port.map(String.init) ?? "")"
        return raw.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" }.reduce(into: "") { $0.append($1) }
    }
}
