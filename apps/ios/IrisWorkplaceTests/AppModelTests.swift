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
                 webAuth: web, env: env, offlineProbeInterval: probe, pathMonitor: nil, deviceAuth: FakeDeviceAuth())
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

final class FakePathMonitor: PathMonitoring {
    var onChange: ((Bool) -> Void)?
    private(set) var started = false
    func start() { started = true }
    func stop() { started = false }
}

final class FakeDeviceAuth: DeviceAuth {
    var answer = true
    private(set) var asked: [String] = []
    func verify(reason: String) async -> Bool { asked.append(reason); return answer }
}

@MainActor
final class ReliabilityAndPushTests: XCTestCase {
    private var defaults: UserDefaults!
    private var transports: [FakeSocketTransport] = []
    private var relay = MemoryTokenStore(token: "s")
    private var path = FakePathMonitor()
    private var auth = FakeDeviceAuth()

    override func setUp() {
        StubURLProtocol.reset()
        defaults = UserDefaults(suiteName: "ReliabilityTests")!
        defaults.removePersistentDomain(forName: "ReliabilityTests")
        transports = []
        relay = MemoryTokenStore(token: "s")
        path = FakePathMonitor()
        auth = FakeDeviceAuth()
    }

    private func model() -> AppModel {
        AppModel(relayTokens: relay, lanTokens: MemoryTokenStore(), defaults: defaults, notifier: FakeNotifier(),
                 urlSession: StubURLProtocol.session(),
                 makeTransport: { [unowned self] in let t = FakeSocketTransport(); self.transports.append(t); return t },
                 webAuth: FakeWebAuth(), env: [:], offlineProbeInterval: 0.05, pathMonitor: path, deviceAuth: auth)
    }

