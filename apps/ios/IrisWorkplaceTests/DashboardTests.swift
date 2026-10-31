import XCTest
@testable import IrisWorkplace

/// The mini dashboard (docs/HLD-dashboard.md §5, snapshot v1): decoded leniently, kept on the
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
        serve(200, try! Fixtures.data("dashboard-snapshot"))
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

    private func fixture() throws -> DashboardSnapshot { try Fixtures.decode("dashboard-snapshot") }

    /// The fixture with `edit` applied to its JSON object, re-encoded.
    private func edited(_ edit: (inout [String: Any]) -> Void) throws -> Data {
        var obj = try JSONSerialization.jsonObject(with: Fixtures.data("dashboard-snapshot")) as! [String: Any]
        edit(&obj)
        return try JSONSerialization.data(withJSONObject: obj)
    }

    // MARK: decoding

    func testDecodesTheV1Fixture() throws {
        let s = try fixture()
        XCTAssertEqual(s.version, 1)
        XCTAssertEqual(s.generatedAt, "2026-11-01T12:00:00Z")
        XCTAssertEqual(s.features.count, 5)
        let f = s.features[0]
        XCTAssertEqual(f.id, "ep_alarms")
        XCTAssertEqual(f.name, "Alarms & Reminders")
        XCTAssertEqual(f.state, .inProgress)
        XCTAssertEqual(f.committedDate, "2026-11-06")
        XCTAssertEqual(f.forecast?.p50, "2026-11-06")
        XCTAssertEqual(f.forecast?.p90, "2026-11-08")
        XCTAssertEqual(f.health, .atRisk)
        XCTAssertEqual(f.healthReason, "waiting on Mac build, 1.5 d")
        XCTAssertNil(f.deliveredAt)
        XCTAssertEqual(f.originalDate, "2026-10-31")
        XCTAssertEqual(f.scope.map(\.status), [.merged, .building, .verified, .notStarted])
        XCTAssertEqual(f.scope[0].storyIds, ["st_rep1", "st_rep2"])
        XCTAssertEqual(f.dateHistory.count, 1)
        XCTAssertEqual(f.dateHistory[0].approvedBy, "owner")
        XCTAssertEqual(f.lostDays?["mac-or-device"], 1.5)
        XCTAssertEqual(f.escapes, 1)
        XCTAssertEqual(f.costInr, 4120)
        XCTAssertEqual(s.features.map(\.health), [.atRisk, .onTrack, .late, .onTrack, .onTrack])
        XCTAssertEqual(s.features.map(\.state), [.inProgress, .inProgress, .inProgress, .delivered, .planned])
        XCTAssertEqual(s.features[3].deliveredAt, "2026-10-21T15:10:00Z")
        XCTAssertNil(s.features[4].startedAt)

        let g = try XCTUnwrap(s.gaps)
        XCTAssertEqual(g.window, "30d")
        XCTAssertEqual(g.lostDaysByCause.count, 5)
        XCTAssertEqual(g.lostDaysByCause[1].cause, "review")
        XCTAssertEqual(g.lostDaysByCause[1].days, 6.5)
        XCTAssertEqual(g.lostDaysByCause[1].trend, [0.9, 1.4])
        XCTAssertEqual(g.idleWhileQueuedHours, 41)
        XCTAssertEqual(g.reviewWaitHours?.p90, 12)
        XCTAssertEqual(g.stagingSlots?.planned, 10)
        XCTAssertEqual(g.stagingSlots?.misses.count, 2)
        XCTAssertEqual(g.forecastAccuracyDays.map(\.delta), [-1, 6])
        XCTAssertEqual(g.ownerDecisionHours?.p50, 2)
        XCTAssertEqual(s.unknownShare, 0.04)
    }

    func testUnknownFutureFieldsAndValuesAreIgnored() throws {
        let data = try edited { obj in
            obj["roadmap"] = ["lanes": [1, 2, 3]]                       // a new top-level field
            var features = obj["features"] as! [[String: Any]]
            features[0]["owner"] = "kabir"                               // a new feature field
            features[0]["health"] = "blocked"                            // a health value v1 does not know
            features[0]["state"] = "paused"
            var scope = features[0]["scope"] as! [[String: Any]]
            scope[0]["status"] = "rolled-back"
            scope[0]["evidence"] = ["url": "x"]
            features[0]["scope"] = scope
            obj["features"] = features
            var gaps = obj["gaps"] as! [String: Any]
            gaps["mergeQueueHours"] = ["p50": 1]
            obj["gaps"] = gaps
        }
        let s = try JSONDecoder().decode(DashboardSnapshot.self, from: data)
        XCTAssertEqual(s.features.count, 5)
        XCTAssertEqual(s.features[0].health, .unknown)
        XCTAssertEqual(s.features[0].state, .unknown)
        XCTAssertEqual(s.features[0].scope[0].status, .unknown)
        XCTAssertEqual(s.features[0].name, "Alarms & Reminders")
        XCTAssertEqual(s.gaps?.lostDaysByCause.count, 5)
    }

    func testMissingOptionalFieldsDoNotFailDecoding() throws {
        let minimal = Data(#"{"version":1,"generatedAt":"2026-11-01T12:00:00Z","features":[{"id":"ep_a","name":"A"}]}"#.utf8)
        let s = try JSONDecoder().decode(DashboardSnapshot.self, from: minimal)
        XCTAssertEqual(s.features.count, 1)
        let f = s.features[0]
        XCTAssertNil(f.health)
        XCTAssertNil(f.state)
        XCTAssertNil(f.committedDate)
        XCTAssertNil(f.forecast)
        XCTAssertEqual(f.scope, [])
        XCTAssertEqual(f.dateHistory, [])
        XCTAssertNil(s.gaps)
        XCTAssertNil(s.unknownShare)

        // Nulls where values are expected, empty gaps, no features at all.
        let sparse = Data(#"{"version":1,"generatedAt":"2026-11-01T12:00:00Z","gaps":{"lostDaysByCause":[{"cause":"review","days":1}]},"features":[{"id":"ep_b","name":"B","forecast":{"p50":null},"scope":[{"label":"x"}],"dateHistory":[{"to":"2026-11-02"}],"health":null}]}"#.utf8)
        let t = try JSONDecoder().decode(DashboardSnapshot.self, from: sparse)
        XCTAssertNil(t.features[0].forecast?.p50)
        XCTAssertNil(t.features[0].scope[0].status)
        XCTAssertEqual(t.features[0].scope[0].storyIds, [])
        XCTAssertEqual(t.features[0].dateHistory[0].to, "2026-11-02")
        XCTAssertEqual(t.gaps?.lostDaysByCause[0].trend, [])
        XCTAssertEqual(t.gaps?.forecastAccuracyDays, [])
        let none = try JSONDecoder().decode(DashboardSnapshot.self, from: Data(#"{"version":1,"generatedAt":"x"}"#.utf8))
        XCTAssertEqual(none.features, [])
    }

    func testTopGapsAreTheThreeLargestCauses() throws {
        let s = try fixture()
        XCTAssertEqual(s.topGaps.map(\.cause), ["review", "mac-or-device", "owner-decision"])
        XCTAssertEqual(DashboardSnapshot.causeLabel("mac-or-device"), "Mac or device")
        XCTAssertEqual(DashboardSnapshot.causeLabel("queued-behind-busy"), "Queued behind busy")
        XCTAssertEqual(DashboardSnapshot.causeLabel("something-new"), "Something new")
    }

    func testDatesReadAsShortDays() throws {
        let f = try fixture().features
        XCTAssertEqual(DashDate.short("2026-11-06"), "6 Nov")
        XCTAssertEqual(DashDate.forecast(f[0].forecast!), "6–8 Nov")
        XCTAssertEqual(DashDate.forecast(DashForecast(p50: "2026-11-30", p90: "2026-12-02")), "30 Nov – 2 Dec")
        XCTAssertEqual(DashDate.forecast(DashForecast(p50: "2026-11-06", p90: "2026-11-06")), "6 Nov")
        XCTAssertEqual(DashDate.datesLine(f[0]), "Due 6 Nov · forecast 6–8 Nov")
        XCTAssertEqual(DashDate.datesLine(f[3]), "Delivered 21 Oct")
        XCTAssertEqual(DashDate.days(6.5), "6.5 d")
        XCTAssertEqual(DashDate.days(2), "2 d")
        XCTAssertEqual(DashboardContent.groups(f).map(\.title), ["In progress", "Planned", "Delivered"])
        XCTAssertEqual(DashboardContent.groups(f)[0].features.map(\.id), ["ep_store", "ep_alarms", "ep_wake"], "late, then at risk, then on track")
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
        old.features = Array(old.features.prefix(1))
        cache.save(old, as: .dashboard)
        let store = DashboardStore()
        store.cache = cache
        store.hydrate()
        XCTAssertEqual(store.snapshot?.features.count, 1)
        await store.load(rest)
        XCTAssertEqual(store.snapshot?.features.count, 5)
        XCTAssertFalse(store.fromCache)
        XCTAssertEqual(store.availability, .available)
        XCTAssertEqual(cache.load(DashboardSnapshot.self, key: .dashboard)?.features.count, 5)
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
        serve(200, try Fixtures.data("dashboard-snapshot"))
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
            case "/api/metrics/snapshot": return (200, try! Fixtures.data("dashboard-snapshot"))
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
        XCTAssertEqual(DashboardSnapshot.preview, try fixture(), "previews show exactly the contract fixture")
    }
    #endif
}
