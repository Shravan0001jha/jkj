import XCTest
@testable import IrisWorkplace

/// The mini dashboard (snapshot v1: products, trends, gaps): decoded leniently, kept on the
/// phone and shown however old it is (with its age), refreshed only in the background, and a
/// server without the endpoint yet (404) says so over the cached copy instead of blanking it.
@MainActor
final class DashboardTests: XCTestCase {
    private var dir: URL!
    private var cache: DiskCache!
    private var rest: RestClient!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("DashboardTests-\(UUID().uuidString)")
        cache = DiskCache(root: dir)
        cache.setScope(ServerConfig.relay)
        StubURLProtocol.reset()
        serve(200, try! Fixtures.data("snapshot-v1"))
        rest = RestClient(config: ServerConfig(mode: .lan, baseURL: ServerConfig.parse("127.0.0.1:4317")!),
                          tokens: MemoryTokenStore(token: "t"), session: StubURLProtocol.session())
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func serve(_ status: Int, _ body: Data) {
        StubURLProtocol.handler = { req in
            req.url!.path == "/api/metrics/snapshot" ? (status, body) : (404, Data(#"{"error":"no route"}"#.utf8))
        }
    }

    private func fixture() throws -> DashboardSnapshot { try Fixtures.decode("snapshot-v1") }

    /// The fixture with `edit` applied to its JSON object, re-encoded.
    private func edited(_ edit: (inout [String: Any]) -> Void) throws -> Data {
        var obj = try JSONSerialization.jsonObject(with: Fixtures.data("snapshot-v1")) as! [String: Any]
        edit(&obj)
        return try JSONSerialization.data(withJSONObject: obj)
    }

    // MARK: decoding

    func testDecodesTheV1Fixture() throws {
        let s = try fixture()
        XCTAssertEqual(s.version, 1)
        XCTAssertEqual(s.generatedAt, "2026-11-01T06:00:00.000Z")
        XCTAssertEqual(s.products.map(\.id), ["phone", "smarthome", "plans", "image", "voice", "character", "answers", "trust", "launch"])
        XCTAssertEqual(s.products.map(\.health), [.noDate, .onTrack, .late, .delivered, .atRisk, .onTrack, .onTrack, .onTrack, .delivered])
        let p = s.products[1]
        XCTAssertEqual(p.name, "Smart home")
        XCTAssertEqual(p.committedDate, "2026-11-20")
        XCTAssertEqual(p.forecast, DashForecast(p50: "2026-11-10", p90: "2026-11-15"))
        XCTAssertEqual(p.done, 14)
        XCTAssertEqual(p.total, 15)
        XCTAssertEqual(p.epics, ["ft_mushtk4hm47wb", "ft_mutmj5j9e2bwk", "ft_muygyikiohil0"])
        XCTAssertEqual(p.weekly.delivered, [2, 1, 2, 1, 3, 5])
        XCTAssertEqual(p.burnup.done.count, 6)
        XCTAssertEqual(p.burnup.total.last, 15)
        XCTAssertNotNil(p.startedAt)
        XCTAssertNotNil(p.ageDays)
        XCTAssertNil(s.products[0].committedDate, "no-date product")
        XCTAssertNil(s.products[4].forecast?.p50, "stalled: no forecast")

        let t = s.trends
        XCTAssertEqual(t.weeks, ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"])
        XCTAssertEqual(t.deliveredByProduct.count, 9)
        XCTAssertEqual(t.bugsByProduct.count, 9)
        XCTAssertEqual(t.bugsOpenTotal, [1, 2, 6, 9, 12, 11])
        XCTAssertEqual(t.medianHoursToDone.count, 6)
        XCTAssertEqual(t.waitByCause["review"], [1.1, 8, 19.6, 23.1, 32.1, 49.1])
        XCTAssertEqual(s.gaps?.window, "30d")
        XCTAssertEqual(s.gaps?.reviewWait?.approval1Minutes?.p50, 132.6)
        XCTAssertEqual(s.gaps?.reviewWait?.approval2Minutes?.p50, 283.3)
    }

    func testTheFixtureIsTheFullServerShape() throws {
        // Every field snapshot.ts emits is in the fixture, including the ones the app ignores.
        let obj = try XCTUnwrap(Fixtures.json("snapshot-v1") as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["version", "generatedAt", "products", "trends", "features", "gaps", "unknownShare", "notes"])
        let product = try XCTUnwrap((obj["products"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(product.keys), ["id", "name", "health", "committedDate", "forecast", "done", "total", "startedAt", "ageDays", "epics", "weekly", "burnup"])
        let trends = try XCTUnwrap(obj["trends"] as? [String: Any])
        XCTAssertEqual(Set(trends.keys), ["weeks", "deliveredByProduct", "bugsByProduct", "bugsOpenTotal", "medianHoursToDone", "waitByCause"])
    }

    func testUnknownFutureFieldsAndValuesAreIgnored() throws {
        let data = try edited { obj in
            obj["roadmap"] = ["lanes": [1, 2, 3]]                         // a new top-level field
            var products = obj["products"] as! [[String: Any]]
            products[0]["owner"] = "kabir"                                // a new product field
            products[0]["health"] = "paused"                              // a health value v1 does not know
            products[1]["weekly"] = ["delivered": [1, 2], "reverted": [0, 1]]
            products.append(["id": 42])                                   // a product the app cannot read
            obj["products"] = products
            var trends = obj["trends"] as! [String: Any]
            trends["cycleTime"] = [1, 2, 3]
            obj["trends"] = trends
            var gaps = obj["gaps"] as! [String: Any]
            gaps["mergeQueueHours"] = ["p50": 1]
            obj["gaps"] = gaps
        }
        let s = try JSONDecoder().decode(DashboardSnapshot.self, from: data)
        XCTAssertEqual(s.products.count, 9, "the unreadable product is skipped, the rest stay")
        XCTAssertEqual(s.products[0].health, .unknown)
        XCTAssertEqual(s.products[0].name, "Phone without the Mac")
        XCTAssertEqual(s.products[1].weekly.delivered, [1, 2])
        XCTAssertEqual(s.trends.weeks.count, 6)
        XCTAssertEqual(s.gaps?.reviewWait?.approval1Minutes?.p50, 132.6)
    }

    func testMissingOptionalFieldsDoNotFailDecoding() throws {
        let minimal = Data(#"{"version":1,"generatedAt":"2026-11-01T12:00:00Z","products":[{"id":"p","name":"P"}]}"#.utf8)
        let s = try JSONDecoder().decode(DashboardSnapshot.self, from: minimal)
        let p = s.products[0]
        XCTAssertNil(p.health)
        XCTAssertNil(p.committedDate)
        XCTAssertNil(p.forecast)
        XCTAssertEqual(p.done, 0)
        XCTAssertEqual(p.total, 0)
        XCTAssertEqual(p.progress, 0)
        XCTAssertEqual(p.weekly, DashWeekly())
        XCTAssertEqual(p.burnup, DashBurnup())
        XCTAssertEqual(s.trends, DashTrends())
        XCTAssertNil(s.gaps)
        XCTAssertEqual(s.productsComplete.total, 1)
        XCTAssertNil(s.deliveredThisWeek)
        XCTAssertNil(s.bugsOpen)
        XCTAssertEqual(s.waitStack, [])

        // Nulls where values are expected.
        let sparse = Data(#"{"version":1,"generatedAt":"x","products":[{"id":"p","name":"P","health":null,"forecast":{"p50":null},"burnup":{"done":[1]}}],"trends":{"weeks":["2026-10-26"],"medianHoursToDone":[null]},"gaps":{"reviewWait":{"approval1Minutes":{"p50":null}}}}"#.utf8)
        let t = try JSONDecoder().decode(DashboardSnapshot.self, from: sparse)
        XCTAssertNil(t.products[0].forecast?.p50)
        XCTAssertEqual(t.products[0].burnup.total, [])
        XCTAssertEqual(t.trends.medianHoursToDone, [nil])
        XCTAssertNil(t.gaps?.reviewWait?.approval1Minutes?.p50)
        XCTAssertEqual(DashNum.minutes(t.gaps?.reviewWait?.approval1Minutes?.p50), "—")
    }

    func testACopyWithoutProductsIsNotAV1ProductSnapshot() {
        // e.g. a copy cached by the pre-product build: discarded, not shown as an empty grid.
        let old = Data(#"{"version":1,"generatedAt":"2026-11-01T12:00:00Z","features":[{"id":"ep","name":"A"}]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(DashboardSnapshot.self, from: old))
    }

    func testDecodesARealSnapshotFromTheLiveWorkplace() throws {
        // Copied from GET /api/metrics/snapshot on the Workplace, 1 Nov (it also carries usage and release, which the app ignores).
        let snap: DashboardSnapshot = try Fixtures.decode("snapshot-v1-live")
        XCTAssertEqual(snap.products.count, 9)
        XCTAssertEqual(snap.productsComplete.done, 2)
        XCTAssertEqual(snap.productsComplete.total, 9)
        XCTAssertNotNil(snap.deliveredThisWeek)
    }

    // MARK: tiles and charts

    func testProductsCompleteCountsDelivered() throws {
        let s = try fixture()
        XCTAssertEqual(s.productsComplete.done, 2)
        XCTAssertEqual(s.productsComplete.total, 9)
        let made = DashboardSnapshot(generatedAt: "x", products: [
            DashProduct(id: "a", name: "A", health: .delivered, done: 3, total: 3),
            DashProduct(id: "b", name: "B", health: .onTrack, done: 3, total: 3),   // all done but not delivered
            DashProduct(id: "c", name: "C", health: .unknown, done: 0, total: 1),
            DashProduct(id: "d", name: "D", health: nil, done: 0, total: 1),
        ])
        XCTAssertEqual(made.productsComplete.done, 1)
        XCTAssertEqual(made.productsComplete.total, 4)
    }

    func testDeliveredThisWeekSumsEveryProductsLastWeek() throws {
        let s = try fixture()
        XCTAssertEqual(s.deliveredPerWeek, [3, 13, 18, 12, 17, 41])
        XCTAssertEqual(s.deliveredThisWeek?.value, 41)
        XCTAssertEqual(s.deliveredThisWeek?.change, 24)
        let manual = s.trends.deliveredByProduct.values.reduce(0) { $0 + $1.last! }
        XCTAssertEqual(manual, 41)

        // Ragged series are padded, a single week has no change, a drop is negative.
        let t = DashTrends(weeks: ["2026-10-19", "2026-10-26"], deliveredByProduct: ["a": [5, 2], "b": [4]])
        let made = DashboardSnapshot(generatedAt: "x", products: [], trends: t)
        XCTAssertEqual(made.deliveredPerWeek, [9, 2])
        XCTAssertEqual(made.deliveredThisWeek?.change, -7)
        let one = DashboardSnapshot(generatedAt: "x", products: [], trends: DashTrends(weeks: ["w"], deliveredByProduct: ["a": [3]]))
        XCTAssertEqual(one.deliveredThisWeek?.value, 3)
        XCTAssertNil(one.deliveredThisWeek?.change)
        XCTAssertEqual(DashNum.signed(24), "+24")
        XCTAssertEqual(DashNum.signed(-7), "−7")
    }

    func testOpenBugsIsTheLastValueWithItsDirection() throws {
        let s = try fixture()
        XCTAssertEqual(s.bugsOpen?.value, 11)
        XCTAssertEqual(s.bugsOpen?.direction, .falling)
        func dir(_ xs: [Double]) -> DashDirection? {
            DashboardSnapshot(generatedAt: "x", products: [], trends: DashTrends(bugsOpenTotal: xs)).bugsOpen?.direction
        }
        XCTAssertEqual(dir([3, 5]), .rising)
        XCTAssertEqual(dir([5, 5]), .flat)
        XCTAssertEqual(dir([7]), .flat)
        XCTAssertNil(dir([]))
    }

    func testWaitStackIsTheTopFourCausesPlusOther() throws {
        let s = try fixture()
        XCTAssertEqual(s.topWaitCauses, ["review", "unknown", "dependency", "mac-or-device"])
        XCTAssertEqual(s.waitLegend, ["review", "unknown", "dependency", "mac-or-device", "Other"])
        let stack = s.waitStack
        XCTAssertEqual(stack.count, 6 * 5)
        // Other in the last week = every cause outside the top four.
        let w = 5
        let top = Set(s.topWaitCauses)
        let otherExpected = s.trends.waitByCause.filter { !top.contains($0.key) }.values.reduce(0) { $0 + $1[w] }
        let other = try XCTUnwrap(stack.first { $0.week == w && $0.cause == "Other" })
        XCTAssertEqual(other.days, otherExpected, accuracy: 1e-9)
        XCTAssertEqual(stack.filter { $0.week == w }.reduce(0) { $0 + $1.days },
                       s.trends.waitByCause.values.reduce(0) { $0 + $1[w] }, accuracy: 1e-9, "the stack adds up to all waiting")
        XCTAssertEqual(DashboardSnapshot.waitColorsHex, ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"])

        // Four or fewer causes: no Other.
        let few = DashboardSnapshot(generatedAt: "x", products: [], trends: DashTrends(weeks: ["a", "b"], waitByCause: ["review": [1, 2], "parked": [0, 0]]))
        XCTAssertEqual(few.waitLegend, ["review"])
        XCTAssertEqual(few.waitStack.map(\.days), [1, 2])
        XCTAssertEqual(DashboardSnapshot.causeLabel("mac-or-device"), "Mac or device")
        XCTAssertEqual(DashboardSnapshot.causeLabel("something-new"), "Something new")
    }

    func testLabelsReadShort() throws {
        let s = try fixture()
        XCTAssertEqual(DashDate.short("2026-11-06"), "6 Nov")
        XCTAssertEqual(DashDate.short(nil), "—")
        XCTAssertEqual(DashDate.weekLabel(s.trends.weeks, 5), "26 Oct")
        XCTAssertEqual(DashDate.weekLabel([], 2), "W3")
        XCTAssertEqual(DashDate.forecast(s.products[1].forecast!), "10–15 Nov")
        XCTAssertEqual(DashDate.forecast(DashForecast(p50: "2026-11-30", p90: "2026-12-02")), "30 Nov – 2 Dec")
        XCTAssertEqual(DashNum.minutes(45), "45 min")
        XCTAssertEqual(DashNum.minutes(132.6), "2.2 h")
        XCTAssertEqual(DashNum.minutes(3000), "2.1 d")
        XCTAssertEqual(DashDate.days(6.5), "6.5 d")
        XCTAssertEqual(s.products[1].progress, 14.0 / 15.0, accuracy: 1e-9)
    }

    // MARK: storage

    func testCacheRoundTrip() throws {
        let s = try fixture()
        cache.save(s, as: .dashboard)
        XCTAssertEqual(cache.load(DashboardSnapshot.self, key: .dashboard), s)
    }

    func testAnOldSnapshotIsStillShown() throws {
        let s = try fixture()
        let saved = Date()
        cache.now = { saved }
        cache.save(s, as: .dashboard)
        cache.now = { saved.addingTimeInterval(10 * 86_400) }
        XCTAssertEqual(cache.load(DashboardSnapshot.self, key: .dashboard), s,
                       "the dashboard is shown with its age, never dropped for being old")
        let store = DashboardStore()
        store.cache = cache
        store.hydrate()
        XCTAssertEqual(store.snapshot, s)
        XCTAssertTrue(store.fromCache)
        // Its age is on screen, and it reads as stale.
        let generated = try XCTUnwrap(Format.date(s.generatedAt))
        store.now = { generated.addingTimeInterval(3 * 3600 + 30) }
        XCTAssertEqual(store.updatedText, "Updated 3 h ago")
        XCTAssertTrue(DashboardStore.isStale(s.generatedAt, now: store.now()))
    }

    func testStaleUpdatedText() {
        let gen = "2026-11-01T12:00:00Z"
        let t0 = Format.date(gen)!
        XCTAssertEqual(DashboardStore.updatedText(gen, now: t0.addingTimeInterval(20)), "Updated just now")
        XCTAssertEqual(DashboardStore.updatedText(gen, now: t0.addingTimeInterval(12 * 60)), "Updated 12 min ago")
        XCTAssertEqual(DashboardStore.updatedText(gen, now: t0.addingTimeInterval(3 * 3600 + 120)), "Updated 3 h ago")
        XCTAssertEqual(DashboardStore.updatedText(gen, now: t0.addingTimeInterval(2 * 86_400 + 60)), "Updated 2 d ago")
        XCTAssertEqual(DashboardStore.updatedText("garbage", now: t0), "Updated time unknown")
        XCTAssertFalse(DashboardStore.isStale(gen, now: t0.addingTimeInterval(90 * 60)))
        XCTAssertTrue(DashboardStore.isStale(gen, now: t0.addingTimeInterval(3 * 3600)), "hourly snapshots: older than 2 h reads as stale")
    }

    // MARK: refresh

    func testLoadReplacesTheCachedCopyAndKeepsTheFreshOne() async throws {
        var old = try fixture()
        old.products = Array(old.products.prefix(1))
        cache.save(old, as: .dashboard)
        let store = DashboardStore()
        store.cache = cache
        store.hydrate()
        XCTAssertEqual(store.snapshot?.products.count, 1)
        await store.load(rest)
        XCTAssertEqual(store.snapshot?.products.count, 9)
        XCTAssertFalse(store.fromCache)
        XCTAssertEqual(store.availability, .available)
        XCTAssertEqual(cache.load(DashboardSnapshot.self, key: .dashboard)?.products.count, 9)
        XCTAssertEqual(StubURLProtocol.recorded.last?.request.value(forHTTPHeaderField: "Authorization"), "Bearer t",
                       "the existing bearer, through the same client")
    }

    func testNotFoundShowsNotAvailableAndKeepsTheCachedSnapshot() async throws {
        let s = try fixture()
        cache.save(s, as: .dashboard)
        serve(404, Data(#"{"error":"not found"}"#.utf8))
        let store = DashboardStore()
        store.cache = cache
        store.hydrate()
        await store.load(rest)
        XCTAssertEqual(store.availability, .notYet)
        XCTAssertEqual(store.snapshot, s, "the cached copy stays on screen")
        XCTAssertNil(store.error, "404 is a state, not an error banner")
        XCTAssertEqual(cache.load(DashboardSnapshot.self, key: .dashboard), s, "and stays on the phone")

        // With nothing cached, the same 404 is still a state, never a crash or a blank.
        let empty = DashboardStore()
        await empty.load(rest)
        XCTAssertEqual(empty.availability, .notYet)
        XCTAssertNil(empty.snapshot)
    }

    func testOtherFailuresKeepTheCachedSnapshot() async throws {
        let s = try fixture()
        cache.save(s, as: .dashboard)
        let store = DashboardStore()
        store.cache = cache
        store.hydrate()
        for (status, body) in [(503, #"{"error":"Mac offline"}"#), (500, #"{"error":"boom"}"#), (200, #"{"version":"#)] {
            serve(status, Data(body.utf8))
            await store.load(rest)
            XCTAssertEqual(store.snapshot, s, "HTTP \(status) keeps the cached copy")
            XCTAssertNotNil(store.error)
        }
        XCTAssertEqual(cache.load(DashboardSnapshot.self, key: .dashboard), s)
        serve(200, try Fixtures.data("snapshot-v1"))
        await store.load(rest)
        XCTAssertNil(store.error, "a good load clears the error")
    }

    func testRefreshIsThrottledButLoadIsNot() async throws {
        let store = DashboardStore()
        var clock = Date()
        store.now = { clock }
        await store.refresh(rest)
        await store.refresh(rest)
        XCTAssertEqual(StubURLProtocol.recorded.count, 1, "launch + foreground in the same minute fetch once")
        clock = clock.addingTimeInterval(DashboardStore.minInterval + 1)
        await store.refresh(rest)
        XCTAssertEqual(StubURLProtocol.recorded.count, 2)
        await store.load(rest)
        XCTAssertEqual(StubURLProtocol.recorded.count, 3)
    }

    // MARK: wiring

    func testAppModelWiresTheDashboardAndRefreshesItAfterConnect() async throws {
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/health": return (200, try! Fixtures.data("health"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            case "/api/metrics/snapshot": return (200, try! Fixtures.data("snapshot-v1"))
            default: return (404, Data(#"{"error":"no route"}"#.utf8))
            }
        }
        let snap = try fixture()
        cache.save(snap, as: .dashboard)
        let defaults = UserDefaults(suiteName: "DashboardTests")!
        defaults.removePersistentDomain(forName: "DashboardTests")
        let m = AppModel(relayTokens: MemoryTokenStore(token: "s"), lanTokens: MemoryTokenStore(),
                         defaults: defaults, notifier: FakeNotifier(),
                         urlSession: StubURLProtocol.session(), makeTransport: { FakeSocketTransport() },
                         webAuth: FakeWebAuth(), env: [:], offlineProbeInterval: 0.05, pathMonitor: nil,
                         deviceAuth: FakeDeviceAuth(), cache: cache)
        XCTAssertTrue(m.dashboard.cache === cache)
        m.start()
        XCTAssertEqual(m.dashboard.snapshot, snap, "shown at once from the phone")
        let fetched = await eventually { m.dashboard.availability == .available }
        XCTAssertTrue(fetched, "refreshed on launch")
        XCTAssertFalse(m.dashboard.fromCache)
    }

    func testBackgroundRefreshIsDeclared() {
        let info = Bundle.main.infoDictionary ?? [:]
        let ids = info["BGTaskSchedulerPermittedIdentifiers"] as? [String] ?? []
        XCTAssertTrue(ids.contains(DashboardRefresh.identifier))
        XCTAssertEqual(DashboardRefresh.identifier, "com.irisforu.workplace.dashboard-refresh")
        let modes = info["UIBackgroundModes"] as? [String] ?? []
        XCTAssertTrue(modes.contains("fetch"), "BGAppRefreshTask needs the fetch background mode")
    }

    func testTheTabBarStaysAtFiveWithUpdatesUnderTheDashboard() {
        XCTAssertLessThanOrEqual(Tab.bar.count, 5, "a sixth tab would push two tabs behind iOS's More")
        XCTAssertTrue(Tab.bar.contains(.dashboard))
        let r = Router()
        r.tab = .updates                       // a deep link to Updates
        XCTAssertEqual(r.barSelection, .dashboard, "the Dashboard tab is the one highlighted")
        r.barSelection = .plan
        XCTAssertEqual(r.tab, .plan)
        r.barSelection = .dashboard            // tapping the tab again
        XCTAssertEqual(r.tab, .updates, "comes back to the pane last shown")
        r.tab = .dashboard
        r.barSelection = .inbox
        r.barSelection = .dashboard
        XCTAssertEqual(r.tab, .dashboard)
    }

    #if DEBUG
    func testPreviewDataIsTheV1Fixture() throws {
        XCTAssertEqual(DashboardSnapshot.preview, try fixture(), "previews show exactly what the app reads from the fixture")
    }
    #endif
}