    private func serve(relayMac: String = "online") {
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/health": return (200, try! Fixtures.data("health"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            case "/relay/health": return (200, Data(#"{"ok":true,"name":"workplace-relay","version":"0.1.0","mac":"\#(relayMac)"}"#.utf8))
            case "/api/push/register": return (200, Data(#"{"ok":true,"devices":1}"#.utf8))
            case "/api/push/unregister": return (200, Data(#"{"ok":true}"#.utf8))
            default: return (404, Data(#"{"error":"no route \#(req.url!.path)"}"#.utf8))
            }
        }
    }

    func testNetworkChangeReconnectsAtOnce() async {
        serve()
        let m = model()
        m.start()
        XCTAssertTrue(path.started)
        await expectEventually { self.transports.count == 1 }
        transports[0].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        path.onChange?(false)
        XCTAssertEqual(m.connection, .offline(reason: "No internet connection", retryAt: nil))
        path.onChange?(true)
        await expectEventually { self.transports.count == 2 }
    }

    func testASlowProbeNeverOverwritesAReconnectedSocket() async {
        // Health answers late (a lossy link); the socket reconnects first. The app must stay Online.
        let gate = AsyncGate()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/health":
                if gate.armed { gate.wait() }
                return (200, try! Fixtures.data("health"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            default: return (404, Data(#"{"error":"no"}"#.utf8))
            }
        }
        let m = model()
        m.start()
        await expectEventually { self.transports.count == 1 }
        transports[0].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        gate.armed = true
        transports[0].drop(WorkplaceError.transport("reset"))
        await expectEventually { self.transports.count == 2 }
        transports[1].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        gate.release()
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(m.connection, .online(version: "0.3.0-mock"), "the late probe must not flip a live socket back to offline")
    }

    func testCloseCode4401IsSessionGoneAnd1013IsMacOffline() async {
        serve()
        let m = model()
        m.start()
        await expectEventually { self.transports.count == 1 }
        transports[0].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        transports[0].drop(SocketClosed(code: 1013, reason: "mac offline"))
        await expectEventually { m.connection == .macOffline }
        XCTAssertTrue(transports[0].closed)
        // The relay's cheap probe says the Mac is back → reconnect.
        await expectEventually { self.transports.count == 2 }
        transports[1].open()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        transports[1].drop(SocketClosed(code: 4401, reason: "session"))
        await expectEventually { m.connection == .unauthorized }
        XCTAssertTrue(transports[1].closed)
    }

    func testRelayProbeGatesTheApiProbeWhileTheMacIsDown() async {
        var mac = "offline"
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/relay/health": return (200, Data(#"{"ok":true,"mac":"\#(mac)"}"#.utf8))
            case "/api/health": return mac == "online" ? (200, try! Fixtures.data("health")) : (503, Data(#"{"error":"The Mac is offline."}"#.utf8))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            default: return (404, Data(#"{"error":"no"}"#.utf8))
            }
        }
        let m = model()
        m.start()
        await expectEventually { m.connection == .macOffline }
        try? await Task.sleep(for: .milliseconds(200))
        let apiProbes = StubURLProtocol.recorded.filter { $0.request.url?.path == "/api/health" }.count
        let relayProbes = StubURLProtocol.recorded.filter { $0.request.url?.path == "/relay/health" }.count
        XCTAssertEqual(apiProbes, 1, "while the relay says offline, only /relay/health is polled")
        XCTAssertGreaterThanOrEqual(relayProbes, 2)
        mac = "online"
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
    }

    func testSwitchedOffIsItsOwnState() async {
        StubURLProtocol.handler = { _ in (503, Data(#"{"error":"Published access is switched off."}"#.utf8)) }
        let m = model()
        m.start()
        await expectEventually { m.connection == .accessOff }
        XCTAssertTrue(transports.isEmpty)
    }

    func testDNSFailureIsWordedAsUnreachableHost() {
        let e = URLError(.cannotFindHost)
        XCTAssertEqual(RestClient.describeTransport(e, host: "work.irisforu.com"), "Can't reach work.irisforu.com — check your connection")
        XCTAssertEqual(RestClient.describeTransport(URLError(.notConnectedToInternet), host: "x"), "No internet connection")
    }

    func testPushRegistersAfterTokenAndSignInAndUnregistersOnSignOut() async throws {
        serve()
        let m = model()
        m.start()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        XCTAssertEqual(m.pushStatusLine, "No — no device token yet")
        m.pushTokenReceived(String(repeating: "ab", count: 32))
        await expectEventually { m.pushRegistered }
        XCTAssertEqual(m.pushStatusLine, "Yes")
        let reg = StubURLProtocol.recorded.first { $0.request.url?.path == "/api/push/register" }!
        XCTAssertEqual(reg.request.value(forHTTPHeaderField: "Authorization"), "Bearer s")
        let body = try JSONSerialization.jsonObject(with: reg.body!) as! [String: Any]
        XCTAssertEqual(body["token"] as? String, String(repeating: "ab", count: 32))
        XCTAssertEqual(body["env"] as? String, "sandbox")
        XCTAssertEqual(reg.request.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("IrisWorkplace/"), true)
        m.foreground()
        await expectEventually { StubURLProtocol.recorded.filter { $0.request.url?.path == "/api/push/register" }.count >= 2 }
        m.signOut()
        await expectEventually { StubURLProtocol.recorded.contains { $0.request.url?.path == "/api/push/unregister" } }
        XCTAssertFalse(m.pushRegistered)
    }

    func testPushRegistrationFailureIsExplained() async {
        StubURLProtocol.handler = { req in
            if req.url!.path == "/api/push/register" { return (500, Data(#"{"error":"relay unconfigured"}"#.utf8)) }
            return (200, try! Fixtures.data(req.url!.path == "/api/health" ? "health" : req.url!.path == "/api/office" ? "office" : "inbox"))
        }
        let m = model()
        m.start()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        m.pushTokenReceived(String(repeating: "cd", count: 32))
        await expectEventually { m.pushProblem != nil }
        XCTAssertEqual(m.pushStatusLine, "No — relay unconfigured")
    }

    func testAnsweringAnApprovalAsksTheDeviceOwnerFirst() async throws {
        serve()
        let m = model()
        m.start()
        await expectEventually { m.inbox.loaded }
        var cleared: [String] = []
        m.clearNotification = { cleared.append($0) }
        let release = m.inbox.item("ib-1")!
        var confirmed = release; confirmed.state = .answered
        confirmed.answer = InboxAnswer(optionId: "approve", note: nil, at: "2026-09-28T00:00:00.000Z", via: .phone)
        let payload = try JSONEncoder().encode(confirmed)
        StubURLProtocol.handler = { req in req.url!.path == "/api/inbox/ib-1/answer" ? (200, payload) : (404, Data()) }
        auth.answer = false
        await XCTAssertThrowsErrorAsync(try await m.answer(item: release, option: release.options[0], note: nil))
        XCTAssertEqual(auth.asked.count, 1)
        XCTAssertEqual(m.inbox.item("ib-1")?.state, .open, "not confirmed → not sent")
        auth.answer = true
        try await m.answer(item: release, option: release.options[0], note: nil)
        XCTAssertEqual(m.inbox.item("ib-1")?.state, .answered)
        XCTAssertEqual(cleared, ["ib-1"], "the item's notification is cleared once answered")
        let decision = m.inbox.item("ib-2")!
        var d2 = decision; d2.state = .answered; d2.answer = InboxAnswer(optionId: "ptt", note: nil, at: "2026-09-28T00:00:00.000Z", via: .phone)
        let p2 = try JSONEncoder().encode(d2)
        StubURLProtocol.handler = { _ in (200, p2) }
        try await m.answer(item: decision, option: decision.options[0], note: nil)
        XCTAssertEqual(auth.asked.count, 2, "a plain decision does not ask")
    }

    func testDeepLinksRoute() {
        let m = model()
        m.open(.inbox("in_x", decide: true))
        XCTAssertEqual(m.router.tab, .inbox); XCTAssertEqual(m.router.inboxItemId, "in_x"); XCTAssertEqual(m.router.decideItemId, "in_x")
        m.open(.room("th_y"))
        XCTAssertEqual(m.router.tab, .room); XCTAssertEqual(m.router.roomThreadId, "th_y")
        m.open(.employee("dev"))
        XCTAssertEqual(m.router.tab, .talk); XCTAssertEqual(m.router.talkEmployeeId, "dev")
        XCTAssertTrue(m.handleOpenURL(URL(string: "irisworkplace://office")!))
        XCTAssertTrue(m.router.showOffice, "the Office opens over the Plan")
        // v2 update hrefs
        m.open(.item("as_1"))
        XCTAssertEqual(m.router.tab, .plan); XCTAssertEqual(m.router.itemId, "as_1")
        XCTAssertFalse(m.router.showOffice, "a jump to another screen closes the Office sheet")
        m.open(.releasePost("rp_1"))
        XCTAssertEqual(m.router.tab, .room); XCTAssertEqual(m.router.releasePostId, "rp_1")
        m.open(.updates)
        XCTAssertEqual(m.router.tab, .updates)
        m.open(.plan)
        XCTAssertEqual(m.router.tab, .plan)
    }
}

@MainActor
final class NetworkChangeTests: XCTestCase {
    func testAPathChangeWhileConnectingDoesNotConnectTwice() async {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { req in
            switch req.url!.path {
            case "/api/health": return (200, try! Fixtures.data("health"))
            case "/api/office": return (200, try! Fixtures.data("office"))
            case "/api/inbox": return (200, try! Fixtures.data("inbox"))
            default: return (404, Data(#"{"error":"no"}"#.utf8))
            }
        }
        let defaults = UserDefaults(suiteName: "NetworkChangeTests")!
        defaults.removePersistentDomain(forName: "NetworkChangeTests")
        var transports: [FakeSocketTransport] = []
        let path = FakePathMonitor()
        let m = AppModel(relayTokens: MemoryTokenStore(token: "s"), lanTokens: MemoryTokenStore(), defaults: defaults, notifier: FakeNotifier(),
                         urlSession: StubURLProtocol.session(), makeTransport: { let t = FakeSocketTransport(); transports.append(t); return t },
                         webAuth: FakeWebAuth(), env: [:], offlineProbeInterval: 0.05, pathMonitor: path, deviceAuth: FakeDeviceAuth())
        m.start()
        XCTAssertEqual(m.connection, .connecting)
        path.onChange?(true)   // NWPathMonitor reports the current path right after start()
        await expectEventually { m.connection == .online(version: "0.3.0-mock") }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(transports.count, 1, "one socket, not two")
        XCTAssertEqual(StubURLProtocol.recorded.filter { $0.request.url?.path == "/api/health" }.count, 1)
    }
}


/// Holds a URLProtocol handler until released (simulates a slow answer).
final class AsyncGate: @unchecked Sendable {
    var armed = false
    private let sem = DispatchSemaphore(value: 0)
    func wait() { _ = sem.wait(timeout: .now() + 5) }
    func release() { sem.signal() }
}
