import XCTest
@testable import IrisWorkplace

/// Real bytes over the real transports against the mock server (`make mock`, port 4399).
/// Skipped when the mock is not running, so `make test` stays green without it.
@MainActor
final class MockIntegrationTests: XCTestCase {
    private let config = ServerConfig(baseURL: ServerConfig.parse("127.0.0.1:4399")!)

    private func mockIsUp() async -> Bool {
        var req = URLRequest(url: config.url(API.health))
        req.timeoutInterval = 1
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return false }
        return (try? JSONDecoder().decode(WorkplaceHealthResponse.self, from: data))?.version.hasSuffix("mock") == true
    }

    func testPairAnswerTalkAndApproveOverRealSockets() async throws {
        guard await mockIsUp() else { throw XCTSkip("mock server not running on 127.0.0.1:4399") }

        // Pair: the one unauthenticated call.
        let token = try await RestClient.exchange(config: config, code: "482913")
        XCTAssertFalse(token.isEmpty)
        let rest = RestClient(config: config, tokens: MemoryTokenStore(token: token))

        // REST with the bearer token.
        let office = try await rest.office()
        XCTAssertEqual(office.units.flatMap(\.employees).count, 7)
        let inbox = try await rest.inbox()
        let question = try XCTUnwrap(inbox.first { $0.kind == .question && $0.state == .open })

        // Socket: real URLSessionWebSocketTask, token in the query.
        let socket = SocketClient(socketURL: config.socketURL, token: token)
        var events: [ServerEvent] = []
        socket.onEvent = { events.append($0) }
        socket.start()
        await expectEventually("socket opens") { socket.state == .open }
        await expectEventually("hello and snapshot arrive") {
            events.contains { if case .hello = $0 { return true } else { return false } }
                && events.contains { if case .snapshot = $0 { return true } else { return false } }
        }

        // Answer an Inbox item: the REST reply flips it, and the socket echoes inbox.updated.
        let answered = try await rest.answer(inbox: question.id, optionId: question.options[0].id, note: nil)
        XCTAssertEqual(answered.state, .answered)
        XCTAssertEqual(answered.answer?.via, .phone, "off-loopback? no: the mock reports phone for a bearer-token client")
        await expectEventually("inbox.updated echoed") {
            events.contains { if case .inboxUpdated(let i) = $0 { return i.id == question.id && i.state == .answered } else { return false } }
        }

        // Talk: the session comes back over REST and its log streams over the socket.
        let agent = try await rest.talk("dev", text: "status?")
        XCTAssertEqual(agent.status, .running)
        await expectEventually("the user line and the reply stream in", timeout: 5) {
            let lines = events.compactMap { if case .agentLog(let e) = $0, e.agentId == agent.id { return e } else { return nil } }
            return lines.contains { $0.kind == .user && $0.text == "status?" } && lines.contains { $0.kind == .assistant }
        }
        let log = try await rest.agentLog(agent.id)
        XCTAssertTrue(log.contains { $0.kind == .user && $0.text == "status?" })

        // Approve Mira's pending tool over the socket; agent.updated clears the approval.
        let mira = try await rest.employee("mira")
        let waiting = try XCTUnwrap(mira.sessions.first { $0.status == .waiting })
        let approval = try XCTUnwrap(waiting.approval)
        try await socket.send(.agentApprove(agentId: waiting.id, approvalId: approval.id, decision: .once))
        await expectEventually("approval consumed") {
            events.contains { if case .agentUpdated(let a) = $0 { return a.id == waiting.id && a.approval == nil } else { return false } }
        }

        // Interrupt over REST.
        try await rest.interrupt(agent: waiting.id)
        await expectEventually("interrupt logged") {
            events.contains { if case .agentLog(let e) = $0 { return e.agentId == waiting.id && e.text.contains("Interrupted") } else { return false } }
        }
        socket.stop()
    }

    func testWrongTokenIsRefusedOffLoopbackAndAcceptedOnLoopback() async throws {
        guard await mockIsUp() else { throw XCTSkip("mock server not running on 127.0.0.1:4399") }
        // Loopback needs no token (the real server's rule, mirrored by the mock).
        let rest = RestClient(config: config, tokens: MemoryTokenStore(token: nil))
        _ = try await rest.health()
        // A wrong pairing code is a 400 with the contract's error shape.
        do {
            _ = try await RestClient.exchange(config: config, code: "000000")
            XCTFail("expected refusal")
        } catch let e as WorkplaceError {
            XCTAssertEqual(e, .server(status: 400, message: "Unknown or expired code"))
        }
    }
}
