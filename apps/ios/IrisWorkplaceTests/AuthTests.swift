import XCTest
@testable import IrisWorkplace

/// The relay sign-in callback and the two server modes.
final class AuthCallbackTests: XCTestCase {
    func testTokenComesFromTheFragment() {
        XCTAssertEqual(AuthCallback.parse(URL(string: "irisworkplace://auth#token=abc123")!), "abc123")
        XCTAssertEqual(AuthCallback.parse(URL(string: "irisworkplace://auth#token=abc&expires=7d")!), "abc")
        XCTAssertEqual(AuthCallback.parse(URL(string: "irisworkplace://auth#expires=7d&token=abc")!), "abc")
        XCTAssertEqual(AuthCallback.parse(URL(string: "IrisWorkplace://AUTH#token=abc")!), "abc", "scheme and host are case-insensitive")
        XCTAssertEqual(AuthCallback.parse(URL(string: "irisworkplace://auth/#token=abc")!), "abc")
        XCTAssertEqual(AuthCallback.parse(URL(string: "irisworkplace://auth#token=a%2Fb%3Dc")!), "a/b=c", "percent-decoded")
    }

    func testAnythingElseIsRejected() {
        XCTAssertNil(AuthCallback.parse(URL(string: "irisworkplace://auth?token=abc")!), "the query is not the fragment")
        XCTAssertNil(AuthCallback.parse(URL(string: "irisworkplace://auth#tok=abc")!))
        XCTAssertNil(AuthCallback.parse(URL(string: "irisworkplace://auth#token=")!))
        XCTAssertNil(AuthCallback.parse(URL(string: "irisworkplace://auth")!))
        XCTAssertNil(AuthCallback.parse(URL(string: "irisworkplace://other#token=abc")!))
        XCTAssertNil(AuthCallback.parse(URL(string: "https://work.irisforu.com/auth#token=abc")!), "only our scheme")
        XCTAssertNil(AuthCallback.parse(URL(string: "iris://auth#token=abc")!))
    }

    func testLoginAndEnrolURLs() {
        let relay = ServerConfig.relay
        XCTAssertEqual(relay.mode, .relay)
        XCTAssertEqual(relay.baseURL.absoluteString, "https://work.irisforu.com")
        XCTAssertEqual(relay.loginURL.absoluteString, "https://work.irisforu.com/login?app=1")
        XCTAssertEqual(relay.enrolURL.absoluteString, "https://work.irisforu.com/login/enrol?app=1")
        XCTAssertEqual(relay.socketURL.absoluteString, "wss://work.irisforu.com/ws")
        XCTAssertEqual(relay.url(API.office).absoluteString, "https://work.irisforu.com/api/office")
    }

    func testModePersistenceKeepsBothAddresses() {
        let d = UserDefaults(suiteName: "AuthModeTests")!
        d.removePersistentDomain(forName: "AuthModeTests")
        XCTAssertEqual(ServerConfig.load(defaults: d, env: [:]), .relay, "a fresh install is in relay mode")

        ServerConfig(mode: .lan, baseURL: ServerConfig.parse("10.0.0.2:4317")!).save(defaults: d)
        XCTAssertEqual(ServerConfig.load(defaults: d, env: [:]).mode, .lan)
        XCTAssertEqual(ServerConfig.savedLAN(defaults: d)?.absoluteString, "http://10.0.0.2:4317")

        ServerConfig.relay.save(defaults: d)
        XCTAssertEqual(ServerConfig.load(defaults: d, env: [:]).mode, .relay)
        XCTAssertEqual(ServerConfig.savedLAN(defaults: d)?.absoluteString, "http://10.0.0.2:4317", "switching to the relay keeps the LAN address")

        ServerConfig(mode: .lan, baseURL: ServerConfig.parse("10.0.0.2:4317")!).save(defaults: d)
        ServerConfig.forgetLAN(defaults: d)
        XCTAssertNil(ServerConfig.savedLAN(defaults: d))
        XCTAssertEqual(ServerConfig.load(defaults: d, env: [:]).mode, .relay, "forgetting the LAN falls back to the relay")
    }

    func testDebugEnvironmentPicksTheMode() {
        let d = UserDefaults(suiteName: "AuthModeTests2")!
        d.removePersistentDomain(forName: "AuthModeTests2")
        let lan = ServerConfig.load(defaults: d, env: ["WORKPLACE_URL": "127.0.0.1:4317"])
        XCTAssertEqual(lan.mode, .lan)
        let relay = ServerConfig.load(defaults: d, env: ["WORKPLACE_RELAY_URL": "127.0.0.1:4399"])
        XCTAssertEqual(relay.mode, .relay)
        XCTAssertEqual(relay.loginURL.absoluteString, "http://127.0.0.1:4399/login?app=1")
    }
}

final class MacOfflineDetectionTests: XCTestCase {
    func testGatewayStatusesAreMacOffline() {
        XCTAssertTrue(RestClient.isMacOffline(status: 502, body: Data()))
        XCTAssertTrue(RestClient.isMacOffline(status: 503, body: Data(#"{"error":"Mac offline"}"#.utf8)))
        XCTAssertTrue(RestClient.isMacOffline(status: 504, body: Data("<html>gateway timeout</html>".utf8)))
    }

    func testAnErrorBodyThatSaysOfflineIsMacOffline() {
        XCTAssertTrue(RestClient.isMacOffline(status: 500, body: Data(#"{"error":"Mac offline"}"#.utf8)))
        XCTAssertTrue(RestClient.isMacOffline(status: 409, body: Data("<html><h1>Your Mac is offline</h1></html>".utf8)))
    }

    func testOrdinaryErrorsAreNot() {
        XCTAssertFalse(RestClient.isMacOffline(status: 200, body: Data("mac offline".utf8)), "a success body is data, not a state")
        XCTAssertFalse(RestClient.isMacOffline(status: 404, body: Data(#"{"error":"no such item"}"#.utf8)))
        XCTAssertFalse(RestClient.isMacOffline(status: 500, body: Data(#"{"error":"boom"}"#.utf8)))
        XCTAssertFalse(RestClient.isMacOffline(status: 401, body: Data(#"{"error":"unauthorized"}"#.utf8)))
    }

    func testRestClientThrowsMacOffline() async {
        StubURLProtocol.reset()
        StubURLProtocol.handler = { _ in (503, Data("<html>Mac offline</html>".utf8)) }
        let c = RestClient(config: .relay, tokens: MemoryTokenStore(token: "s"), session: StubURLProtocol.session())
        do {
            _ = try await c.office()
            XCTFail("expected an error")
        } catch let e as WorkplaceError {
            XCTAssertEqual(e, .macOffline)
            XCTAssertEqual(e.errorDescription, "Your Mac is offline — Workplace unavailable.")
        } catch { XCTFail("\(error)") }
    }
}
