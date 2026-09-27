import XCTest
@testable import IrisWorkplace

final class RestClientTests: XCTestCase {
    private let config = ServerConfig(baseURL: ServerConfig.parse("192.168.1.5:4317")!)

    override func setUp() { StubURLProtocol.reset() }

    private func client(token: String? = "tok-123") -> RestClient {
        RestClient(config: config, tokens: MemoryTokenStore(token: token), session: StubURLProtocol.session())
    }

    func testBearerTokenOnEveryCall() async throws {
        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("office")) }
        _ = try await client().office()
        let req = StubURLProtocol.recorded.first!.request
        XCTAssertEqual(req.url?.absoluteString, "http://192.168.1.5:4317/api/office")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok-123")
        XCTAssertEqual(req.httpMethod, "GET")
    }

    func testPostSendsJSONBodyWithTheContractShape() async throws {
        StubURLProtocol.handler = { _ in (200, try! JSONEncoder().encode(try! Fixtures.decode("inbox", as: [InboxItem].self)[0])) }
        _ = try await client().answer(inbox: "ib-1", optionId: "reject", note: "not yet")
        let r = StubURLProtocol.recorded.first!
        XCTAssertEqual(r.request.url?.path, "/api/inbox/ib-1/answer")
        XCTAssertEqual(r.request.httpMethod, "POST")
        XCTAssertEqual(r.request.value(forHTTPHeaderField: "content-type"), "application/json")
        let body = try JSONSerialization.jsonObject(with: r.body!) as! [String: Any]
        XCTAssertEqual(body["optionId"] as? String, "reject")
        XCTAssertEqual(body["note"] as? String, "not yet")
    }

    func testTalkBodyOmitsNilAttachments() async throws {
        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("agent")) }
        let agent = try await client().talk("mira", text: "status?")
        XCTAssertEqual(agent.id, "s-mira-1")
        let body = try JSONSerialization.jsonObject(with: StubURLProtocol.recorded.first!.body!) as! [String: Any]
        XCTAssertEqual(body as NSDictionary, ["text": "status?"] as NSDictionary)
    }

    func testServerErrorShapeBecomesAMessage() async {
        StubURLProtocol.handler = { _ in (409, Data(#"{"error":"Already answered"}"#.utf8)) }
        do {
            _ = try await client().answer(inbox: "ib-1", optionId: "approve", note: nil)
            XCTFail("expected an error")
        } catch let e as WorkplaceError {
            XCTAssertEqual(e, .server(status: 409, message: "Already answered"))
            XCTAssertEqual(e.errorDescription, "Already answered")
        } catch { XCTFail("\(error)") }
    }

    func test401IsUnauthorized() async {
        StubURLProtocol.handler = { _ in (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
        do {
            _ = try await client().health()
            XCTFail("expected an error")
        } catch let e as WorkplaceError {
            XCTAssertEqual(e, .unauthorized)
        } catch { XCTFail("\(error)") }
    }

    func testNonContractBodyIsADecodingErrorNamingTheField() async {
        StubURLProtocol.handler = { _ in (200, Data(#"{"units":[],"coverage":{"total":1},"needsYou":0,"spend":{},"lintErrors":0}"#.utf8)) }
        do {
            _ = try await client().office()
            XCTFail("expected an error")
        } catch let e as WorkplaceError {
            guard case .decoding(let d) = e else { return XCTFail("\(e)") }
            XCTAssertTrue(d.contains("coverage.owned"), d)
        } catch { XCTFail("\(error)") }
    }

    func testNoTokenSendsNoAuthorizationHeader() async throws {
        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("health")) }
        _ = try await client(token: nil).health()
        XCTAssertNil(StubURLProtocol.recorded.first!.request.value(forHTTPHeaderField: "Authorization"))
    }

    func testPairExchangeIsUnauthenticatedAndReturnsTheToken() async throws {
        StubURLProtocol.handler = { _ in (200, try! Fixtures.data("pair-exchange")) }
        let token = try await RestClient.exchange(config: config, code: "482913", session: StubURLProtocol.session())
        XCTAssertEqual(token, "mock-token-0123456789abcdef")
        let r = StubURLProtocol.recorded.first!
        XCTAssertEqual(r.request.url?.path, "/api/pair/exchange")
        XCTAssertNil(r.request.value(forHTTPHeaderField: "Authorization"))
        let body = try JSONSerialization.jsonObject(with: r.body!) as! [String: Any]
        XCTAssertEqual(body as NSDictionary, ["code": "482913"] as NSDictionary)
    }

    func testEndpointsHitTheContractPaths() async throws {
        StubURLProtocol.handler = { req in
            let p = req.url!.path
            let q = req.url!.query ?? ""
            switch (p, q) {
            case ("/api/employees/mira", _): return (200, try! Fixtures.data("employee-detail"))
            case ("/api/agents/s-mira-1/log", _): return (200, try! Fixtures.data("agent-log"))
            case ("/api/charters/experts", _): return (200, try! Fixtures.data("charter"))
            case ("/api/features", _): return (200, try! Fixtures.data("features"))
            case ("/api/features/f-errands", _): return (200, try! Fixtures.data("feature-detail"))
            case ("/api/features/pivot", "rows=platform"): return (200, try! Fixtures.data("pivot-platform"))
            case ("/api/agents/s-mira-1/interrupt", _): return (200, Data(#"{"ok":true}"#.utf8))
            case ("/api/employees/mira/end-session", _): return (200, Data(#"{"ok":true}"#.utf8))
            case ("/api/spend", "day=2026-09-27"): return (200, try! Fixtures.data("spend"))
            case ("/api/inbox", _): return (200, try! Fixtures.data("inbox"))
            case ("/api/employees", _): return (200, try! Fixtures.data("employees"))
            default: return (404, Data(#"{"error":"no route \#(p)?\#(q)"}"#.utf8))
            }
        }
        let c = client()
        let employee = try await c.employee("mira")
        XCTAssertEqual(employee.employee.name, "Mira")
        let log = try await c.agentLog("s-mira-1")
        XCTAssertEqual(log.count, 7)
        let charter = try await c.charter("experts")
        XCTAssertEqual(charter.rules.count, 3)
        let board = try await c.features()
        XCTAssertEqual(board.features.count, 6)
        let detail = try await c.feature("f-errands")
        XCTAssertEqual(detail.assignments.count, 5)
        let pivot = try await c.pivot(.platform)
        XCTAssertEqual(pivot.rows.first, "mac")
        try await c.interrupt(agent: "s-mira-1")
        try await c.endSession("mira")
        let spend = try await c.spend(day: "2026-09-27")
        XCTAssertEqual(spend.capInr, 1000)
        let inbox = try await c.inbox()
        XCTAssertEqual(inbox.count, 7)
        let employees = try await c.employees()
        XCTAssertEqual(employees.count, 7)
    }
}
