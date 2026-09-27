import XCTest
@testable import IrisWorkplace

@MainActor
final class AppModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var transports: [FakeSocketTransport] = []

    override func setUp() {
        StubURLProtocol.reset()
        defaults = UserDefaults(suiteName: "AppModelTests")!
        defaults.removePersistentDomain(forName: "AppModelTests")
        transports = []
    }

    private func model(tokens: MemoryTokenStore = MemoryTokenStore(), env: [String: String] = [:]) -> AppModel {
        AppModel(tokens: tokens, defaults: defaults, notifier: FakeNotifier(), urlSession: StubURLProtocol.session(),
                 makeTransport: { [unowned self] in
                     let t = FakeSocketTransport(); self.transports.append(t); return t
                 }, env: env)
    }

    private func serveFixtures() {
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/health": return (200, try! Fixtures.data("health"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            case "/api/pair/exchange": return (200, try! Fixtures.data("pair-exchange"))
            default: return (404, Data(#"{"error":"no route"}"#.utf8))
            }
        }
    }

    func testUnpairedUntilBothURLAndTokenExist() {
        let m = model()
        m.start()
        XCTAssertEqual(m.connection, .unpaired)
        XCTAssertFalse(m.isPaired)
    }

    func testPairStoresTheTokenAndConnects() async throws {
        serveFixtures()
        let tokens = MemoryTokenStore()
        let m = model(tokens: tokens)
        try await m.pair(urlText: "192.168.1.5:4317", code: " 482913 ")
        XCTAssertEqual(tokens.token, "mock-token-0123456789abcdef")
        XCTAssertEqual(defaults.string(forKey: ServerConfig.defaultsKey), "http://192.168.1.5:4317")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        await expectEventually { self.transports.count == 1 }
        XCTAssertEqual(transports[0].url?.absoluteString, "ws://192.168.1.5:4317/ws?token=mock-token-0123456789abcdef")
        await expectEventually { m.office.data != nil && m.inbox.loaded }
        XCTAssertEqual(m.health?.workplace.capInr, 1000)
        XCTAssertEqual(m.office.data?.needsYou, 5)
        let auth = StubURLProtocol.recorded.first { $0.request.url?.path == "/api/office" }?.request.value(forHTTPHeaderField: "Authorization")
        XCTAssertEqual(auth, "Bearer mock-token-0123456789abcdef")
    }

    func testPairRejectsABadAddressOrEmptyCodeWithoutANetworkCall() async {
        let m = model()
        await XCTAssertThrowsErrorAsync(try await m.pair(urlText: "", code: "1"))
        await XCTAssertThrowsErrorAsync(try await m.pair(urlText: "mac.local", code: "  "))
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
        XCTAssertEqual(m.connection, .unpaired)
    }

    func testPairSurfacesTheServersRefusal() async {
        StubURLProtocol.handler = { _ in (400, Data(#"{"error":"Code expired"}"#.utf8)) }
        let tokens = MemoryTokenStore()
        let m = model(tokens: tokens)
        do {
            try await m.pair(urlText: "mac.local", code: "000000")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? WorkplaceError)?.errorDescription, "Code expired")
        }
        XCTAssertNil(tokens.token)
        XCTAssertEqual(m.connection, .unpaired)
    }

    func testUnauthorizedOnHealthStopsWithoutASocket() async {
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
        ServerConfig(baseURL: ServerConfig.parse("mac.local")!).save(defaults: defaults)
        let m = model(tokens: MemoryTokenStore(token: "stale"))
        m.start()
        await expectEventually { m.connection == .unauthorized }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(transports.isEmpty)
    }

    func testOfflineHealthStillStartsTheSocketSoItCanRecover() async {
        StubURLProtocol.handler = { _ in (503, Data(#"{"error":"starting"}"#.utf8)) }
        ServerConfig(baseURL: ServerConfig.parse("mac.local")!).save(defaults: defaults)
        let m = model(tokens: MemoryTokenStore(token: "t"))
        m.start()
        await expectEventually { if case .offline = m.connection { return true } else { return false } }
        await expectEventually { self.transports.count == 1 }
        serveFixtures()
        transports[0].open()
        transports[0].push(#"{"type":"hello","version":"0.3.0-mock","startedAt":"2026-09-27T09:00:00.000Z"}"#)
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
    }

    func testUnpairClearsEverything() async throws {
        serveFixtures()
        let tokens = MemoryTokenStore()
        let m = model(tokens: tokens)
        try await m.pair(urlText: "mac.local", code: "482913")
        await expectEventually { self.transports.count == 1 }
        m.unpair()
        XCTAssertNil(tokens.token)
        XCTAssertNil(defaults.string(forKey: ServerConfig.defaultsKey))
        XCTAssertEqual(m.connection, .unpaired)
        XCTAssertTrue(transports[0].closed)
        XCTAssertNil(m.rest)
    }

    func testEventsFanOutToStoresAndNeedsYouFollowsTheInbox() async throws {
        serveFixtures()
        let m = model()
        try await m.pair(urlText: "mac.local", code: "482913")
        await expectEventually { m.office.data != nil && m.inbox.loaded }
        var item = m.inbox.item("ib-1")!
        item.state = .answered
        m.handle(.inboxUpdated(item))
        XCTAssertEqual(m.inbox.open.count, 4)
        XCTAssertEqual(m.office.data?.needsYou, 4)
        m.handle(.alert(AlertEvent(level: .blocked, title: "Kabir is blocked", body: "", inboxId: "ib-5")))
        XCTAssertEqual(m.alerts.unread, 1)
        m.handle(.error(message: "Malformed command"))
        XCTAssertEqual(m.lastSocketError, "Malformed command")
        XCTAssertEqual(m.employeeName("mira"), "Mira")
        XCTAssertEqual(m.employeeName("nobody"), "nobody")
        XCTAssertEqual(m.charterTitle("experts"), "Experts")
    }

    func testDebugEnvironmentSkipsPairing() async {
        serveFixtures()
        let tokens = MemoryTokenStore()
        let m = model(tokens: tokens, env: ["WORKPLACE_URL": "127.0.0.1:4317", "WORKPLACE_TOKEN": "env-token"])
        m.start()
        XCTAssertTrue(m.isPaired)
        XCTAssertEqual(tokens.token, "env-token")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
    }
}

func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {}
}
