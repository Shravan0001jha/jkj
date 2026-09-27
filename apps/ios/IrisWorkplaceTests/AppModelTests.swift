import XCTest
@testable import IrisWorkplace

/// A scripted web sign-in: returns the callback URL, or throws.
final class FakeWebAuth: WebAuth {
    var callback: URL?
    var error: Error?
    private(set) var startURLs: [URL] = []

    init(token: String? = "relay-session-1") {
        callback = token.map { URL(string: "irisworkplace://auth#token=\($0)")! }
    }

    func signIn(startURL: URL) async throws -> URL {
        startURLs.append(startURL)
        if let error { throw error }
        guard let callback else { throw WebAuthError.cancelled }
        return callback
    }
}

@MainActor
final class AppModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var transports: [FakeSocketTransport] = []
    private var relay = MemoryTokenStore()
    private var lan = MemoryTokenStore()
    private var web = FakeWebAuth()

    override func setUp() {
        StubURLProtocol.reset()
        defaults = UserDefaults(suiteName: "AppModelTests")!
        defaults.removePersistentDomain(forName: "AppModelTests")
        transports = []
        relay = MemoryTokenStore()
        lan = MemoryTokenStore()
        web = FakeWebAuth()
    }

    private func model(env: [String: String] = [:], probe: TimeInterval = 0.05) -> AppModel {
        AppModel(relayTokens: relay, lanTokens: lan, defaults: defaults, notifier: FakeNotifier(),
                 urlSession: StubURLProtocol.session(),
                 makeTransport: { [unowned self] in
                     let t = FakeSocketTransport(); self.transports.append(t); return t
                 },
                 webAuth: web, env: env, offlineProbeInterval: probe)
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

    // MARK: relay (default)

    func testFreshInstallIsRelayModeAndSignedOut() {
        let m = model()
        m.start()
        XCTAssertEqual(m.mode, .relay)
        XCTAssertEqual(m.config.baseURL.absoluteString, "https://work.irisforu.com")
        XCTAssertEqual(m.connection, .signedOut)
        XCTAssertFalse(m.hasCredential)
        XCTAssertTrue(transports.isEmpty)
    }

    func testSignInStoresTheRelaySessionAndConnects() async throws {
        serveFixtures()
        let m = model()
        m.start()
        try await m.signIn()
        XCTAssertEqual(web.startURLs.map(\.absoluteString), ["https://work.irisforu.com/login?app=1"])
        XCTAssertEqual(relay.token, "relay-session-1")
        XCTAssertNil(lan.token, "the LAN store is untouched")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        await expectEventually { self.transports.count == 1 }
        XCTAssertEqual(transports[0].url?.absoluteString, "wss://work.irisforu.com/ws?token=relay-session-1")
        let auth = StubURLProtocol.recorded.first { $0.request.url?.path == "/api/health" }?.request.value(forHTTPHeaderField: "Authorization")
        XCTAssertEqual(auth, "Bearer relay-session-1")
        await expectEventually { m.office.data != nil && m.inbox.loaded }
    }

    func testHasCredentialIsObservable() async throws {
        // RootView switches on hasCredential; if it were computed from the Keychain, SwiftUI would never re-render.
        serveFixtures()
        let m = model()
        m.start()
        XCTAssertFalse(m.hasCredential)
        var fired = false
        withObservationTracking { _ = m.hasCredential } onChange: { fired = true }
        try await m.signIn()
        XCTAssertTrue(m.hasCredential)
        XCTAssertTrue(fired, "signing in must notify observers of hasCredential")
        fired = false
        withObservationTracking { _ = m.hasCredential } onChange: { fired = true }
        m.signOut()
        XCTAssertFalse(m.hasCredential)
        XCTAssertTrue(fired, "signing out must notify observers of hasCredential")
    }

    func testEnrolUsesTheEnrolPage() async throws {
        serveFixtures()
        let m = model()
        m.start()
        try await m.signIn(enrol: true)
        XCTAssertEqual(web.startURLs.map(\.absoluteString), ["https://work.irisforu.com/login/enrol?app=1"])
    }

    func testCancelledSignInLeavesNoSession() async {
        web.callback = nil
        let m = model()
        m.start()
        do {
            try await m.signIn()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? WebAuthError, .cancelled)
        }
        XCTAssertNil(relay.token)
        XCTAssertEqual(m.connection, .signedOut)
    }

    func testCallbackWithoutATokenIsRefused() async {
        web.callback = URL(string: "irisworkplace://auth?token=in-the-query")!
        let m = model()
        m.start()
        await XCTAssertThrowsErrorAsync(try await m.signIn())
        XCTAssertNil(relay.token)
    }

    func testOpenURLFallbackSignsIn() async {
        serveFixtures()
        let m = model()
        m.start()
        XCTAssertFalse(m.handleOpenURL(URL(string: "https://example.com")!))
        XCTAssertTrue(m.handleOpenURL(URL(string: "irisworkplace://auth#token=from-browser")!))
        XCTAssertEqual(relay.token, "from-browser")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
    }

    func testExpiredSessionAsksToSignInAgainAndReauthRecovers() async throws {
        relay.save(token: "stale")
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"session expired"}"#.utf8)) }
        let m = model()
        m.start()
        await expectEventually { m.connection == .unauthorized }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(transports.isEmpty, "no socket with a refused session")

        serveFixtures()
        try await m.signIn()
        XCTAssertEqual(relay.token, "relay-session-1")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        XCTAssertEqual(transports.count, 1)
    }

    func testASessionRefusedMidRunStopsTheSocket() async {
        serveFixtures()
        relay.save(token: "s")
        let m = model()
        m.start()
        await expectEventually { self.transports.count == 1 }
        transports[0].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"session expired"}"#.utf8)) }
        transports[0].drop(nil)
        await expectEventually { m.connection == .unauthorized }
        await expectEventually { self.transports[0].closed }
    }

    func testSignOutForgetsOnlyTheRelaySession() async {
        serveFixtures()
        relay.save(token: "s")
        lan.save(token: "lan-token")
        let m = model()
        m.start()
        await expectEventually { self.transports.count == 1 }
        m.signOut()
        XCTAssertNil(relay.token)
        XCTAssertEqual(lan.token, "lan-token")
        XCTAssertEqual(m.connection, .signedOut)
        XCTAssertTrue(transports[0].closed)
    }

    // MARK: Mac offline

    func testMacOfflineIsItsOwnStateAndRecoversByProbing() async {
        relay.save(token: "s")
        var offline = true
        StubURLProtocol.handler = { req in
            if offline { return (503, Data(#"{"error":"Mac offline"}"#.utf8)) }
            switch req.url!.path {
            case "/api/health": return (200, try! Fixtures.data("health"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            default: return (404, Data(#"{"error":"no route"}"#.utf8))
            }
        }
        let m = model(probe: 0.05)
        m.start()
        await expectEventually { m.connection == .macOffline }
        try? await Task.sleep(for: .milliseconds(120))
        XCTAssertTrue(transports.isEmpty, "no socket while the Mac is down; the relay would refuse it anyway")
        XCTAssertGreaterThanOrEqual(StubURLProtocol.recorded.filter { $0.request.url?.path == "/api/health" }.count, 2, "health is re-probed")

        offline = false
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        await expectEventually { self.transports.count == 1 }
        await expectEventually { m.office.data != nil }
    }

    func testMacGoingOfflineMidRunIsDetectedFromTheSocketDrop() async {
        serveFixtures()
        relay.save(token: "s")
        let m = model(probe: 0.05)
        m.start()
        await expectEventually { self.transports.count == 1 }
        transports[0].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        StubURLProtocol.handler = { _ in (502, Data("<html>Mac offline</html>".utf8)) }
        transports[0].drop(WorkplaceError.transport("reset"))
        await expectEventually { m.connection == .macOffline }
        XCTAssertTrue(transports[0].closed)
        serveFixtures()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        await expectEventually { self.transports.count == 2 }
    }

    func testNetworkFailureIsOfflineNotMacOffline() async {
        relay.save(token: "s")
        StubURLProtocol.handler = { _ in (0, Data()) }
        let m = model()
        m.start()
        await expectEventually { if case .offline = m.connection { return true } else { return false } }
        await expectEventually { self.transports.count == 1 }
    }

    // MARK: LAN pairing (developer option)

    func testPairSwitchesToLANAndKeepsTheRelaySession() async throws {
        serveFixtures()
        relay.save(token: "relay-s")
        let m = model()
        m.start()
        await expectEventually { self.transports.count == 1 }
        try await m.pair(urlText: "192.168.1.5:4317", code: " 482913 ")
        XCTAssertEqual(m.mode, .lan)
        XCTAssertEqual(lan.token, "mock-token-0123456789abcdef")
        XCTAssertEqual(relay.token, "relay-s")
        XCTAssertEqual(defaults.string(forKey: ServerConfig.lanURLKey), "http://192.168.1.5:4317")
        XCTAssertTrue(transports[0].closed, "the relay socket is closed on the switch")
        await expectEventually { self.transports.count == 2 }
        XCTAssertEqual(transports[1].url?.absoluteString, "ws://192.168.1.5:4317/ws?token=mock-token-0123456789abcdef")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
    }

    func testPairRejectsABadAddressOrEmptyCodeWithoutANetworkCall() async {
        let m = model()
        await XCTAssertThrowsErrorAsync(try await m.pair(urlText: "", code: "1"))
        await XCTAssertThrowsErrorAsync(try await m.pair(urlText: "mac.local", code: "  "))
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
        XCTAssertEqual(m.mode, .relay)
    }

    func testPairSurfacesTheServersRefusal() async {
        StubURLProtocol.handler = { _ in (400, Data(#"{"error":"Code expired"}"#.utf8)) }
        let m = model()
        do {
            try await m.pair(urlText: "mac.local", code: "000000")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? WorkplaceError)?.errorDescription, "Code expired")
        }
        XCTAssertNil(lan.token)
        XCTAssertEqual(m.mode, .relay)
    }

    func testUnpairReturnsToTheRelay() async throws {
        serveFixtures()
        let m = model()
        m.start()
        try await m.pair(urlText: "mac.local", code: "482913")
        await expectEventually { self.transports.count == 1 }
        m.unpair()
        XCTAssertNil(lan.token)
        XCTAssertNil(defaults.string(forKey: ServerConfig.lanURLKey))
        XCTAssertEqual(m.mode, .relay)
        XCTAssertEqual(m.connection, .signedOut, "no relay session yet")
        XCTAssertTrue(transports[0].closed)
    }

    func testLANTokenRefusedOffersRepair() async {
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
        ServerConfig(mode: .lan, baseURL: ServerConfig.parse("mac.local")!).save(defaults: defaults)
        lan.save(token: "stale")
        let m = model()
        m.start()
        XCTAssertEqual(m.mode, .lan)
        await expectEventually { m.connection == .unauthorized }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(transports.isEmpty)
    }

    func testSwitchBetweenSavedLANAndRelay() async throws {
        serveFixtures()
        relay.save(token: "relay-s")
        lan.save(token: "lan-t")
        ServerConfig(mode: .lan, baseURL: ServerConfig.parse("mac.local")!).save(defaults: defaults)
        ServerConfig.relay.save(defaults: defaults)   // last used: relay
        let m = model()
        m.start()
        XCTAssertEqual(m.mode, .relay)
        XCTAssertEqual(m.savedLANURL?.absoluteString, "http://mac.local:4317")
        await expectEventually { self.transports.count == 1 }
        m.useSavedLAN()
        XCTAssertEqual(m.mode, .lan)
        await expectEventually { self.transports.count == 2 }
        XCTAssertEqual(transports[1].url?.absoluteString, "ws://mac.local:4317/ws?token=lan-t")
        m.useRelay()
        XCTAssertEqual(m.mode, .relay)
        await expectEventually { self.transports.count == 3 }
        XCTAssertEqual(transports[2].url?.absoluteString, "wss://work.irisforu.com/ws?token=relay-s")
    }

    // MARK: events

    func testEventsFanOutToStoresAndNeedsYouFollowsTheInbox() async throws {
        serveFixtures()
        let m = model()
        m.start()
        try await m.signIn()
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

    func testDebugEnvironmentSkipsSignIn() async {
        serveFixtures()
        let m = model(env: ["WORKPLACE_URL": "127.0.0.1:4317", "WORKPLACE_TOKEN": "env-token"])
        m.start()
        XCTAssertEqual(m.mode, .lan)
        XCTAssertTrue(m.hasCredential)
        XCTAssertEqual(lan.token, "env-token")
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        let r = model(env: ["WORKPLACE_RELAY_URL": "127.0.0.1:4399", "WORKPLACE_TOKEN": "relay-env"])
        r.start()
        XCTAssertEqual(r.mode, .relay)
        XCTAssertEqual(r.config.loginURL.absoluteString, "http://127.0.0.1:4399/login?app=1")
    }
}

func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {}
}
